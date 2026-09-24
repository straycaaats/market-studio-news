import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sources = [
  { name: '総務省統計局', type: 'STATISTICS', url: 'https://www.stat.go.jp/whatsnew/news.rdf', method: '公式RSS', status: 'VERIFIED', domains: ['www.stat.go.jp'] },
  { name: '日本銀行', type: 'CENTRAL_BANK', url: 'https://www.boj.or.jp/rss/whatsnew.xml', method: '公式RSS', status: 'VERIFIED', domains: ['www.boj.or.jp'] },
];

const memoryPath = new URL('./data/news-memory.json', import.meta.url);
const outputPath = new URL('./public/news-program.json', import.meta.url);
const statusPath = new URL('./public/status.json', import.meta.url);
const jst = value => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(x => [x.type, x.value]));
const jstDate = value => { const p = jst(value); return `${p.year}-${p.month}-${p.day}`; };
const decode = value => String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const field = (item, tag) => decode(item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '');
const keyOf = (source, url) => crypto.createHash('sha256').update(`${source}\n${url}`).digest('hex');
const clip = (text, n = 500) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function parseRss(xml, source, seenAt) {
  const result = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const item = match[1], title = field(item, 'title'), rawUrl = field(item, 'link');
    if (!title || !rawUrl) continue;
    const url = new URL(rawUrl, source.url).href.replace(/^http:\/\//, 'https://');
    const rawTime = field(item, 'dc:date') || field(item, 'pubDate'), exact = /\d{1,2}:\d{2}/.test(rawTime);
    const publishedAt = rawTime && Number.isFinite(Date.parse(rawTime)) ? (exact ? new Date(rawTime).toISOString() : rawTime) : null;
    result.push({ id: keyOf(source.name, url), source: source.name, sourceType: source.type, title, url, publishedAt, firstSeenAt: seenAt, fetchedAt: seenAt, timestampQuality: exact ? 'SOURCE_REPORTED' : 'DATE_ONLY_OR_UNKNOWN', contentStatus: 'NOT_FETCHED', contentSnippet: null, contentFetchedAt: null });
  }
  return result;
}

function extractOfficialText(html) {
  const cleaned = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<header[\s\S]*?<\/header>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  const main = cleaned.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/i)?.[1] || cleaned.match(/<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/i)?.[1] || cleaned;
  return clip(decode(main), 1600);
}

