import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import { openTunnel, TunnelError } from '../workerTunnel.ts';
import { forward } from '../forward.ts';
import type { RelayConfig } from '../config.ts';
import { mergeCandidates, parseCandidates, type CatalogProxy } from './model.ts';
import type { ProxyProtocol } from '../types.ts';

export const CATALOG_WORKER = 'wss://relay.inbrowser.tech/v1';
const SOURCE_ENDPOINT = 'https://relay.inbrowser.tech/v1/catalog-source';
const MAX_BYTES = 5 * 1024 * 1024;
export class DiscoveryUnavailable extends Error { constructor() { super('Catalog relay temporarily unavailable.'); } }
export interface Source { url: string; protocol: ProxyProtocol }
const SEEDS: Source[] = (['http', 'socks4', 'socks5'] as const).flatMap(protocol => [
  { url: `https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/${protocol}/data.txt`, protocol },
  { url: `https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/${protocol}.txt`, protocol },
  { url: `https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/${protocol}.txt`, protocol },
]);
const SOURCE_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com', 'github.com', 'cdn.jsdelivr.net', 'lite.duckduckgo.com', 'html.duckduckgo.com']);

function sourceUrl(raw: string): URL {
  if (raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw)) throw new Error('Unsupported source.');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !SOURCE_HOSTS.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Unsupported source.');
  return url;
}

/** Bounds awaits even when a transport does not settle after being destroyed. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Catalog operation cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** The only source HTTP fetch terminates at our authenticated Worker. */
export async function fetchSource(url: string, secret: string, signal: AbortSignal): Promise<string> {
  sourceUrl(url); signal.throwIfAborted();
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 20_000);
  const timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret).update(`catalog-source\n${timestamp}\n${nonce}\n${url}`).digest('hex');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    let response: Response;
    try {
      response = await abortable(fetch(SOURCE_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-catalog-timestamp': timestamp, 'x-catalog-nonce': nonce, 'x-catalog-signature': signature },
        body: JSON.stringify({ url }), signal: combined, redirect: 'error', credentials: 'omit', cache: 'no-store',
      }).then(result => { if (combined.aborted) void result.body?.cancel().catch(() => {}); return result; }), combined);
    } catch (error) { if (signal.aborted) throw error; throw new DiscoveryUnavailable(); }
    if ([400, 401, 403, 429, 503].includes(response.status)) { void response.body?.cancel().catch(() => {}); throw new DiscoveryUnavailable(); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Source unavailable.'); }
    if (!response.body) throw new Error('Empty source.');
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      combined.throwIfAborted(); const { done, value } = await abortable(reader.read(), combined); if (done) break;
      bytes += value.length; if (bytes > MAX_BYTES) throw new Error('Source too large.'); chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); cancel(); reader?.releaseLock(); }
}

function admittedLink(raw: string): Source | null {
  try {
    let url = new URL(raw.replace(/&amp;/g, '&'), 'https://lite.duckduckgo.com/');
    if (['lite.duckduckgo.com', 'html.duckduckgo.com', 'duckduckgo.com'].includes(url.hostname) && url.searchParams.has('uddg')) url = new URL(url.searchParams.get('uddg')!);
    // Validate before rewriting so credentials, fragments and nonstandard ports cannot be stripped into an admitted URL.
    sourceUrl(url.href);
    if (url.hostname === 'github.com') {
      const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
      if (match) url = new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`);
    }
    sourceUrl(url.href);
    if (url.search.length > 256 || !/\.(?:txt|json|csv)$/i.test(url.pathname)) return null;
    return { url: url.href, protocol: /socks5/i.test(url.pathname) ? 'socks5' : /socks4/i.test(url.pathname) ? 'socks4' : /https/i.test(url.pathname) ? 'https' : 'http' };
  } catch { return null; }
}

interface DiscoveryDependencies {
  fetchSource?: typeof fetchSource;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  discoveryTimeoutMs?: number;
  collectionTimeoutMs?: number;
}
export async function collectCandidates(secret: string, signal: AbortSignal, max: number, previous: CatalogProxy[], dependencies: DiscoveryDependencies = {}): Promise<CatalogProxy[]> {
  signal.throwIfAborted();
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), Math.min(dependencies.collectionTimeoutMs ?? 180_000, 180_000));
  const sources = new Map(SEEDS.map(s => [s.url, s]));
  for (const proxy of previous) for (const url of proxy.sources) { const source = admittedLink(url); if (source && sources.size < 80) sources.set(source.url, source); }
  const get = (url: string, active = combined) => { active.throwIfAborted(); return abortable((dependencies.fetchSource ?? fetchSource)(url, secret, active), active); };
  const pause = (active: AbortSignal) => abortable(dependencies.pause ? dependencies.pause(600, active) : delay(600, undefined, { signal: active }), active);
  const records: CatalogProxy[] = [];
  try {
    // Search has its own budget so registered feeds still get a chance to run.
    const searchController = new AbortController(), searching = AbortSignal.any([combined, searchController.signal]);
    const searchTimer = setTimeout(() => searchController.abort(), Math.min(dependencies.discoveryTimeoutMs ?? 45_000, 45_000));
    const optionalFailure = (error: unknown) => { signal.throwIfAborted(); if (error instanceof DiscoveryUnavailable && !searching.aborted) throw error; };
    try {
      try {
        const search: unknown = JSON.parse(await get('https://api.github.com/search/repositories?q=free-proxy-list+archived:false&sort=updated&per_page=12', searching));
        const items = search && typeof search === 'object' && 'items' in search && Array.isArray(search.items) ? search.items.slice(0, 12) : [];
        for (const repo of items) {
          searching.throwIfAborted();
          if (!repo || typeof repo.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name) || typeof repo.default_branch !== 'string' || repo.default_branch.length > 200) continue;
          try {
            const tree: unknown = JSON.parse(await get(`https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`, searching));
            const files = tree && typeof tree === 'object' && 'tree' in tree && Array.isArray(tree.tree) ? tree.tree : [];
            for (const file of files) {
              if (sources.size >= 80) break;
              if (!file || file.type !== 'blob' || typeof file.path !== 'string' || file.path.length > 1024 || (file.size ?? 0) > MAX_BYTES || !/(proxy|proxies|http|socks)/i.test(file.path)) continue;
              const source = admittedLink(`https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(repo.default_branch)}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
              if (source) sources.set(source.url, source);
            }
          } catch (error) { optionalFailure(error); }
          await pause(searching);
        }
      } catch (error) { optionalFailure(error); }
      if (!searching.aborted) try {
        const html = await get('https://lite.duckduckgo.com/lite/?q=free+proxy+list+http+socks5+github+raw', searching);
        for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) { const source = admittedLink(match[1]); if (source && sources.size < 80) sources.set(source.url, source); }
      } catch (error) { optionalFailure(error); }
    } finally { clearTimeout(searchTimer); searchController.abort(); }
    for (const source of sources.values()) {
      combined.throwIfAborted();
      try { records.push(...parseCandidates(await get(source.url), source.protocol, source.url, max)); }
      catch (error) { combined.throwIfAborted(); if (error instanceof DiscoveryUnavailable) throw error; }
      if (records.length > max * 2) { const merged = mergeCandidates(records, max); records.length = 0; records.push(...merged); }
      await pause(combined);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!controller.signal.aborted || records.length === 0) throw error;
    // Preserve feeds retrieved before the bounded run reached its deadline.
  } finally { clearTimeout(timer); controller.abort(); }
  return mergeCandidates(records, max);
}

