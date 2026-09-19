import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { CATALOG_WORKER, checkCandidate, collectCandidates, DiscoveryUnavailable, fetchSource } from '../src/catalog/discovery.ts';
import { normalizeCandidate } from '../src/catalog/model.ts';
import { openTunnel, TunnelError } from '../src/workerTunnel.ts';
import { deriveDialKey, openDial } from '../src/crypto.ts';
import { encodeErrorFrame, encodeReadyFrame, RelayClose } from '../src/protocol.ts';
import { VECTOR_SECRET, vectorFrame, EXPECTED_DIAL } from '../src/conformance.ts';
import type { RelayConfig } from '../src/config.ts';
import type { ForwardResult } from '../src/forward.ts';

const secret = 'catalog-integration-test-secret-123456789';
const url = 'https://raw.githubusercontent.com/example/proxies/main/http.txt';
const signal = () => new AbortController().signal;
const proxy = normalizeCandidate('8.8.8.8:8080', 'http', url)!;
const config = { relaySecret: secret, workerUrl: 'wss://must-not-be-used.example/v1' } as RelayConfig;
const tunnel = () => { const stream = new PassThrough(); stream.on('error', () => {}); return stream; };
const result = (body = 'h=cloudflare.com\nip=1.1.1.1\nloc=HU\n'): ForwardResult => ({ status: 200, headers: {}, body: Readable.from([body]), reusable: false });

test('source fetching signs exact URL and never contacts that source from the app', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    requests++;
    assert.equal(input, 'https://relay.inbrowser.tech/v1/catalog-source');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers), raw = JSON.parse(String(init.body)).url;
    assert.equal(raw, url);
    assert.equal(headers.get('x-catalog-signature'), createHmac('sha256', secret).update(`catalog-source\n${headers.get('x-catalog-timestamp')}\n${headers.get('x-catalog-nonce')}\n${raw}`).digest('hex'));
    assert.match(headers.get('x-catalog-nonce')!, /^[0-9a-f]{32}$/);
    return new Response('8.8.8.8:8080');
  });
  assert.equal(await fetchSource(url, secret, signal()), '8.8.8.8:8080'); assert.equal(requests, 1);
});

test('unsupported source URLs never reach any network transport', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Direct network attempt'); });
  for (const bad of ['http://github.com/a.txt', 'https://github.com:8443/a.txt', 'https://user:pass@github.com/a.txt', 'https://github.com/a.txt#fragment', 'https://github.com.evil.example/a.txt', 'https://127.0.0.1/a.txt']) {
    await assert.rejects(fetchSource(bad, secret, signal()), /Unsupported source/);
  }
});

test('source quota and authentication refusals stop discovery without a retry burst', async t => {
  for (const status of [400, 401, 403, 429, 503]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status }); });
    await assert.rejects(collectCandidates(secret, signal(), 20, [], { pause: async () => {} }), DiscoveryUnavailable);
    assert.equal(calls, 1); mock.mock.restore();
  }
});

test('Worker network errors are infrastructure failures with no direct fallback', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network down'); });
  await assert.rejects(fetchSource(url, secret, signal()), DiscoveryUnavailable); assert.equal(calls, 1);
});

test('source body overflow cancels the upstream reader', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchSource(url, secret, signal()), /too large/); assert.equal(cancelled, true);
});

test('source cancellation includes a stalled response body', async t => {
  const controller = new AbortController(); let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } })));
  const pending = fetchSource(url, secret, controller.signal); setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending); assert.equal(cancelled, true);
});

test('bounded search falls back to known feeds and malformed results cannot inject hosts', async () => {
  const requested: string[] = [];
  const records = await collectCandidates(secret, signal(), 100, [], {
    discoveryTimeoutMs: 10, collectionTimeoutMs: 1000, pause: async () => {},
    fetchSource: async source => { requested.push(source); if (source.startsWith('https://api.github.com/')) return new Promise(() => {}); return '8.8.8.8:8080'; },
  });
  assert.equal(records.length, 3); assert.equal(requested.length, 10);
  assert(requested.slice(1).every(source => source.startsWith('https://raw.githubusercontent.com/')));
});

test('malformed repository search and unapproved discovered links are ignored', async () => {
  const requested: string[] = [];
  const records = await collectCandidates(secret, signal(), 100, [], { pause: async () => {}, fetchSource: async source => {
    requested.push(source);
    if (source.startsWith('https://api.github.com/')) return '{"items":[null,{"full_name":"https://evil.example","default_branch":"main"}]}';
    if (source.startsWith('https://lite.duckduckgo.com/')) return '<a href="https://evil.example/proxies.txt">x</a><a href="https://github.com:8443/u/r/blob/main/http.txt">x</a><a href="https://raw.githubusercontent.com/example/new/main/socks5.txt">valid</a>';
    return '8.8.8.8:8080';
  } });
  assert.equal(records.length, 3);
  assert(requested.includes('https://raw.githubusercontent.com/example/new/main/socks5.txt'));
  assert(!requested.some(source => source.includes('evil.example') || source.includes(':8443')));
});

test('external discovery cancellation does not start source fetches', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(collectCandidates(secret, controller.signal, 10, [], { fetchSource: async () => { called = true; return ''; } }));
  assert.equal(called, false);
});

