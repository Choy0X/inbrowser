import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { normalizeCandidate, parseCandidates, mergeCandidates, nextBoundary, selectTop, validateQuery, validateIds } from '../src/catalog/model.ts';

test('catalog refresh defaults to one hour and Redis is server-only configuration', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.freeProxyCatalog.intervalMinutes, 60);
  assert.equal(config.redis.url, 'redis://127.0.0.1:6380');
});

test('canonical endpoint identity deduplicates feeds, not different protocols', () => {
  const first = normalizeCandidate('HTTP://EXAMPLE.COM.:080', 'http', 'a')!;
  const second = normalizeCandidate('example.com:80', 'http', 'b')!;
  assert.equal(first.id, second.id);
  const merged = mergeCandidates([first, second, normalizeCandidate('socks5://example.com:80', 'socks5', 'a')!]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sources, ['a', 'b']);
  for (const bad of ['http://user:pass@example.com:80', '127.0.0.1:80', '10.0.0.1:80', '169.254.169.254:80', '[::1]:80', 'example.com:0']) {
    assert.equal(normalizeCandidate(bad, 'http', 'a'), null, bad);
  }
});

test('recurring schedule advances to the next boundary independently of initial discovery', () => {
  assert.equal(nextBoundary(0, 60), 3_600_000);
  assert.equal(nextBoundary(3_600_001, 60), 7_200_000);
});

test('resolve rejects endpoint submissions and enforces a bounded ID lookup', () => {
  assert.throws(() => validateIds({ ids: [], host: 'example.com' }));
  assert.throws(() => validateIds({ ids: Array(101).fill('a'.repeat(32)) }));
  assert.throws(() => validateQuery({ url: 'https://example.com' }));
  assert.deepEqual(validateIds({ids:['a'.repeat(32)]}), ['a'.repeat(32)]);
});

test('smart selection favors different exits and respects count without sorting input', () => {
  const records = Array.from({length:1000}, (_, i) => ({ ...normalizeCandidate(`203.1.${Math.floor(i/250)}.${i%250+1}:80`, 'http', 'test')!, exitIp: i < 999 ? '8.8.8.8' : '1.1.1.1', score: 1000-i }));
  assert.deepEqual(selectTop(records, 2).map(p => p.exitIp), ['8.8.8.8','1.1.1.1']);
  assert.equal(records[0].score,1000);
});

test('catalog interval rejects invalid operator configuration', () => {
  assert.throws(() => loadConfig({ FREE_PROXY_INTERVAL_MINUTES: '0' }), /positive integer/);
});

test('CSV, JSON and text source formats reject credentialed public entries', () => {
 assert.equal(parseCandidates('ip,port,protocol\n8.8.8.8,80,http','http','csv',100).length,1);
 assert.equal(parseCandidates('ip,port,username\n8.8.8.8,80,secret','http','csv',100).length,0);
 assert.equal(parseCandidates(JSON.stringify([{ip:'8.8.8.8',port:80,protocols:['http','socks5']}]),'http','json',100).length,2);
});
