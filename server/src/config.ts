/**
 * The server's configuration.
 *
 * Read from `config.json` at the repo root - the same file the client's brand
 * and behaviour come from - with every value overridable by an environment
 * variable. Precedence is env > config.json > built-in default.
 *
 * Read at RUNTIME rather than imported, deliberately. Importing would inline the
 * whole file into the esbuild bundle, so the relay secret would be baked into
 * the deployed artifact and changing a port would need a rebuild. Reading it
 * means config.json ships next to server/dist/relay.cjs and a restart is enough.
 *
 * Only this file and vite.config.ts ever read config.json. Nothing under `src/`
 * may import it: the `server` section holds the relay secret, and a JSON import
 * from client code would publish it to every visitor. See the header of
 * src/lib/appConfig.ts.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RelayConfig {
  redis: { url: string; password?: string; keyPrefix: string; commandTimeoutMs: number };
  freeProxyCatalog: { intervalMinutes: number; stateDir: string; maxCandidates: number; concurrency: number; startsPerSecond: number; enabled: boolean };
  port: number;
  /** `wss://...` address of the Cloudflare Worker that dials proxies. */
  workerUrl: string;
  /** Shared with the Worker. Without it every proxied request returns 503. */
  relaySecret: string;
  /**
   * Origins allowed to call the relay route. Empty is the normal case and means
   * no CORS headers are emitted at all, because the client is served from this
   * same origin. Non-empty exists only for a deployment whose client lives
   * somewhere else.
   */
  allowedOrigins: string[];
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  /** Directory holding the built client. */
  distDir: string;
  dev: boolean;
  /**
   * The canonical apex hostname (config.json's `app.domain`, e.g. "inbrowser.tech").
   * Used only to redirect a `www.` host to this exact value - never to redirect
   * to whatever a client's Host header happens to say. Empty disables the redirect.
   */
  domain: string;
  /**
   * Opt-in, off by default. When set, `handleRelay` and `openTunnel` emit a
   * single structured JSON line per failure naming which site fired and a
   * non-identifying category/duration - never the target, headers, proxy or
   * dial content. Exists to root-cause a relay failure without weakening the "logs
   * nothing" claim in the normal case.
   */
  debugLog: boolean;
  /**
   * Port for the aggregate-counter listener, or 0 for off (the default).
   * Always bound to 127.0.0.1 - see metricsServer.ts. Off by default so a
   * self-hoster copying the systemd unit gets the same one-port process the
   * deploy docs describe.
   */
  metricsPort: number;
  /**
   * Tunnels this process will hold open at once before answering 503
   * `relay_at_capacity`. Per cluster worker, not per box. 0 means unbounded,
   * which is the pre-admission-control behaviour and is not recommended
   * anywhere a real user can reach.
   */
  maxInflightTunnels: number;
  /** Cluster workers to fork. 1 runs everything in one process, as before. */
  clusterWorkers: number;
  /**
   * Reuse a tunnel across requests. Off by default, deliberately - read the
   * header of tunnelPool.ts before turning it on, and measure the hit rate
   * first, because for this app's two dial-heavy workloads it is near zero.
   */
  poolTunnels: boolean;
}

/**
 * The repo root. Taken from the working directory rather than this file's own
 * location, because the production artifact is a CJS bundle and `import.meta.url`
 * is not available there. Running from the repo root is already required anyway:
 * vite.config.ts's patchPhpWasmGluePlugin and runtimeManifestPlugin both resolve
 * against process.cwd(). One rule, not two.
 */
const ROOT = process.cwd();

interface ServerSection {
  redis?: Partial<RelayConfig["redis"]>;
  freeProxyCatalog?: Partial<RelayConfig["freeProxyCatalog"]>;
  port?: number;
  devPort?: number;
  workerUrl?: string;
  relaySecret?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  distDir?: string;
  metricsPort?: number;
  maxInflightTunnels?: number;
  clusterWorkers?: number;
  poolTunnels?: boolean;
}

function readServerSection(): ServerSection {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8")) as {
      server?: ServerSection;
    };
    return parsed.server ?? {};
  } catch {
    // A missing or unreadable config.json is not fatal: every value has a
    // default and the environment can supply the rest. The case that actually
    // matters, an unusable relay secret, is reported at startup by index.ts.
    return {};
  }
}

/**
 * `app.domain` from config.json - a brand string, not a server setting, but the
 * canonical host the www-redirect pins to has to come from somewhere the server
 * trusts, and the alternative (duplicating it into the `server` section) would
 * just invite the two to drift.
 */
function readAppDomain(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8")) as {
      app?: { domain?: string };
    };
    return parsed.app?.domain ?? "";
  } catch {
    return "";
  }
}

function intFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Like intFrom, but accepts zero. Several settings below use 0 to mean "off"
 * or "unbounded", which intFrom would silently discard in favour of the
 * default - turning `METRICS_PORT=0` into "use the configured port" rather
 * than "do not listen".
 */
function countFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * True when the relay secret is missing or is obviously a placeholder.
 *
 * config.json is committed, so a secret written into it is public. Accepting one
 * would give the appearance of authentication with none of it - the Worker would
 * accept dials from anyone who read the repo. So the server refuses to enable
 * proxying and says why, rather than running in a state that looks configured.
 *
 * `deriveDialKey` independently rejects anything under 32 characters, so a short
 * placeholder would fail at first use anyway; this catches it at startup, and
 * catches a long-but-obviously-fake one too.
 */
export function isPlaceholderSecret(secret: string): boolean {
  const trimmed = secret.trim();
  if (trimmed.length < 32) return true;
  const squashed = trimmed.replace(/[-_\s]/g, "").toLowerCase();
  return /^(example|changeme|placeholder|yoursecret|replaceme|x+|0+|a+)$/.test(squashed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const dev = env.NODE_ENV !== "production";
  const file = readServerSection();

  // 5173 in dev and 4173 in production keep the ports this project has always
  // used, so anything pointing at them - a reverse proxy, a bookmark - still
  // works now that the two servers became one.
  const filePort = dev ? file.devPort : file.port;

  const originsFromEnv = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : null;

  const distDir = env.DIST_DIR || file.distDir || "";
  const positive = (value: unknown, fallback: number, name: string): number => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };

  return {
    redis: {
      url: env.REDIS_URL || file.redis?.url || "redis://127.0.0.1:6380",
      password: env.REDIS_PASSWORD,
      keyPrefix: env.REDIS_KEY_PREFIX || file.redis?.keyPrefix || "inbrowser:v1:",
      commandTimeoutMs: positive(env.REDIS_COMMAND_TIMEOUT_MS ?? file.redis?.commandTimeoutMs, 1000, "Redis command timeout"),
    },
    freeProxyCatalog: {
      intervalMinutes: positive(env.FREE_PROXY_INTERVAL_MINUTES ?? file.freeProxyCatalog?.intervalMinutes, 60, "Proxy catalog interval"),
      stateDir: resolve(env.FREE_PROXY_STATE_DIR || file.freeProxyCatalog?.stateDir || "server/state/catalog"),
      maxCandidates: positive(env.FREE_PROXY_MAX_CANDIDATES ?? file.freeProxyCatalog?.maxCandidates, 100_000, "Proxy candidate limit"),
      concurrency: positive(env.FREE_PROXY_CONCURRENCY ?? file.freeProxyCatalog?.concurrency, 256, "Proxy check concurrency"),
      startsPerSecond: positive(env.FREE_PROXY_STARTS_PER_SECOND ?? file.freeProxyCatalog?.startsPerSecond, 20, "Proxy check rate"),
      enabled: env.FREE_PROXY_CATALOG_DISABLED !== "1" && file.freeProxyCatalog?.enabled !== false,
    },
    port: intFrom(env.PORT, filePort ?? (dev ? 5173 : 4173)),
    workerUrl: env.WORKER_URL || file.workerUrl || "",
    relaySecret: env.RELAY_SECRET || file.relaySecret || "",
    allowedOrigins: originsFromEnv ?? file.allowedOrigins ?? [],
    maxBodyBytes: intFrom(env.MAX_BODY_BYTES, file.maxBodyBytes ?? 32 * 1024 * 1024),
    rateLimitPerMinute: intFrom(env.RATE_LIMIT_PER_MINUTE, file.rateLimitPerMinute ?? 120),
    distDir: distDir ? resolve(distDir) : join(ROOT, "dist"),
    dev,
    domain: env.APP_DOMAIN || readAppDomain(),
    debugLog: env.RELAY_DEBUG_LOG === "1",
    // intFrom() refuses zero and negatives, so these three take their own
    // parse: 0 is meaningful for two of them (off / unbounded) rather than
    // being a rejected value that falls back to the default.
    metricsPort: countFrom(env.METRICS_PORT, file.metricsPort ?? 0),
    maxInflightTunnels: countFrom(env.MAX_INFLIGHT_TUNNELS, file.maxInflightTunnels ?? 750),
    clusterWorkers: countFrom(env.CLUSTER_WORKERS, file.clusterWorkers ?? 1),
    poolTunnels: env.POOL_TUNNELS !== undefined ? env.POOL_TUNNELS === "1" : Boolean(file.poolTunnels),
  };
}

export const VERSION = "1.0.0";

/**
 * Prefixes under which the big in-browser language runtimes are served.
 *
 * Load-bearing in two places: these paths get immutable caching, and the SPA
 * fallback must refuse them. A missing runtime asset answered with index.html
 * reaches the engine as HTML and surfaces as a WebAssembly.CompileError whose
 * first bytes are `<!do` - see the note in vite.config.ts on why the asset lists
 * there are exhaustive.
 */
export const RUNTIME_ASSET_PREFIXES = ["/pyodide/", "/php/", "/ruby/", "/r/", "/cpp/"];

/** Paths the relay owns. The SPA fallback must never answer these with HTML. */
export const API_PREFIXES = ["/v1/", "/health"];

export function isRuntimeAssetPath(pathname: string): boolean {
  return RUNTIME_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}