async function fetchOfficialBody(item, source, fetchImpl, fetchedAt) {
  const url = new URL(item.url);
  if (!source.domains.includes(url.hostname)) return { contentStatus: 'DOMAIN_NOT_ALLOWED', contentSnippet: null, contentFetchedAt: fetchedAt };
  if (/\.(pdf|xlsx?|csv|zip)(?:$|\?)/i.test(url.pathname)) return { contentStatus: 'UNSUPPORTED_DOCUMENT', contentSnippet: null, contentFetchedAt: fetchedAt };
  try {
    const response = await fetchImpl(item.url, { headers: { 'user-agent': 'MarketStudioNews/2.0 (official-source reader)' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers?.get?.('content-type') || '';
    if (type && !/html|text/i.test(type)) return { contentStatus: 'UNSUPPORTED_DOCUMENT', contentSnippet: null, contentFetchedAt: fetchedAt };
    let raw;
    if (response.arrayBuffer) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const probe = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      const charset = type.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || probe.match(/charset\s*=\s*["']?([^;"'\s/>]+)/i)?.[1] || 'utf-8';
      try { raw = new TextDecoder(charset).decode(bytes); } catch { raw = new TextDecoder('utf-8').decode(bytes); }
    } else raw = await response.text();
    const text = extractOfficialText(raw), broken = (text.match(/�/g) || []).length > Math.max(2, text.length * 0.01);
    if (broken) return { contentStatus: 'DECODE_FAILED', contentSnippet: null, contentFetchedAt: fetchedAt };
    return text.length >= 80 ? { contentStatus: 'VERIFIED_TEXT', contentSnippet: text, contentFetchedAt: fetchedAt } : { contentStatus: 'INSUFFICIENT_TEXT', contentSnippet: null, contentFetchedAt: fetchedAt };
  } catch (error) { return { contentStatus: 'FETCH_FAILED', contentSnippet: null, contentFetchedAt: fetchedAt, contentError: clip(error.message, 160) }; }
}

function category(item) {
  const text = `${item.title} ${item.contentSnippet || ''}`;
  if (/金融|金利|為替|国債|政策委員会|市場調節|資金供給/.test(text)) return '金融政策・市場';
  if (/物価|消費者物価|企業物価|価格指数/.test(text)) return '物価・金利';
  if (/雇用|労働|家計|人口|消費/.test(text)) return '暮らし・消費';
  if (/GDP|景気|産業|貿易|設備投資|法人企業|サービス産業/.test(text)) return '景気・企業';
  return '政策・公式発表';
}

function relatedThemes(item) {
  const text = `${item.title} ${item.contentSnippet || ''}`, themes = [];
  const rules = [['銀行・保険', /金融|金利|銀行|貸出/], ['不動産', /金利|住宅|地価/], ['小売・消費', /物価|家計|消費|小売/], ['輸出・製造業', /為替|輸出|貿易|鉱工業/], ['サービス業', /サービス産業/], ['雇用', /雇用|労働|賃金/], ['国債・円相場', /国債|金融政策|為替|市場調節/]];
  for (const [name, re] of rules) if (re.test(text)) themes.push(name);
  return themes.slice(0, 3);
}

export function importance(item, edition) {
  const text = `${item.title} ${item.contentSnippet || ''}`; let score = 0;
  if (/金融政策|金利|消費者物価|GDP|雇用|労働力|家計|貿易|為替|企業物価|サービス産業/.test(text)) score += 5;
  if (/結果|速報|変更|改正|決定|見通し|記者会見/.test(text)) score += 2;
  if (/動画|開催|シンポジウム|採用|入札予定|銘柄別残高|営業毎旬/.test(text)) score -= 4;
  if (/ディスカッション・ペーパー|研究所|ニュースレター|定例市場報告|時系列データ|ハンドブック|Handbook/.test(text)) score -= 6;
  if (item.contentStatus === 'VERIFIED_TEXT') score += 3;
  if (edition === 'MORNING' && /海外|為替|金利|政策|物価/.test(text)) score += 1;
  if (edition === 'EVENING' && /結果|決定|発表|会見|企業/.test(text)) score += 1;
  return score;
}

export function factualSummary(item) {
  if (item.contentStatus !== 'VERIFIED_TEXT') return null;
  const body = item.contentSnippet, sentences = body.split(/(?<=[。！？])\s*/).map(x => clip(x, 180)).filter(x => x.length >= 20);
  const useful = sentences.filter(x => /前年比|前月比|増加|減少|上昇|低下|改正|変更|決定|見通し|[0-9][.,0-9]*\s*(?:％|%|兆円|億円|万人|ポイント)/.test(x) && !/閲覧|ダウンロード|掲載の統計表/.test(x)).sort((a,b)=>Number(/前年比|前月比|増加|減少|上昇|低下|改正|変更|決定/.test(b))-Number(/前年比|前月比|増加|減少|上昇|低下|改正|変更|決定/.test(a)));
  const picked = (useful[0] || '').replace(/^.*?本文へ\s*/, '');
  if (!picked) return null;
  return { whatHappened: clip(item.title, 90), whatChanged: clip(picked, 150), relatedThemes: relatedThemes(item) };
}

async function geminiEditorial(items, edition, now, fetchImpl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !items.length) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const prompt = `あなたは市場観測ニュースの編集者です。公式情報だけを根拠に、${edition === 'MORNING' ? '朝7時版「今日見る材料」' : '18時版「今日の振り返り」'}を作ります。株価予想・売買推奨は禁止。本文にない数値や因果関係を補完しない。各候補を0～100で重要度評価し、読む価値が低いものはadopt=false。採用は最大6件、少なければ2～3件でよい。whatHappened、whatChanged、relatedThemesを短い日本語で返す。contentStatusがVERIFIED_TEXTでない場合、見出し以上の説明は禁止。JSON配列のみ。基準時刻=${now.toISOString()}\n${JSON.stringify(items.map(x => ({ id:x.id, source:x.source, title:x.title, publishedAt:x.publishedAt, firstSeenAt:x.firstSeenAt, contentStatus:x.contentStatus, officialText:x.contentSnippet })))}`;
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{responseMimeType:'application/json',temperature:0.1} }) });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const text = (await response.json()).candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = JSON.parse(text);
  return new Map(parsed.filter(x => x?.id).map(x => [x.id, x]));
}