test('catalog checks force dedicated relay, authenticated purpose, fixed trace target and verified TLS', async () => {
  const stream = tunnel();
  const checked = await checkCandidate({ ...proxy, username: 'must-not-leave' } as typeof proxy, config, signal(), {
    openTunnel: async options => {
      assert.equal(options.workerUrl, CATALOG_WORKER); assert.equal(options.purpose, 'catalog');
      assert.deepEqual(options.target, { host: 'cloudflare.com', port: 443 });
      assert.equal(options.proxy.username, undefined); assert.equal(options.proxy.password, undefined);
      return stream;
    },
    forward: async options => {
      assert.equal(options.meta.target, 'https://cloudflare.com/cdn-cgi/trace'); assert.equal(options.allowInsecureTls, false);
      assert.equal(options.body, null); assert.equal(options.tunnel, stream); return result();
    },
  });
  assert.equal(checked?.exitIp, '1.1.1.1'); assert.equal(checked?.country, 'HU'); assert.equal(stream.destroyed, true);
});

test('catalog infrastructure errors do not mark a proxy as failed', async () => {
  for (const error of [new TunnelError('limited', RelayClose.RATE_LIMITED), new TunnelError('secret', RelayClose.DIAL_DECRYPT_FAILED), new TunnelError('offline', undefined, 'relay_connection_failed'), new TunnelError('bad frame', undefined, 'relay_reply_unrecognised')]) {
    await assert.rejects(checkCandidate(proxy, config, signal(), { openTunnel: async () => { throw error; } }), DiscoveryUnavailable);
  }
  assert.equal(await checkCandidate(proxy, config, signal(), { openTunnel: async () => { throw new TunnelError('proxy refused', RelayClose.PROXY_UNREACHABLE); } }), null);
});

test('catalog deadline covers opening and disposes a late tunnel', async () => {
  const stream = tunnel();
  assert.equal(await checkCandidate(proxy, config, signal(), { timeoutMs: 10, openTunnel: async () => { await delay(30); return stream; } }), null);
  await delay(30); assert.equal(stream.destroyed, true);
});

test('catalog deadline covers stalled TLS or headers and response bodies', async () => {
  for (const phase of ['headers', 'body']) {
    const stream = tunnel(), body = new PassThrough();
    const started = Date.now();
    const checked = await checkCandidate(proxy, config, signal(), {
      timeoutMs: 15, openTunnel: async () => stream,
      forward: async () => phase === 'headers' ? new Promise(() => {}) : { ...result(), body },
    });
    assert.equal(checked, null); assert(Date.now() - started < 500); assert.equal(stream.destroyed, true);
    if (phase === 'body') assert.equal(body.destroyed, true);
  }
});

test('catalog cancellation and invalid or oversized trace responses cannot produce success', async () => {
  for (const body of ['h=evil.example\nip=1.1.1.1\n', 'h=cloudflare.com\nip=not-an-ip\n', 'x'.repeat(8193)]) {
    assert.equal(await checkCandidate(proxy, config, signal(), { openTunnel: async () => tunnel(), forward: async () => result(body) }), null);
  }
  const controller = new AbortController();
  const pending = checkCandidate(proxy, config, controller.signal, { openTunnel: async () => tunnel(), forward: async () => new Promise(() => {}) });
  setTimeout(() => controller.abort(), 10); await assert.rejects(pending);
});

async function fakeWorker(action: (ws: import('ws').WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  server.on('connection', action);
  const address = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${address.port}/v1`, close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const options = (workerUrl: string) => ({ workerUrl, secret, proxy: { protocol: 'http' as const, host: '8.8.8.8', port: 8080 }, target: { host: 'cloudflare.com', port: 443 } });

test('real WebSocket tunnel seals catalog purpose and keeps the old conformance vector valid', async () => {
  let observed: unknown;
  const key = await deriveDialKey(secret);
  const worker = await fakeWorker(ws => ws.once('message', async bytes => {
    observed = await openDial(key, new Uint8Array(bytes as Buffer)); ws.send(encodeReadyFrame());
  }));
  try {
    const stream = await openTunnel({ ...options(worker.url), purpose: 'catalog' }); stream.destroy();
    assert.equal((observed as {purpose?:string}).purpose, 'catalog');
    assert.equal((observed as {username?:string}).username, undefined);
    assert.deepEqual(await openDial(await deriveDialKey(VECTOR_SECRET), vectorFrame(), EXPECTED_DIAL.ts), EXPECTED_DIAL);
  } finally { await worker.close(); }
});

test('pre-aborted tunnels do not connect and timeout removes abort listeners', async () => {
  let connections = 0;
  const worker = await fakeWorker(() => { connections++; });
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(openTunnel({ ...options(worker.url), signal: aborted.signal }), (error: unknown) => error instanceof TunnelError && error.publicCode === 'tunnel_cancelled');
    assert.equal(connections, 0);
    const waiting = new AbortController();
    await assert.rejects(openTunnel({ ...options(worker.url), signal: waiting.signal, openTimeoutMs: 30 }), (error: unknown) => error instanceof TunnelError && error.publicCode === 'tunnel_open_timeout');
    assert.equal(getEventListeners(waiting.signal, 'abort').length, 0);
    await delay(20);
  } finally { await worker.close(); }
});

test('tunnel cancellation during async seal preparation never opens a socket', async () => {
  let connections = 0;
  const worker = await fakeWorker(() => { connections++; });
  try {
    const controller = new AbortController();
    const pending = openTunnel({ ...options(worker.url), signal: controller.signal }); controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof TunnelError && error.publicCode === 'tunnel_cancelled');
    assert.equal(connections, 0);
  } finally { await worker.close(); }
});

test('real Worker quota replies preserve classification and abrupt close is infrastructure failure', async () => {
  for (const limited of [true, false]) {
    const worker = await fakeWorker(ws => ws.once('message', () => { if (limited) ws.send(encodeErrorFrame(RelayClose.RATE_LIMITED, 'busy')); else ws.terminate(); }));
    try {
      await assert.rejects(openTunnel(options(worker.url)), (error: unknown) => error instanceof TunnelError && error.publicCode === (limited ? 'worker_rate_limited' : 'relay_connection_failed'));
    } finally { await worker.close(); }
  }
});
