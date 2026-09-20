/**
 * Async half of default-seeding a fresh client: model discovery for the
 * keyless providers gatewaySettings.ts's withDefaultProviderSeed() just added,
 * and a starter pool of proxies via the same "smart selection" the free-proxy
 * finder's button calls. Both are one-time (flag-gated in localStorage) and
 * never touch a list the user has already populated themselves.
 *
 * This module imports discoverModels from onniroute.ts, which itself imports
 * getSettings from gatewaySettings.ts - so gatewaySettings.ts must never
 * import this module (see its own header comment on the import cycle it
 * already works around).
 */
import type { ProviderConnection } from "../types";
import { discoverModels } from "../onniroute";
import { getSettings, saveSettings, type GatewaySettings } from "../gatewaySettings";
import { PROVIDER_PRESETS } from "./providerPresets";
import { mergeDiscoveredModels } from "./presetConnections";
import { catalogProxyToCustom, mergeCatalogProxies, recommendCatalogProxies } from "./freeProxyCatalog";

const PROVIDER_DISCOVERY_SEED_KEY = "fachoy:providers:default-discovery:v1";
const PROXIES_SEED_DONE_KEY = "fachoy:proxies:default-seed:done";
const PROXIES_SEED_ATTEMPTS_KEY = "fachoy:proxies:default-seed:attempts";
const PROXIES_SEED_MAX_ATTEMPTS = 5;
const DEFAULT_PROXY_COUNT = 10;
const PROXY_REQUEST_TIMEOUT_MS = 8000;

/**
 * Runs discoverModels() once against every connection that matches a keyless
 * preset - not only ones just seeded, so a connection added manually before
 * this shipped is discovered too, avoiding a need to mark "seeded by us" on
 * each connection. Set on first attempt regardless of outcome: a failed
 * discovery is low-stakes since the connection keeps its curated starter
 * models, so there is nothing worth retrying automatically.
 */
export async function ensureDefaultProviderDiscovery(settings: GatewaySettings): Promise<GatewaySettings> {
  try {
    if (localStorage.getItem(PROVIDER_DISCOVERY_SEED_KEY)) return settings;
    localStorage.setItem(PROVIDER_DISCOVERY_SEED_KEY, "1");
  } catch {
    return settings;
  }

  const keylessBaseUrls = new Set(PROVIDER_PRESETS.filter((p) => p.keyless).map((p) => p.baseUrl));
  const candidates = getSettings().providers.filter((c) => keylessBaseUrls.has(c.baseUrl));
  if (candidates.length === 0) return settings;

  const results = await Promise.allSettled(
    candidates.map(async (connection) => [connection.id, await discoverModels(connection)] as const)
  );
  const discoveredById = new Map<string, ProviderConnection["models"]>();
  for (const result of results) {
    if (result.status === "fulfilled") discoveredById.set(result.value[0], result.value[1]);
  }
  if (discoveredById.size === 0) return settings;

  const fresh = getSettings();
  const next: GatewaySettings = {
    ...fresh,
    providers: fresh.providers.map((c) => {
      const discovered = discoveredById.get(c.id);
      return discovered ? { ...c, models: mergeDiscoveredModels(c.models, discovered) } : c;
    }),
  };
  saveSettings(next);
  return next;
}

function markProxySeedDone(): void {
  try {
    localStorage.setItem(PROXIES_SEED_DONE_KEY, "1");
    localStorage.removeItem(PROXIES_SEED_ATTEMPTS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Seeds ~10 proxies from the same catalog "Smart selection" in
 * FreeProxyFinderModal uses, so the app is proxy-ready by default - notably
 * for the three keyless presets that require a proxy to work at all
 * (kilo-gateway, blockrun, vireonix; see providerPresets.ts). Never touches an
 * already non-empty proxy pool. A transient failure (offline, relay down)
 * retries on a later load, up to PROXIES_SEED_MAX_ATTEMPTS, so a durably
 * unreachable relay doesn't retry forever.
 */
export async function ensureDefaultProxies(settings: GatewaySettings): Promise<GatewaySettings> {
  let attempts = 0;
  try {
    if (localStorage.getItem(PROXIES_SEED_DONE_KEY)) return settings;
    attempts = Number(localStorage.getItem(PROXIES_SEED_ATTEMPTS_KEY) ?? "0") || 0;
  } catch {
    return settings;
  }

  const current = getSettings();
  if (current.proxies.length > 0 || attempts >= PROXIES_SEED_MAX_ATTEMPTS) {
    markProxySeedDone();
    return settings;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_REQUEST_TIMEOUT_MS);
  try {
    const { items } = await recommendCatalogProxies({}, DEFAULT_PROXY_COUNT, [], controller.signal);
    markProxySeedDone();
    if (items.length === 0) return settings;
    const fresh = getSettings();
    const next: GatewaySettings = {
      ...fresh,
      proxies: mergeCatalogProxies(fresh.proxies, items.map(catalogProxyToCustom)),
    };
    saveSettings(next);
    return next;
  } catch (err) {
    try {
      localStorage.setItem(PROXIES_SEED_ATTEMPTS_KEY, String(attempts + 1));
    } catch {
      /* ignore */
    }
    console.warn("Default proxy seeding failed; will retry on a later load.", err);
    return settings;
  } finally {
    clearTimeout(timeout);
  }
}
