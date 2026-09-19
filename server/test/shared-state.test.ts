import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import { createConnection, createServer, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadConfig, type RelayConfig } from '../src/config.ts';
import { rateLimit, RedisLease, RedisUnavailable, SharedRedis } from '../src/redis.ts';

// Integration tests need real Redis, isolated by a random prefix per test.
// Default: disposable Redis on localhost:16380. Never FLUSHDB or FLUSHALL.
const url = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:16380';
const secret = 'integration-only-secret-not-a-production-credential';

async function ready(redis: SharedRedis): Promise<void> {
  redis.start();
  const deadline = Date.now() + 5_000;
  while (!redis.ready && Date.now() < deadline) await delay(10);
  assert.equal(redis.ready, true, 'Start real Redis or configure TEST_REDIS_URL before running integration tests.');
  assert.equal(await redis.command('PING'), 'PONG');
}

async function keys(redis: SharedRedis): Promise<string[]> {
  const result: string[] = [];
  let cursor = '0';
  do {
    const page = await redis.command<[string, string[]]>('SCAN', cursor, 'MATCH', redis.key('*'), 'COUNT', '100');
    cursor = page[0];
    result.push(...page[1]);
  } while (cursor !== '0');
  return [...new Set(result)];
}

async function fixture(t: TestContext): Promise<{ redis: SharedRedis; config: RelayConfig }> {
  const config = loadConfig({
    NODE_ENV: 'production', REDIS_URL: url,
    REDIS_PASSWORD: process.env.TEST_REDIS_PASSWORD,
    REDIS_KEY_PREFIX: `inbrowser-test:${randomUUID()}:`,
    REDIS_COMMAND_TIMEOUT_MS: '500', RELAY_SECRET: secret,
    WORKER_URL: 'wss://relay.invalid/v1', FREE_PROXY_CATALOG_DISABLED: '1',
    SUGGESTIONS_DISABLED: '1', CLUSTER_WORKERS: '1',
  });
  const redis = new SharedRedis(config.redis);
  t.after(async () => {
    await redis.close();
    const cleanup = new SharedRedis(config.redis);
    try {
      await ready(cleanup);
      const ownKeys = await keys(cleanup);
      if (ownKeys.length) await cleanup.command('DEL', ...ownKeys);
    } finally { await cleanup.close(); }
  });
  await ready(redis);
  return { redis, config };
}

test('atomic rate windows are shared across real Redis clients and contain no raw client identifiers', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  const second = new SharedRedis(config.redis);
  t.after(() => second.close());
  await ready(second);
  const clientIp = '203.0.113.91';
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) =>
    rateLimit(n % 2 ? redis : second, secret, clientIp, 10)));
  assert.equal(results.filter(result => result.limited).length, 10);
  assert.equal(results.filter(result => !result.limited).length, 10);
  assert.ok(results.every(result => result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 60));
  const stored = await keys(redis);
  assert.equal(stored.length, 1);
  assert.ok(stored.every(key => !key.includes(clientIp) && !key.includes(secret)));
  assert.match(stored[0].slice(redis.prefix.length), /^rate:relay:[a-f0-9]{64}$/);
  assert.equal(await redis.command('GET', stored[0]), '20');
  const ttl = await redis.command<number>('PTTL', stored[0]);
  assert.ok(ttl > 0 && ttl <= 60_000, 'Rate counters must expire.');
  await redis.command('PEXPIRE', stored[0], '1');
  await delay(10);
  assert.equal((await rateLimit(second, secret, clientIp, 10)).limited, false);
  assert.equal(await redis.command('GET', stored[0]), '1');
});

test('leases are exclusive and stale owners cannot renew, publish, or delete a successor', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  const second = new SharedRedis(config.redis);
  t.after(() => second.close());
  await ready(second);
  const lease = await RedisLease.acquire(redis, 'test-job', 30_000);
  assert.ok(lease);
  t.after(() => lease.release());
  assert.equal(await RedisLease.acquire(second, 'test-job', 30_000), null);
  await redis.command('PEXPIRE', lease.key, '1000');
  assert.equal(await lease.renew(), true);
  assert.ok(await redis.command<number>('PTTL', lease.key) > 25_000);
  await lease.setJson('public', { version: 1 }, 60);
  assert.deepEqual(await second.json('public'), { version: 1 });

  const successorToken = randomUUID();
  await second.command('SET', lease.key, successorToken, 'PX', '30000');
  await assert.rejects(lease.setJson('public', { version: 2 }, 60), RedisUnavailable);
  assert.equal(lease.signal.aborted, true);
  assert.equal(await lease.renew(), false);
  assert.deepEqual(await second.json('public'), { version: 1 });
  await lease.release();
  assert.equal(await second.command('GET', lease.key), successorToken);
  await second.command('DEL', lease.key);
  const successor = await RedisLease.acquire(second, 'test-job', 30_000);
  assert.ok(successor);
  await successor.release();
  assert.equal(await redis.command('EXISTS', lease.key), 0);

  const renewal = await RedisLease.acquire(redis, 'test-renewal', 30_000);
  assert.ok(renewal);
  t.after(() => renewal.release());
  await second.command('SET', renewal.key, successorToken, 'PX', '1000');
  assert.equal(await renewal.renew(), false);
  assert.equal(renewal.signal.aborted, true);
  assert.ok(await second.command<number>('PTTL', renewal.key) <= 1000, 'A stale owner must not extend the successor lease.');
  await renewal.release();
  assert.equal(await second.command('GET', renewal.key), successorToken);
});

