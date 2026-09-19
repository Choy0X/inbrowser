/**
 * Health-based routing across a user's own configured proxy pool. Sibling to
 * autoRoute.ts, but transport-level rather than model-level: a proxy isn't a
 * model or a provider identity, just an alternate path an outbound request
 * can take (see providerFetch.ts). Reuses the same circuit-breaking/cooldown
 * machinery routingEngine.ts already runs for models/connections, in its own
 * store, with a simpler health+latency-only score - task-fitness, tier and
 * context affinity are model concepts that don't apply to a transport hop.
 *
 * The "transport hop" framing turned out to be literally true: when proxies
 * changed from CORS-forwarding URL templates to real host:port endpoints dialled
 * through the relay, nothing in this file needed to change. It reads `p.id`,
 * `p.enabled` and array order, and none of those are properties of a transport.
 */
import type { CustomProxy, ProxyRoutingMode } from "../types";
import {
  createHealthStore,
  getStats,
  healthFactor,
  isCoolingDown,
  recordStoreOutcome,
  recentLatency,
  RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  type HealthStore,
} from "./routingEngine";

const proxyStore: HealthStore = createHealthStore();
const destinationStore: HealthStore = createHealthStore();
const proxyLoad = new Map<string, number>();

export function beginProxyAttempt(proxyId?: string): () => void {
  if (!proxyId) return () => {};
  proxyLoad.set(proxyId, (proxyLoad.get(proxyId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (proxyLoad.get(proxyId) ?? 1) - 1;
    if (remaining > 0) proxyLoad.set(proxyId, remaining); else proxyLoad.delete(proxyId);
  };
}

function destinationKey(proxyId: string, targetUrl: string): string {
  try { return `${proxyId}|${new URL(targetUrl).origin}`; }
  catch { return `${proxyId}|${targetUrl}`; }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const WEIGHTS = { health: 0.7, latencyInv: 0.3 };
/** Neutral fallback for a proxy with no recorded successes yet. */
const DEFAULT_LATENCY_MS = 2000;

/** Catalog data is a short-lived prior. Real session outcomes take precedence. */
function catalogPrior(proxy: CustomProxy, now: number): { health: number; latency: number } {
  const c = proxy.catalog;
  if (!c || !Number.isFinite(c.lastSuccessAt) || c.lastSuccessAt <= 0 ||
      !Number.isFinite(c.latencyMs) || c.latencyMs < 0 || !Number.isFinite(c.checks) || c.checks <= 0 ||
      !Number.isFinite(c.successes) || c.successes < 0) return { health: 0.7, latency: DEFAULT_LATENCY_MS };
  const freshness = Math.exp(-Math.max(0, now - c.lastSuccessAt) / (30 * 60 * 1000));
  const confidence = Math.min(0.8, c.checks / (c.checks + 3)) * freshness;
  return {
    health: 0.7 + confidence * (clamp01(c.successes / c.checks) - 0.7),
    latency: DEFAULT_LATENCY_MS + confidence * (c.latencyMs - DEFAULT_LATENCY_MS),
  };
}

/** One pass with stable tie-breaking; manual/order preserve pool order. */
export function pickProxy(
  pool: CustomProxy[],
  excluded: Set<string>,
  mode: ProxyRoutingMode = "auto",
  manualProxyIds?: string[],
  targetUrl?: string
): CustomProxy | null {
  const allowed = mode === "manual" ? new Set(manualProxyIds ?? []) : undefined;
  let origin: string | undefined;
  if (targetUrl) { try { origin = new URL(targetUrl).origin; } catch { origin = targetUrl; } }
  const now = Date.now();
  let best: CustomProxy | null = null;
  let bestScore = -Infinity;
  for (const proxy of pool) {
    if (excluded.has(proxy.id) || (allowed ? !allowed.has(proxy.id) : !proxy.enabled)) continue;
    const key = origin ? proxy.id + "|" + origin : undefined;
    if (isCoolingDown(proxyStore, proxy.id, now) || (key && isCoolingDown(destinationStore, key, now))) continue;
    if (mode !== "auto") return proxy;
    const stats = getStats(proxyStore, proxy.id);
    const routeStats = key ? getStats(destinationStore, key) : undefined;
    const routeWeight = Math.min(0.7, (routeStats?.recentOutcomes.length ?? 0) / 5);
    const prior = stats.recentOutcomes.length ? undefined : catalogPrior(proxy, now);
    const health = (1 - routeWeight) * (prior?.health ?? healthFactor(proxyStore, proxy.id)) +
      routeWeight * (key ? healthFactor(destinationStore, key) : 0.7);
    const latency = key && routeStats?.successes ? recentLatency(destinationStore, key) :
      stats.successes > 0 ? recentLatency(proxyStore, proxy.id) : prior?.latency ?? DEFAULT_LATENCY_MS;
    const score = WEIGHTS.health * clamp01(health) +
      WEIGHTS.latencyInv * (DEFAULT_LATENCY_MS / (DEFAULT_LATENCY_MS + latency)) -
      Math.min(0.3, (proxyLoad.get(proxy.id) ?? 0) * 0.08);
    if (score > bestScore) { best = proxy; bestScore = score; }
  }
  return best;
}

/** Call after every attempt made through a proxy, mirroring autoRoute's recordOutcome. */
export function recordProxyOutcome(
  proxyId: string,
  ok: boolean,
  latencyMs: number,
  opts: { hardFailure?: boolean; rateLimited?: boolean; retryAfterMs?: number; targetUrl?: string; targetOnly?: boolean } = {}
): void {
  const cooldownOverrideMs = opts.rateLimited ? opts.retryAfterMs ?? RATE_LIMIT_FALLBACK_COOLDOWN_MS : undefined;
  if (!opts.targetOnly) recordStoreOutcome(proxyStore, proxyId, ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
  if (opts.targetUrl) recordStoreOutcome(destinationStore, destinationKey(proxyId, opts.targetUrl), ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
}
