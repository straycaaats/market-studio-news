import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, sources } from './update-news.mjs';

test('RSSの公開時刻と初回確認時刻を分離する', () => {
  const xml = '<rss><channel><item><title>政策発表</title><link>https://example.com/a</link><pubDate>Wed, 23 Sep 2026 23:00:00 GMT</pubDate></item></channel></rss>';
  const rows = parseRss(xml, sources[0], '2026-09-24T00:10:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishedAt, '2026-09-23T23:00:00.000Z');
  assert.equal(rows[0].firstSeenAt, '2026-09-24T00:10:00.000Z');
  assert.equal(rows[0].fetchedAt, '2026-09-24T00:10:00.000Z');
});
