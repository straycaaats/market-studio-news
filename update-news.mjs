import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sources = [
  { name: '総務省統計局', type: 'STATISTICS', url: 'https://www.stat.go.jp/whatsnew/news.rdf', method: '公式RSS', status: 'VERIFIED' },
  { name: '日本銀行', type: 'CENTRAL_BANK', url: 'https://www.boj.or.jp/rss/whatsnew.xml', method: '公式RSS', status: 'VERIFIED' },
];

const memoryPath = new URL('./data/news-memory.json', import.meta.url);
const outputPath = new URL('./public/news-program.json', import.meta.url);
const statusPath = new URL('./public/status.json', import.meta.url);
const jstDate = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const decode = value => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/<[^>]+>/g, '').trim();
const field = (item, tag) => decode(item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '');
const keyOf = (source, url) => crypto.createHash('sha256').update(`${source}\n${url}`).digest('hex');

export function parseRss(xml, source, seenAt) {
  const result = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const item = match[1];
    const title = field(item, 'title');
    const rawUrl = field(item, 'link');
    if (!title || !rawUrl) continue;
    const url = new URL(rawUrl, source.url).href.replace(/^http:\/\//, 'https://');
    const rawTime = field(item, 'dc:date') || field(item, 'pubDate');
    const exact = /\d{1,2}:\d{2}/.test(rawTime);
    const publishedAt = rawTime && Number.isFinite(Date.parse(rawTime)) ? (exact ? new Date(rawTime).toISOString() : rawTime) : null;
    result.push({ id: keyOf(source.name, url), source: source.name, sourceType: source.type, title, url, publishedAt, firstSeenAt: seenAt, fetchedAt: seenAt, timestampQuality: exact ? 'SOURCE_REPORTED' : 'DATE_ONLY_OR_UNKNOWN' });
  }
  return result;
}

function category(item) {
  if (/金融|金利|為替|国債|政策委員会|市場調節/.test(item.title)) return '金融政策・市場';
  if (/物価|消費者物価|企業物価/.test(item.title)) return '物価';
  if (/雇用|労働|家計|人口/.test(item.title)) return '暮らし・雇用';
  if (/GDP|景気|産業|貿易|設備投資|法人企業/.test(item.title)) return '景気・企業';
  return '公式発表';
}

function compactSummary(item) {
  const timeNote = item.timestampQuality === 'SOURCE_REPORTED' ? '公開時刻を確認済みです。' : '公開日は確認済みですが、正確な時刻は未確認です。';
  return `${item.source}の公式発表です。${timeNote}`;
}

async function geminiSummaries(items) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !items.length) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const prompt = `次の公式発表の見出しだけを根拠に、日本の株式市場を初めて見る人向けに各項目を日本語45文字以内で要約してください。見出しにない数値・因果関係・株価予想を追加しないでください。JSON配列のみ返してください。\n${JSON.stringify(items.map(({ id, source, title }) => ({ id, source, title })))}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }) });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = JSON.parse(text);
  return new Map(parsed.filter(x => x?.id && x?.summary).map(x => [x.id, String(x.summary).slice(0, 100)]));
}

export async function run({ now = new Date(), fetchImpl = fetch } = {}) {
  await fs.mkdir(new URL('./data/', import.meta.url), { recursive: true });
  await fs.mkdir(new URL('./public/', import.meta.url), { recursive: true });
  let memory = { version: 1, items: [], fetches: [] };
  try { memory = JSON.parse(await fs.readFile(memoryPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const byId = new Map(memory.items.map(item => [item.id, item]));
  const sourceResults = [];
  for (const source of sources) {
    const fetchedAt = now.toISOString();
    try {
      const response = await fetchImpl(source.url, { headers: { 'user-agent': 'MarketStudioNews/1.0 (official RSS research)' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseRss(await response.text(), source, fetchedAt);
      let added = 0;
      for (const item of parsed) {
        const existing = byId.get(item.id);
        if (existing) existing.fetchedAt = fetchedAt;
        else { byId.set(item.id, item); added++; }
      }
      sourceResults.push({ source: source.name, status: 'FETCHED', read: parsed.length, added, fetchedAt });
    } catch (error) {
      sourceResults.push({ source: source.name, status: 'FAILED', read: 0, added: 0, fetchedAt, error: String(error.message) });
    }
  }
  const items = [...byId.values()].sort((a, b) => String(b.publishedAt || b.firstSeenAt).localeCompare(String(a.publishedAt || a.firstSeenAt))).slice(0, 5000);
  const today = jstDate(now);
  const recent = items.filter(item => Date.parse(item.publishedAt || item.firstSeenAt) >= now.getTime() - 72 * 3600_000);
  const topical = recent.filter(item => /金融|金利|為替|物価|雇用|景気|GDP|政策|産業|貿易|企業|株|市場|設備投資|人口|家計/.test(item.title));
  const chosen = [];
  const seenCategories = new Set();
  for (const item of topical) {
    const key = category(item);
    if (seenCategories.has(key) && chosen.length >= 4) continue;
    chosen.push(item); seenCategories.add(key);
    if (chosen.length >= 6) break;
  }
  let summaries = null;
  let summaryMode = 'OFFICIAL_TITLE_FALLBACK';
  try { summaries = await geminiSummaries(chosen); if (summaries) summaryMode = 'GEMINI_GROUNDED'; } catch (error) { summaryMode = `GEMINI_FAILED:${error.message}`; }
  const newToday = items.filter(item => jstDate(new Date(item.firstSeenAt)) === today).length;
  const cards = [{ id: 'overview', category: '今日の全体像', title: newToday ? `公式情報を${newToday}件確認` : '新しい公式情報は未確認', summary: newToday ? '休場日を含め、公式情報を毎日確認しています。' : '前回までの記録を引き継いでいます。', status: 'FACT', source: 'NEWS MEMORY', publishedAt: null, firstSeenAt: now.toISOString(), links: [] }];
  for (const item of chosen) cards.push({ id: item.id, category: category(item), title: item.title, summary: summaries?.get(item.id) || compactSummary(item), status: jstDate(new Date(item.firstSeenAt)) === today ? 'NEW' : 'FOLLOW_UP', source: item.source, publishedAt: item.publishedAt, firstSeenAt: item.firstSeenAt, links: [{ title: item.title, url: item.url, source: item.source }], related: [] });
  const program = { generatedAt: now.toISOString(), asOf: today, counts: { fetchedToday: newToday, newsMemoryTotal: items.length, adoptedCards: cards.length, failedSources: sourceResults.filter(x => x.status === 'FAILED').length }, sourceResults, sourceAudit: sources.map(({ name, url, method, status }) => ({ formalName: name, url, method, status })), summaryMode, cards, summary: cards.slice(1, 4).map(card => card.title), qualityNote: '公式RSSの見出しと時刻だけを根拠に生成。株価への影響や売買判断は示さない。' };
  memory = { version: 1, updatedAt: now.toISOString(), items, fetches: [...(memory.fetches || []), ...sourceResults].slice(-400) };
  await fs.writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);
  await fs.writeFile(outputPath, `${JSON.stringify(program, null, 2)}\n`);
  await fs.writeFile(statusPath, `${JSON.stringify({ ok: sourceResults.some(x => x.status === 'FETCHED'), generatedAt: program.generatedAt, asOf: today, sourceResults, counts: program.counts }, null, 2)}\n`);
  console.log(JSON.stringify({ asOf: today, summaryMode, ...program.counts, sourceResults }));
  if (sourceResults.every(x => x.status === 'FAILED')) process.exitCode = 1;
  return program;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await run();