export async function run({ now = new Date(), fetchImpl = fetch, write = true } = {}) {
  if (write) { await fs.mkdir(new URL('./data/', import.meta.url), { recursive:true }); await fs.mkdir(new URL('./public/', import.meta.url), { recursive:true }); }
  let memory = { version:2, items:[], fetches:[] };
  try { memory = JSON.parse(await fs.readFile(memoryPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const byId = new Map(memory.items.map(item => [item.id, item])), sourceResults = [];
  for (const source of sources) {
    const fetchedAt = now.toISOString();
    try {
      const response = await fetchImpl(source.url, { headers:{'user-agent':'MarketStudioNews/2.0 (official RSS research)'} });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseRss(await response.text(), source, fetchedAt); let added = 0;
      for (const fresh of parsed) {
        const existing = byId.get(fresh.id), item = existing ? { ...existing, fetchedAt } : fresh;
        if (!existing) added++;
        if (!item.contentFetchedAt || ['FETCH_FAILED','DECODE_FAILED'].includes(item.contentStatus) || (item.contentSnippet && /�{3,}/.test(item.contentSnippet))) Object.assign(item, await fetchOfficialBody(item, source, fetchImpl, fetchedAt));
        byId.set(item.id, item);
      }
      sourceResults.push({ source:source.name, status:'FETCHED', read:parsed.length, added, fetchedAt });
    } catch (error) { sourceResults.push({ source:source.name, status:'FAILED', read:0, added:0, fetchedAt, error:clip(error.message,160) }); }
  }
  const items = [...byId.values()].sort((a,b) => String(b.publishedAt || b.firstSeenAt).localeCompare(String(a.publishedAt || a.firstSeenAt))).slice(0,5000);
  const p = jst(now), edition = Number(p.hour) < 12 ? 'MORNING' : 'EVENING', lookbackHours = edition === 'MORNING' ? 18 : 12, cutoff = now.getTime() - lookbackHours * 3600_000;
  const cutoffDate=jstDate(new Date(cutoff));
  const candidates = items.filter(x => { if(x.timestampQuality==='SOURCE_REPORTED'){const t=Date.parse(x.publishedAt);return Number.isFinite(t)&&t>=cutoff;}return Boolean(x.publishedAt)&&String(x.publishedAt).slice(0,10)>=cutoffDate; }).map(x => ({ ...x, editorialScore:importance(x,edition) })).filter(x => x.editorialScore >= 5 && (x.contentStatus === 'VERIFIED_TEXT' || /変更|改正|決定|前年比|前月比|[+\-]?\d+(?:\.\d+)?[%％]/.test(x.title))).sort((a,b) => b.editorialScore-a.editorialScore || String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0,12);
  let ai = null, summaryMode = 'RULE_BASED_VERIFIED_TEXT';
  try { ai = await geminiEditorial(candidates, edition, now, fetchImpl); if (ai) summaryMode = 'GEMINI_GROUNDED_EDITORIAL'; } catch (error) { summaryMode = `RULE_BASED_AFTER_GEMINI_FAILURE:${clip(error.message,80)}`; }
  const cards = [];
  for (const item of candidates) {
    const edited = ai?.get(item.id), rule = factualSummary(item);
    if (edited && edited.adopt === false) continue;
    const whatHappened = clip(edited?.whatHappened || rule?.whatHappened, 100), whatChanged = clip(edited?.whatChanged || rule?.whatChanged, 170);
    if (!whatHappened || !whatChanged) continue;
    cards.push({ id:item.id, category:category(item), title:whatHappened, summary:whatChanged, whatHappened, whatChanged, relatedThemes:(edited?.relatedThemes || rule?.relatedThemes || relatedThemes(item)).slice(0,3), status:jstDate(new Date(item.firstSeenAt))===jstDate(now)?'NEW':'FOLLOW_UP', source:item.source, publishedAt:item.publishedAt, firstSeenAt:item.firstSeenAt, contentStatus:item.contentStatus, links:[{title:item.title,url:item.url,source:item.source}] });
    if (cards.length >= 6) break;
  }
  const heading = edition === 'MORNING' ? '今日見る材料' : '今日の振り返り';
  const today = jstDate(now), newToday = items.filter(x => jstDate(new Date(x.firstSeenAt)) === today).length;
  const program = { generatedAt:now.toISOString(), asOf:today, edition, heading, counts:{ fetchedToday:newToday, newsMemoryTotal:items.length, considered:candidates.length, adoptedCards:cards.length, failedSources:sourceResults.filter(x=>x.status==='FAILED').length }, sourceResults, sourceAudit:sources.map(({name,url,method,status})=>({formalName:name,url,method,status})), summaryMode, cards, summary:cards.slice(0,3).map(x=>x.summary), qualityNote:'NEWS MEMORYへの保存と表示用編集を分離。公式本文を確認できない情報は、見出し以上に補完しない。株価予想・売買推奨は行わない。' };
  memory = { version:2, updatedAt:now.toISOString(), items, fetches:[...(memory.fetches||[]),...sourceResults].slice(-400) };
  if (write) { await fs.writeFile(memoryPath,`${JSON.stringify(memory,null,2)}\n`); await fs.writeFile(outputPath,`${JSON.stringify(program,null,2)}\n`); await fs.writeFile(statusPath,`${JSON.stringify({ok:sourceResults.some(x=>x.status==='FETCHED'),generatedAt:program.generatedAt,asOf:today,edition,sourceResults,counts:program.counts},null,2)}\n`); }
  console.log(JSON.stringify({asOf:today,edition,summaryMode,...program.counts,sourceResults}));
  if (sourceResults.every(x=>x.status==='FAILED')) process.exitCode=1;
  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await run();