test('disconnected writes fail immediately and never replay after connecting', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  const offline = new SharedRedis(config.redis);
  t.after(() => offline.close());
  const started = Date.now();
  await assert.rejects(offline.command('SET', offline.key('must-not-exist'), 'queued'), RedisUnavailable);
  assert.ok(Date.now() - started < 500);
  await ready(offline);
  assert.equal(await redis.command('EXISTS', offline.key('must-not-exist')), 0);
  await offline.close();
  await assert.rejects(offline.command('SET', offline.key('must-not-exist'), 'queued'), RedisUnavailable);
  await ready(offline);
  assert.equal(await redis.command('EXISTS', offline.key('must-not-exist')), 0);
});

test('a blocked Redis command has a bounded timeout and errors omit connection details', { timeout: 15_000 }, async t => {
  const { redis } = await fixture(t);
  const started = Date.now();
  await assert.rejects(redis.command('BLPOP', redis.key('never-filled'), '2'), error => {
    assert.ok(error instanceof RedisUnavailable);
    assert.equal(error.message, 'Shared state is temporarily unavailable.');
    assert.ok(!error.message.includes(url) && !error.message.includes(secret));
    return true;
  });
  assert.ok(Date.now() - started < 1_500, 'The 500ms command deadline must beat the 2s Redis block.');
  // The deadline can initiate a reconnect. close() must also settle that
  // in-flight connection, or it can become ready after shutdown and leak a socket.
  await redis.close();
  await delay(100);
  assert.equal(redis.ready, false, 'A timeout reconnect must not outlive explicit close.');
});

test('initial Redis unavailability and later transport outages recover without replaying offline writes', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  const endpoint = new URL(url);
  const sockets = new Set<Socket>();
  const proxy = createServer(socket => {
    const upstream = createConnection({ host: endpoint.hostname, port: Number(endpoint.port || 6379) });
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on('error', () => { socket.destroy(); upstream.destroy(); });
      connection.on('close', () => sockets.delete(connection));
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const stopProxy = async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  };
  const listenProxy = () => new Promise<void>(resolve => proxy.listen(port, '127.0.0.1', resolve));
  await stopProxy();
  const recovering = new SharedRedis({ ...config.redis, url: `redis://127.0.0.1:${port}` });
  t.after(async () => { await recovering.close(); await stopProxy(); });
  recovering.start();
  await delay(150);
  assert.equal(recovering.ready, false);
  await assert.rejects(recovering.command('SET', recovering.key('offline-before-start'), 'forbidden'), RedisUnavailable);
  await listenProxy();
  assert.equal(await recovering.waitReady(5_000), true, 'A single start must keep retrying until Redis appears.');
  assert.equal(await recovering.command('PING'), 'PONG');

  await stopProxy();
  const deadline = Date.now() + 1000;
  while (recovering.ready && Date.now() < deadline) await delay(10);
  assert.equal(recovering.ready, false);
  await assert.rejects(recovering.command('SET', recovering.key('offline-after-loss'), 'forbidden'), RedisUnavailable);
  await delay(150);
  await listenProxy();
  assert.equal(await recovering.waitReady(5_000), true, 'Established connections must recover after transport loss.');
  assert.equal(await recovering.command('PING'), 'PONG');
  assert.equal(await redis.command('EXISTS', recovering.key('offline-before-start'), recovering.key('offline-after-loss')), 0);
  await recovering.close();
  await delay(150);
  assert.equal(recovering.ready, false);
});

test('close settles an in-flight connection and explicit restart still works', { timeout: 15_000 }, async t => {
  const { config } = await fixture(t);
  const connecting = new SharedRedis(config.redis);
  t.after(() => connecting.close());
  connecting.start();
  await connecting.close();
  await delay(100);
  assert.equal(connecting.ready, false, 'TCP success after close must not orphan a ready connection.');
  await ready(connecting);
  assert.equal(await connecting.command('PING'), 'PONG');
});

