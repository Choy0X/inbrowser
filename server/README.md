# The InBrowser server

The Fastify server serves the built client from `dist/`, forwards proxied
requests to the Cloudflare Worker that dials the user's proxy, and exposes shared
starter prompts and a scheduled public proxy catalog. The Worker lives in the
`inbrowser-relay` repository. Production can run multiple Node workers, with
Redis coordinating shared state and rate limits.

Serving both from one origin is the point. It removes CORS and the `X-Relay-Meta`
preflight, removes the relay URL the client would otherwise have to be told, and
puts the cross-origin-isolation headers in one place instead of several that can
drift.

The relay route is only reached when a user configures a proxy. With none
configured, the browser still calls providers directly. Catalog and starter
prompt requests can still reach the server, and background catalog maintenance
runs independently of visitor traffic.

## What it can see

**Everything on the proxied path.** It establishes the TLS session with the
provider, so requests, responses and provider API keys pass through this process
in readable form. Since it also serves the client, it sees ordinary page requests
the way any web server does.

That is inherent rather than a shortcut: whichever component assembles the
provider's HTTP request necessarily sees its `Authorization` header, and no
arrangement between our own components changes it. Encrypting the hop to the
Worker protects the hop; it cannot hide plaintext from the machine that produced
it. The app states this plainly in `src/components/PrivacyPolicyContent.tsx`
rather than implying end-to-end secrecy.

What follows are rules, not preferences. `npm run verify:relay` asserts the first
and last of them.

- **Never log a request field.** No access log with the target, no dump of
  `X-Relay-Meta`, no error log carrying a header or URL. Application diagnostics
  contain operational categories rather than request
  contents. Preserve the deployment's `X-Relay-Meta` access-log filter as well.
- **Never persist relayed content or credentials.** Provider API keys, user
  proxy passwords, request bodies, response bodies, and raw visitor IP addresses
  do not belong in Redis or catalog snapshots. Redis holds public catalog data,
  shared starter prompts, scheduler coordination, and short-lived rate counters
  keyed by an HMAC of the client identifier. The HMAC is pseudonymous, not a
  claim of anonymity. Disk snapshots contain public proxy endpoints, provenance,
  and check results only; public proxy IPs are distinct from visitor IPs.
- **Dependencies are an allowlist, not an accident.** `fastify`,
  `@fastify/static`, `@fastify/middie`, and `redis` are pinned exactly;
  `verify:relay` rejects unreviewed imports and unpinned versions. The relay used
  to import nothing outside `node:*` - so what protects the hot path now is
  structural instead: `/v1/fetch` hijacks the reply, and no parser, serializer,
  hook or logger reads the body, the credentials in `X-Relay-Meta`, or the
  response stream.
- **Fastify's logger stays off.** It logs every request by default, and a pino
  logger is invisible to a `console.*` grep. `verify:relay` asserts `logger: false`.
- **No compression or buffering middleware.** Streamed replies must arrive
  progressively; a buffering layer turns streaming chat into a long pause followed
  by a wall of text.
- **Never disable certificate verification.** A hostile proxy is on the path, and
  certificate checking is exactly what defends against it.

## Why the design is this small

Because TLS is terminated here rather than at the edge, Node's own stack does the
work:

```
tunnel (Duplex over WebSocket)
  -> tls.connect({ socket: tunnel })      inner TLS, to the provider
  -> http.request({ createConnection })   HTTP/1.1 over that
```

Note `http.request`, not `https.request`, even for an `https://` target - the
socket already speaks TLS. The consequence is that **there is no hand-written HTTP
parser anywhere in this project**: no status-line parsing, no chunked decoding, no
trailer handling.

It is also why HTTPS proxies work. The outer TLS (to the proxy) is the Worker's
`connect({ secureTransport: "on" })`, the inner TLS (to the provider) is
`tls.connect` here. Two layers in two runtimes - workerd's `startTls()` is
one-shot and cannot nest them, and nothing here asks it to.

## Keeping in sync with the worker repo

`src/protocol.ts` and `src/crypto.ts` have counterparts in the worker repo. They
were byte-identical twins checked by a file comparison until the worker moved
out; across a repository boundary that is impossible, so the wire format is
pinned by `src/conformance.ts` instead - a frozen sealed dial frame that both
repositories assert they can open with their own key derivation.

If that assertion fails, the two repositories disagree about the wire format. Do
not regenerate the vector to make it pass; find which side changed. A change made
deliberately on both sides is a protocol revision and should bump
`PROTOCOL_VERSION`, which `decodeDialFrame` rejects on mismatch so a
half-upgraded deployment fails loudly rather than behaving strangely.

