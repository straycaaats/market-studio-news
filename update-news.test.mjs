import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, sources, factualSummary, importance } from './update-news.mjs';

test('RSSの公開時刻と初回確認時刻を分離する', () => {
  const xml = '<rss><channel><item><title>政策発表</title><link>https://example.com/a</link><pubDate>Wed, 23 Sep 2026 23:00:00 GMT</pubDate></item></channel></rss>';
  const rows = parseRss(xml, sources[0], '2026-09-24T00:10:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishedAt, '2026-09-23T23:00:00.000Z');
  assert.equal(rows[0].firstSeenAt, '2026-09-24T00:10:00.000Z');
  assert.equal(rows[0].contentStatus, 'NOT_FETCHED');
});

test('本文未確認なら説明を推測しない', () => {
  assert.equal(factualSummary({ title: '消費者物価指数', contentStatus: 'UNSUPPORTED_DOCUMENT', contentSnippet: null }), null);
});

test('確認済み本文から具体的変化と関連テーマを作る', () => {
  const item = { title: '消費者物価指数の結果', contentStatus: 'VERIFIED_TEXT', contentSnippet: '全国の消費者物価指数は前年同月比2.1％上昇しました。生鮮食品を除く指数も上昇しました。' };
  const result = factualSummary(item);
  assert.match(result.whatChanged, /2\.1％上昇/);
  assert.ok(result.relatedThemes.includes('小売・消費'));
  assert.ok(importance(item, 'MORNING') >= 5);
});