test('close is bounded when a TCP peer never completes the Redis handshake', { timeout: 15_000 }, async t => {
  const { config } = await fixture(t);
  const sockets = new Set<Socket>();
  let accepted!: () => void;
  const connected = new Promise<void>(resolve => { accepted = resolve; });
  const silent = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
    accepted();
  });
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  const address = silent.address();
  assert.ok(address && typeof address === 'object');
  const stalled = new SharedRedis({ ...config.redis, url: `redis://127.0.0.1:${address.port}` });
  t.after(async () => {
    await stalled.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => silent.close(() => resolve()));
  });
  stalled.start();
  await connected;
  const started = Date.now();
  await stalled.close();
  assert.ok(Date.now() - started < 3000, 'Shutdown must not wait indefinitely for handshake replies.');
  await delay(100);
  assert.equal(stalled.ready, false);
});

test('catalog API validates request bodies and never performs outbound discovery', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('Unexpected network fetch'); });
  t.mock.method(globalThis, 'WebSocket', class {
    constructor() { outbound++; throw new Error('Unexpected tunnel dial'); }
  } as unknown as typeof WebSocket);
  const app = buildApp(config, redis);
  t.after(() => app.close());
  const invalidResolve = [
    { ids: [], host: 'example.com', port: 443 },
    { ids: ['https://example.com:443'] },
    { ids: Array(101).fill('a'.repeat(32)) },
  ];
  for (const payload of invalidResolve) {
    const response = await app.inject({ method: 'POST', url: '/v1/free-proxies/resolve', payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'catalog_invalid_request');
  }
  for (const payload of [{ count: 0 }, { count: 101 }, { count: '10' }, { excludeIds: ['host:443'] }, { target: 'https://example.com' }]) {
    const response = await app.inject({ method: 'POST', url: '/v1/free-proxies/recommendations', payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  const malformed = await app.inject({ method: 'POST', url: '/v1/free-proxies/resolve', headers: { 'content-type': 'application/json' }, payload: '{' });
  assert.equal(malformed.statusCode, 400);
  const unknownQuery = await app.inject('/v1/free-proxies?target=https://example.com');
  assert.equal(unknownQuery.statusCode, 400);
  const page = await app.inject('/v1/free-proxies');
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(page.json().items, []);
  assert.equal(page.headers['cache-control'], 'no-store');
  const resolution = await app.inject({ method: 'POST', url: '/v1/free-proxies/resolve', payload: { ids: ['a'.repeat(32)] } });
  assert.equal(resolution.statusCode, 200, resolution.body);
  assert.deepEqual(resolution.json(), { items: [], unavailableIds: ['a'.repeat(32)] });
  const recommendations = await app.inject({ method: 'POST', url: '/v1/free-proxies/recommendations', payload: { count: 10, excludeIds: [] } });
  assert.equal(recommendations.statusCode, 200, recommendations.body);
  assert.deepEqual(recommendations.json(), { items: [] });
  assert.equal(outbound, 0);
  assert.equal(await redis.command('EXISTS', redis.key('lease:catalog-job')), 0);
});

test('shared-state outage rejects new relay/catalog requests and keeps curated suggestions available', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('Unexpected network fetch'); });
  t.mock.method(globalThis, 'WebSocket', class {
    constructor() { outbound++; throw new Error('Unexpected tunnel dial'); }
  } as unknown as typeof WebSocket);
  const app = buildApp(config, redis);
  t.after(() => app.close());
  await app.ready();
  await redis.close();
  for (const request of [
    { method: 'GET' as const, url: '/v1/free-proxies' },
    { method: 'POST' as const, url: '/v1/free-proxies/resolve', payload: { ids: [] } },
    { method: 'POST' as const, url: '/v1/fetch', headers: { 'x-relay-meta': Buffer.from(JSON.stringify({ target: 'https://example.com', method: 'GET', headers: {}, proxy: { protocol: 'http', host: 'proxy.example.com', port: 8080 } })).toString('base64url') } },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, 'shared_state_unavailable');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['retry-after'], '5');
  }
  const suggestions = await app.inject('/v1/suggestions?part=morning');
  assert.equal(suggestions.statusCode, 200, suggestions.body);
  assert.equal(suggestions.json().source, 'curated');
  assert.ok(suggestions.json().suggestions.length > 0);
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal(outbound, 0);
});

test('losing the shared Redis connection does not close an established app response stream', { timeout: 15_000 }, async t => {
  const { redis, config } = await fixture(t);
  const app = buildApp(config, redis);
  const stream = new PassThrough();
  // A test-only stream isolates the app/Redis lifecycle from the external Worker.
  app.get('/test-established-stream', (_request, reply) => {
    reply.type('application/octet-stream').send(stream);
    stream.write('before\n');
    return reply;
  });
  t.after(async () => { stream.destroy(); await app.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(`${address}/test-established-stream`, resolve).on('error', reject);
  });
  const chunks = response[Symbol.asyncIterator]();
  const first = await chunks.next();
  assert.equal(Buffer.from(first.value).toString(), 'before\n');
  await redis.close();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/fetch' })).statusCode, 503);
  stream.end('after\n');
  const second = await chunks.next();
  assert.equal(Buffer.from(second.value).toString(), 'after\n');
  assert.equal((await chunks.next()).done, true);
  assert.equal(response.complete, true);
});
