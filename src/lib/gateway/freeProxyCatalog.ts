import { getRelayUrl } from "./proxy/relay";
import type { CustomProxy, ProxyProtocol } from "../types";
import { proxyKey } from "./freeProxyList";

export interface CatalogProxy {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  exitIp?: string;
  country?: string;
  latencyMs: number;
  successes: number;
  checks: number;
  lastCheckedAt: number;
  lastSuccessAt: number;
  sources: string[];
  score: number;
}
export interface CatalogFilters { q?: string; protocol?: string; country?: string }
export interface CatalogPage {
  items: CatalogProxy[];
  nextCursor: string | null;
  total: number;
  status: { lastCompletedAt: number | null; nextRunAt: number; running: boolean; lastError?: string };
  generatedAt: number;
}
export type CatalogSort = "score" | "latency" | "freshness";

export class CatalogRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The proxy catalog is unavailable (${status}). Try again shortly.`);
    this.status = status;
  }
}

async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`${getRelayUrl()}/v1/free-proxies${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new CatalogRequestError(response.status);
  return response.json() as Promise<T>;
}

export function getCatalogPage(filters: CatalogFilters, sort: CatalogSort, cursor?: string, signal?: AbortSignal): Promise<CatalogPage> {
  const query = new URLSearchParams({ sort, limit: "50" });
  for (const [key, value] of Object.entries(filters)) if (value?.trim()) query.set(key, value.trim());
  if (cursor) query.set("cursor", cursor);
  return request(`?${query}`, signal);
}
export function recommendCatalogProxies(filters: CatalogFilters, count: number, excludeIds: string[], signal?: AbortSignal): Promise<{ items: CatalogProxy[] }> {
  return request("/recommendations", signal, { ...filters, count: Math.min(100, Math.max(1, Math.floor(count) || 10)), excludeIds });
}
export function resolveCatalogProxies(ids: string[], signal?: AbortSignal): Promise<{ items: CatalogProxy[]; unavailableIds: string[] }> {
  return request("/resolve", signal, { ids: [...new Set(ids)] });
}
export function catalogProxyToCustom(proxy: CatalogProxy): CustomProxy {
  return {
    id: `catalog-${proxy.id}`, label: `${proxy.host}:${proxy.port}`, enabled: true,
    protocol: proxy.protocol, host: proxy.host, port: proxy.port,
    source: proxy.sources.join(", "), exitIp: proxy.exitIp,
    catalog: { id: proxy.id, score: proxy.score, latencyMs: proxy.latencyMs,
      successes: proxy.successes, checks: proxy.checks, lastCheckedAt: proxy.lastCheckedAt,
      lastSuccessAt: proxy.lastSuccessAt, country: proxy.country },
  };
}
/** Preserve local edits and credentials; deduplicate the batch and current pool. */
export function mergeCatalogProxies(existing: CustomProxy[], incoming: CustomProxy[]): CustomProxy[] {
  const keys = new Set(existing.map(proxyKey));
  const ids = new Set(existing.map(proxy => proxy.id));
  const additions: CustomProxy[] = [];
  for (const proxy of incoming) {
    const key = proxyKey(proxy);
    if (keys.has(key) || ids.has(proxy.id)) continue;
    keys.add(key); ids.add(proxy.id); additions.push(proxy);
  }
  return [...existing, ...additions];
}
