/**
 * Gateway settings: the shape, its localStorage persistence, and the migrations
 * that run on read.
 *
 * This lives here rather than in `onniroute.ts` purely to break an import cycle.
 * Proxying now reaches paths that have no retry loop of their own - model
 * discovery, media generation, search, the page reader - and those need to ask
 * which proxy is active. The helper that answers (`gateway/activeProxy.ts`)
 * needs `getSettings()`, but `onniroute.ts` imports `media/*` and `search/*`, so
 * a helper those modules imported from `onniroute.ts` would close the loop.
 *
 * `onniroute.ts` re-exports every symbol below, so no import path anywhere in
 * the app changed when this moved. That is the same trick its own header comment
 * describes for the filename.
 */
import type {
  CustomProxy,
  ProviderConnection,
  ProxyProtocol,
  ProxyRoutingMode,
  SearchBackend,
  SearchSettings,
} from "./types";
import { PROXY_PROTOCOLS } from "./types";
import { DEFAULT_SEARCH_BACKEND } from "./appConfig";

const SETTINGS_KEY = "fachoy:settings:v1";

/**
 * Where proxies configured against the old CORS-forwarding transport are kept
 * after being dropped. Not read by anything at runtime - it exists so the
 * one-time notice can offer them as a download instead of the user simply
 * finding their list empty.
 */
const LEGACY_PROXY_KEY = "fachoy:proxies:legacy:v1";
const LEGACY_NOTICE_DISMISSED_KEY = "fachoy:proxies:legacy:dismissed";

/** Default OmniRoute gateway port - unchanged from the pre-rework default. */
export const DEFAULT_OMNIROUTE_URL = "http://localhost:20128";

export type ConnectionMode = "omniroute" | "direct";

export interface OmniRouteConnectionSettings {
  baseUrl: string;
  apiKey: string;
}

export interface GatewaySettings {
  mode: ConnectionMode;
  omniroute: OmniRouteConnectionSettings;
  providers: ProviderConnection[];
  /** Global pool of user-owned proxies, direct mode only. See gateway/proxyRouting.ts. */
  proxies: CustomProxy[];
  /** Master routing switch. Individual proxy configuration remains intact when off. */
  proxiesEnabled: boolean;
  /** How pickProxy() picks among `proxies` - see ProxyRoutingMode. */
  proxyRoutingMode: ProxyRoutingMode;
  /** Proxy ids checked for use when proxyRoutingMode === "manual" (multi-select). */
  manualProxyIds: string[];
  /** Deprecated compatibility field. User overrides are ignored and cleared. */
  relayUrl: string;
  /** User opt-in for unverified provider TLS across all proxies in this browser. */
  allowInsecureProxyTls: boolean;
  search: SearchSettings;
}

export function defaultSettings(): GatewaySettings {
  return {
    mode: "direct",
    omniroute: { baseUrl: DEFAULT_OMNIROUTE_URL, apiKey: "" },
    providers: [],
    proxies: [],
    proxiesEnabled: true,
    proxyRoutingMode: "auto",
    manualProxyIds: [],
    relayUrl: "",
    allowInsecureProxyTls: false,
    search: { provider: DEFAULT_SEARCH_BACKEND as SearchBackend },
  };
}

export function getSettings(): GatewaySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GatewaySettings>;
      const defaults = defaultSettings();
      return {
        mode: parsed.mode === "omniroute" ? "omniroute" : "direct",
        omniroute: { ...defaults.omniroute, ...parsed.omniroute },
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        proxies: migrateProxies(parsed.proxies).proxies,
        proxiesEnabled: parsed.proxiesEnabled !== false,
        proxyRoutingMode:
          parsed.proxyRoutingMode === "manual" || parsed.proxyRoutingMode === "order"
            ? parsed.proxyRoutingMode
            : "auto",
        manualProxyIds: Array.isArray(parsed.manualProxyIds) ? parsed.manualProxyIds : [],
        relayUrl: "",
        allowInsecureProxyTls: parsed.allowInsecureProxyTls === true,
        search: migrateSearchSettings(parsed.search) ?? defaults.search,
      };
    }
  } catch {
    /* ignore */
  }
  return defaultSettings();
}

/**
 * Brave and SerpAPI were removed when the relay went away - neither sends CORS
 * headers, so a browser can't read their responses. Anyone who had one selected
 * falls back to the keyless backend rather than hitting a dead provider, and
 * their old key is dropped since it belonged to a different service.
 */
const LIVE_BACKENDS = new Set<SearchBackend>(["duckduckgo", "serper", "jina"]);

function migrateSearchSettings(search: SearchSettings | undefined): SearchSettings | undefined {
  if (!search) return undefined;
  if (LIVE_BACKENDS.has(search.provider)) return search;
  return { provider: DEFAULT_SEARCH_BACKEND as SearchBackend };
}

export function saveSettings(settings: GatewaySettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, relayUrl: "" }));
}

// ------------------------------------------------------------ proxy migration

function isUsableProxy(entry: unknown): entry is CustomProxy {
  if (!entry || typeof entry !== "object") return false;
  const p = entry as Partial<CustomProxy>;
  return (
    typeof p.id === "string" &&
    typeof p.host === "string" &&
    p.host.length > 0 &&
    typeof p.port === "number" &&
    Number.isInteger(p.port) &&
    PROXY_PROTOCOLS.includes(p.protocol as ProxyProtocol)
  );
}

/**
 * Drops proxies saved against the old CORS-forwarding transport.
 *
 * They cannot be converted, and pretending otherwise would be worse than
 * dropping them. A `urlTemplate` was the URL of a public web service that
 * forwarded a request and added CORS headers; the new transport dials a TCP
 * endpoint and speaks a proxy protocol to it. There is no function from one to
 * the other - you could pull `corsproxy.io:443` out of
 * `https://corsproxy.io/?url={target}`, but dialling that host as an HTTP proxy
 * would simply fail, so "converting" would hand the user a pool of entries
 * guaranteed to be dead.
 *
 * So they are dropped, archived verbatim under a separate key, and announced
 * once in Settings. The archive costs a couple of hundred bytes and is what lets
 * the notice say something specific and offer the old list as a download,
 * instead of the user opening Settings to find their proxies silently gone.
 */
export function migrateProxies(raw: unknown): { proxies: CustomProxy[]; discarded: number } {
  if (!Array.isArray(raw)) return { proxies: [], discarded: 0 };

  const legacy = raw.filter((p) => p && typeof p === "object" && "urlTemplate" in (p as object));
  const proxies = raw.filter(isUsableProxy);

  if (legacy.length > 0) {
    try {
      // Only archive once: a second read must not append duplicates or inflate
      // the count the notice shows.
      if (!localStorage.getItem(LEGACY_PROXY_KEY)) {
        localStorage.setItem(LEGACY_PROXY_KEY, JSON.stringify(legacy));
      }
    } catch {
      /* quota or private mode - the drop still stands */
    }
  }

  return { proxies, discarded: legacy.length };
}

/** How many legacy proxies were archived, for the one-time Settings notice. */
export function legacyProxyCount(): number {
  try {
    if (localStorage.getItem(LEGACY_NOTICE_DISMISSED_KEY)) return 0;
    const raw = localStorage.getItem(LEGACY_PROXY_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** The archived legacy entries, as JSON, for the notice's download button. */
export function legacyProxyExport(): string {
  try {
    return localStorage.getItem(LEGACY_PROXY_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function dismissLegacyProxyNotice(): void {
  try {
    localStorage.setItem(LEGACY_NOTICE_DISMISSED_KEY, "1");
  } catch {
    /* ignore */
  }
}