const INFRASTRUCTURE_FAILURES = new Set([
  'worker_rate_limited', 'dial_decrypt_failed', 'relay_unreachable', 'relay_connection_failed',
  'relay_reply_unreadable', 'relay_reply_unrecognised', 'target_not_allowed', 'tunnel_open_failed', 'relay_closed',
]);
interface CheckDependencies { openTunnel?: typeof openTunnel; forward?: typeof forward; timeoutMs?: number }
/** No user settings, origin requests or TLS exceptions are accepted by the checker. */
export async function checkCandidate(proxy: CatalogProxy, config: RelayConfig, signal: AbortSignal, dependencies: CheckDependencies = {}): Promise<{ exitIp: string; country?: string; latencyMs: number } | null> {
  signal.throwIfAborted();
  if (!config.relaySecret || config.relaySecret.length < 32) throw new DiscoveryUnavailable();
  const started = Date.now(), controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const budget = Math.min(dependencies.timeoutMs ?? 15_000, 15_000);
  let tunnel: Duplex | undefined, responseBody: NodeJS.ReadableStream | undefined;
  const destroyBody = () => { if (responseBody && 'destroy' in responseBody && typeof responseBody.destroy === 'function') responseBody.destroy(); };
  const abort = () => { tunnel?.destroy(new Error('Catalog check cancelled.')); destroyBody(); };
  combined.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    tunnel = await abortable((dependencies.openTunnel ?? openTunnel)({
      workerUrl: CATALOG_WORKER, secret: config.relaySecret,
      proxy: { protocol: proxy.protocol, host: proxy.host, port: proxy.port },
      target: { host: 'cloudflare.com', port: 443 }, purpose: 'catalog', signal: combined, openTimeoutMs: budget,
    }).then(opened => { if (combined.aborted) opened.destroy(); return opened; }), combined);
    combined.throwIfAborted();
    const response = await abortable((dependencies.forward ?? forward)({
      tunnel: tunnel!, meta: { target: 'https://cloudflare.com/cdn-cgi/trace', method: 'GET', headers: { accept: 'text/plain' }, proxy: { protocol: proxy.protocol, host: proxy.host, port: proxy.port } },
      body: null, timeoutMs: Math.max(1, budget - (Date.now() - started)), allowInsecureTls: false,
    }).then(result => { responseBody = result.body; if (combined.aborted) abort(); return result; }), combined);
    if (response.status !== 200) return null;
    const readBody = async () => {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of response.body) {
        combined.throwIfAborted(); const part = Buffer.from(chunk as Uint8Array); bytes += part.length;
        if (bytes > 8192) return null; chunks.push(part);
      }
      combined.throwIfAborted(); return Buffer.concat(chunks).toString('utf8');
    };
    const body = await abortable(readBody(), combined); if (body === null) return null;
    const exitIp = /^ip=(.+)$/m.exec(body)?.[1].trim(), country = /^loc=([A-Z]{2})\r?$/m.exec(body)?.[1];
    if (!exitIp || !isIP(exitIp) || !/^h=cloudflare\.com\r?$/m.test(body)) return null;
    return { exitIp, country, latencyMs: Date.now() - started };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TunnelError && INFRASTRUCTURE_FAILURES.has(error.publicCode)) throw new DiscoveryUnavailable();
    return null;
  } finally { clearTimeout(timer); combined.removeEventListener('abort', abort); destroyBody(); tunnel?.destroy(); }
}