## Run it

Everything is driven from the repo root - the server is part of the root package
now, and `process.cwd()` must be the repo root either way (vite.config.ts's
plugins resolve against it too).

Settings live in **`config.json`** at the repo root, under its `server` section -
one file for the whole app, client and server. Every key there is overridable by
the environment variable named beside it, and the environment wins.

```bash
npm install
npm run build          # typecheck, client -> dist/, server -> server/dist/relay.cjs

# Use the same relay secret as the deployed worker, plus a running Redis.
# Keep both secrets outside config.json, which is committed to the repository.
export RELAY_SECRET="<the same value the worker was deployed with>"
export REDIS_URL="redis://127.0.0.1:6380"
export REDIS_PASSWORD="<the dedicated Redis password>"
npm start
```

The secret is not generated per deployment - it must **match** the one already
set on the worker (`wrangler secret put RELAY_SECRET` in the inbrowser-relay
repo). A mismatch is not silent: the worker refuses the dial and the user sees
"The relay could not authenticate this request."

Point `WORKER_URL` elsewhere only to use a worker you deployed yourself. It must
use the `wss://` scheme and end in `/v1` - that is the only path the worker
accepts a tunnel on; `/health` is for the Settings test button and everything
else 404s.

Deploying needs `dist/`, `server/dist/relay.cjs`, **`config.json`**, Node 22+,
Redis 7+, and a writable catalog state directory
- **no `node_modules` on the host**, because the server bundle
is self-contained. On a Debian VPS, `../install.sh` does all of this including
Caddy, the firewall, a dedicated Redis service, and a sandboxed app systemd unit.
See [INSTALL-REDIS.md](INSTALL-REDIS.md) for credentials, permissions, memory
limits, recovery, and safe checks. The installer gives the app write access only
to `/var/lib/inbrowser` for catalog snapshots.
`config.json` is read at runtime, so changing a `server` value needs a restart
but not a rebuild.

Run from the repo root: `process.cwd()` is where both `config.json` and the
default `dist/` are resolved from.

It is bundled to **CJS, deliberately**. Fastify's dependency tree does dynamic
`require()`s that esbuild's ESM output cannot satisfy (`avvio` alone fails with
"Dynamic require of node:events is not supported"), and CJS has `require`,
`__dirname` and `__filename` natively, so the whole class of failure disappears
rather than being worked around. The consequence is that nothing in `server/src`
may use top-level `await` or `import.meta.url`.

Requires **Node 22+** for the global `WebSocket`. Development runs the TypeScript
directly via Node's type stripping, which is why every import in `server/src`
carries an explicit `.ts` extension and why none of it may use non-erasable
syntax such as constructor parameter properties.

**Do not run the relay under Bun.** Bun 1.3.14 ignores the custom connection
required by `http.request`, sending requests directly instead of through the
tunnel. The server refuses to start under Bun. Bun may still install packages
and build the app; the systemd `ExecStart` must use a real Node 22+ binary.
On Node, `agent: false` also overrides `createConnection`; leave the agent option
unset. `verify:relay` tests a distinct direct-connection trap and HTTPS over the
tunnel so a successful direct request cannot mask this regression.

Generate the secret once with `openssl rand -hex 32` and give the same value to
both halves. Without it, this returns 503 on every request and the Worker refuses
every dial.

**Deploy behind Cloudflare with proxied DNS.** That hides this host's address from
the public internet as well as from configured proxies, which is the same property
the Worker provides on the egress side.

## API

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, version}`. Lightweight process liveness for operators. |
| `POST /v1/fetch` | The proxied request. Everything descriptive is in the `X-Relay-Meta` header (base64url JSON: target, method, headers, proxy); the body streams through untouched. |
| `GET /v1/suggestions` | Reads the shared, scheduled starter-prompt pool. Never generates prompts on demand. |
| `/v1/free-proxies` and its subroutes | Reads catalog status, search results, best available records, and records selected by existing catalog IDs. Never starts discovery or accepts arbitrary proxy targets for checking. |
| `GET /*` | The built client, with Range and 304 support and cross-origin-isolation headers on every response. Unknown paths fall back to `index.html` - **except** `/v1/`, `/health` and the runtime-asset prefixes, which 404. A missing engine asset answered with HTML reaches the runtime as a wasm module and throws a `CompileError` starting `<!do`, which is a genuinely hard failure to trace. |

`X-Relay-Meta` is a header rather than query parameters because the payload
carries the user's proxy credentials, and query strings get written to request
logs, browser history and anything in between. One header also keeps the CORS
preflight to `content-type, x-relay-meta`.

The response mirrors the provider's status and headers, so the browser's own
`fetch` yields a correct `Response` with a streaming body and nothing has to be
synthesized on the client.

Failures generated by the relay itself use HTTP **503**,
`Cache-Control: no-store`, and `{error: string, code: string}`. Keep this distinct
from a provider response: the provider's own status and body are still mirrored.
Cloudflare's default error-page handling can replace origin 502/504 bodies,
discarding our actionable JSON, while 503 is exempt. Origin Error Page Pass-thru
is Enterprise-only; see [Cloudflare Custom Errors](https://developers.cloudflare.com/rules/custom-errors/).
`RELAY_DEBUG_LOG=1` emits non-identifying `relay_failure` events with a `site`
of `tunnel_open` or `forward` (previously named `relay_502`).

When diagnosing a bare Cloudflare error, correlate its `CF-RAY` with the origin
access log before concluding the origin was unreachable. A 502 error page can
replace an otherwise valid JSON response. Preserve the Caddy log filter that
deletes `request>headers>X-Relay-Meta`; that header contains proxy credentials.

## Limits

| Setting | Default | Env |
|---|---|---|
| Rate limit | 120 req/min per client | `RATE_LIMIT_PER_MINUTE` |
| Max body | 32 MiB | `MAX_BODY_BYTES` |
| Provider timeout | 120 s | - |

Rate limits use atomic Redis counters shared across workers. Each counter expires
after its one-minute window. Keys use an HMAC derived from the relay secret rather
than a raw visitor IP; the app still processes the client address to compute the
counter key. These counters are operational state, not conversation history.

If Redis is unavailable, new proxy requests fail with 503 instead of bypassing
shared admission controls. Already established streams continue; Redis is not
consulted for each stream chunk. Catalog reads report unavailability rather than
starting a browser or server scan.

## Scheduled public proxy catalog

`config.json` controls the interval at
`server.freeProxyCatalog.intervalMinutes`, defaulting to 60 minutes. The
`FREE_PROXY_INTERVAL_MINUTES` environment variable overrides it. Restart the app
after changing runtime configuration. Background discovery and validation use
the fixed `relay.inbrowser.tech` Worker, independent of a visitor's relay or
proxy settings. Source searches, repository enumeration, list downloads, and
proxy checks all use this relay path. A deployment needs the compatible Worker
catalog-source endpoint as well as its tunnel endpoint.

Browser catalog requests only read published state. Opening Settings, searching,
loading another page, choosing a best proxy, and resolving saved IDs never start
or accelerate a scan. A Redis lease coordinates background ownership across
workers and processes. A successfully checked record describes a past result;
public proxies can disappear or fail later, and a catalog listing is not a
privacy or availability guarantee.

Redis is an ephemeral shared store in the default installation: RDB snapshots
and AOF are disabled. The server writes public catalog snapshots beneath
`FREE_PROXY_STATE_DIR` (`/var/lib/inbrowser/catalog` with the installer). On
recovery it can restore eligible snapshot records to Redis without network
discovery. A new installation with neither Redis catalog data nor a disk snapshot
runs one initial collection as soon as Redis is available. Before outbound work,
it writes a snapshot marker, even if the catalog is empty. Later restarts, Redis
recovery, and failed or empty initial results use the configured schedule instead
of launching another startup scan. Starter-prompt state is shared through Redis
and generated on its own schedule, independent of visitors.

## Catalog verification and rollout

Run `node --test server/test/*.test.ts` with a disposable Redis 7 instance at
`redis://127.0.0.1:16380`, or set `TEST_REDIS_URL`. Tests isolate their keys and
do not flush the database. `CATALOG_BENCHMARK=1` enables the large catalog
benchmark; allow at least 512 MiB for that disposable instance. The separate
memory-pressure test requires its own disposable Redis process and the explicit
opt-in variables documented in `test/redis-memory-pressure.test.ts`.

Deploy the compatible Worker first and verify its `/health` response includes
`catalog: true`. Then copy the local, gitignored `install.sh` to the Debian host
and provision its dedicated Redis service before starting this backend build.
Keep the existing relay secret consistent between the Worker and app. Verify
authenticated Redis readiness and the app's health. A new installation performs
its initial collection automatically, followed by the configured interval
boundaries. Public catalog requests cannot force either run.

Before rolling back the app, preserve the catalog snapshot directory and Redis
credentials. The Worker additions tolerate ordinary existing relay requests,
so they can remain deployed while the app is rolled back.
