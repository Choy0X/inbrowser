<div align="center">
  <img src="public/icon-192.png" width="88" height="88" alt="InBrowser logo">
  <h1>InBrowser</h1>
  <p><strong>The whole AI stack, in one browser tab.</strong></p>
  <p>No account. No API key. No server.</p>
  <p>
    <a href="https://inbrowser.tech"><strong>inbrowser.tech</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#quick-start">Quick start</a>
    &nbsp;&middot;&nbsp;
    <a href="#self-hosting">Self-hosting</a>
    &nbsp;&middot;&nbsp;
    <a href="#faq">FAQ</a>
  </p>
</div>

---

**InBrowser is a free, open-source AI chat app that runs entirely in your browser.** Open the
page and start typing: no signup, no API key, no install. Large language models run locally on
your GPU through WebGPU, twelve programming-language runtimes execute real code inside the tab
via WebAssembly, and autonomous agents work through tasks on their own. Every conversation,
skill, memory and model weight stays in your own browser profile, because there is no backend to
send them to.

It is served by a small Node/Bun server carrying two endpoints. One is an optional proxy relay,
only ever contacted if you configure a proxy yourself. The other serves the starter prompts on
the empty chat screen, which refresh once a day; it receives whether it is morning or evening
where you are and what your selected model can do, and nothing else.

## Contents

- [What it does](#what-it-does)
- [Run an LLM in your browser](#run-an-llm-in-your-browser)
- [Run real code in the tab](#run-real-code-in-the-tab)
- [Agents and skills](#agents-and-skills)
- [Why there is no backend](#why-there-is-no-backend)
- [Privacy and the optional proxy relay](#privacy-and-the-optional-proxy-relay)
- [Quick start](#quick-start)
- [Self-hosting](#self-hosting)
- [How to install](#how-to-install)
- [Development](#development)
- [Browser support](#browser-support)
- [FAQ](#faq)
- [License](#license)

## What it does

| | |
|---|---|
| **Chat with no signup and no API key** | Twelve provider presets ship in Settings: ten hosted, most of them usable with no key at all, plus local models and Chrome's built-in AI. Every keyless preset is checked against the live provider before it ships. |
| **Run models on your own GPU** | 163 models through [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU, plus Chrome's built-in Gemini Nano. Once the weights are cached, a local model needs no key, no quota and no network. |
| **Execute real code** | Python, JavaScript, TypeScript, C, C++, PHP, Ruby, R, Lua, Clojure, SQLite and a WASI shell, all compiled to WebAssembly and running in the tab, with interactive `input()`. |
| **Build autonomous agents** | A bounded plan-act-observe loop with step caps, token budgets and a full step trace. Agents delegate to sub-agents, fan out as a parallel swarm, and keep a persistent workspace. |
| **Install skills** | Agent Skills (`.skill`) packages, installable from any GitHub repository publishing the standard marketplace manifest. Nothing installs unread: the full `SKILL.md` is shown first. |
| **Search, read, generate** | Web search with page reading, document parsing, image generation and editing, video generation, audio transcription. |
| **Automate** | Scheduled prompts that run on a repeating schedule while the tab is open, with full result history. |
| **Remember** | Durable facts carried across conversations, each one queued for your approval before it is saved. |
| **Work offline** | An installable PWA. After the first load the app shell works with no network; a downloaded local model works with no network at all. |
| **Back up and move** | Chats, skills, memories and tasks export as a single zip and re-import elsewhere, merging by ID. Provider API keys are deliberately never included. |

## Run an LLM in your browser

Local inference is the part most people arrive for. Install a model once from the Store and it
runs on your own hardware from then on:

- **163 open models** from the WebLLM catalog, from sub-1B up to roughly 8B parameters, which is
  the practical ceiling of what a browser can address.
- **Weights are cached** in Cache Storage after the first download, so the cost is paid once.
- **No key, no quota, no rate limit**, because there is no service on the other end.
- **Works with the network off** once the model is cached.
- **Chrome's built-in Gemini Nano** needs no download at all, if your Chrome exposes it.

Installed local models appear in the normal model picker alongside hosted ones and inherit the
same routing, failover and capability detection.

> **Requires WebGPU.** See [browser support](#browser-support). If the app reports that WebGPU is
> unavailable, that is your browser or GPU, not the app.

## Run real code in the tab

Twelve runtimes, each compiled to WebAssembly and installed on demand from the Store. The
assistant can execute code in any installed runtime and read back the real result, sandboxed with
a timeout, rather than describing what the code would do.

| Runtime | Engine | Notes |
|---|---|---|
| Python | Pyodide | The scientific stack, in the tab |
| JavaScript / TypeScript | Worker-backed | |
| C / C++ | Real Clang/LLVM compiled to WebAssembly | Compiles and links in the browser with `wasm-ld`; `#include <gmp.h>` works, via a bundled mini-gmp |
| PHP | php-wasm | |
| Ruby | ruby.wasm | |
| R | webR | |
| Lua | wasmoon | |
| Clojure | Scittle | |
| SQLite | sql.js | |
| Shell | WASI | |

Alongside them are eleven utility tool plugins the model can call directly rather than
approximating: regex, text diff and statistics, JSON, CSV, hashing and encoding, ID generation,
JWT decoding, colour and contrast, dates, and unit conversion.

> **Self-hosting note:** the C/C++ toolchain ships `clang.wasm`, a single 42.5 MB file, which
> exceeds the per-file limit on some static hosts (Cloudflare Pages caps at 25 MB). Serving the
> build from a real origin rather than a static host avoids this. See [self-hosting](#self-hosting).

## Agents and skills

An agent is a system prompt, a model policy, a toolset and a bounded loop. Every run has a step
cap, a token budget and an abort signal, and **every stopping reason is reported** rather than
hidden, because an autonomous loop that only shows its conclusion cannot be trusted or debugged.

Agents can delegate to other agents through a depth-capped call tool with a shared scratchpad,
which is how a researcher to writer to critic chain works, or fan work out to several members in
parallel in swarm mode with a per-member trace you can drill into.

Skills are reusable instruction packages in the standard Agent Skills format. Activating one
injects its instructions and enables a bounded two-tool loop so the assistant can read the
skill's own bundled files as it works.

## Why there is no backend

This is not about hosting cost. The free providers InBrowser uses rate-limit **per IP**. Any
shared hop, whether a relay, a CORS proxy or a serverless function, would put every user behind
a single IP, so a handful of requests would exhaust the quota and block everyone at once. Calling
providers straight from the browser makes every rate limit per-user.

Two rules follow, and both are load-bearing:

1. **No shared network hop for provider traffic.** Not for any provider, ever.
2. **A provider must send CORS headers to ship.** If its real chat response carries no
   `Access-Control-Allow-Origin`, the browser cannot read it, so the provider is dropped rather
   than proxied. Two providers were removed for exactly this reason.

You can verify this yourself: open DevTools, go to the Network tab, and confirm that no provider,
search or model-weight request targets InBrowser's own origin. What you will see from this origin
is the app's own files, `/v1/suggestions` for the empty screen's starter prompts, and `/v1/fetch`
if you have configured a proxy.

The starter prompts are the one deliberate exception to the rule above, and they are built so it
does not become a hole in it. The server generates them **once a day for everybody**, on its own
timer, and every request just reads the result out of memory - so the per-IP argument does not
apply: it is one call a day in total, not one per user. No parameter can make it generate, so
traffic cannot become spend, and the providers it generates from are keyless, so there is no API
key on that path to leak. Deployers who want none of it can set `client.suggestionsEnabled` to
`false` in `config.json`.

### Automatic model and proxy routing

Auto balances task suitability, recent reliability, response speed and active requests. It checks
known image and tool support and estimates the full request's context needs, including tool
definitions and output headroom. Unknown catalog metadata lowers confidence; it is never treated
as proof of compatibility.

Selection learns from recent outcomes and time to first token. Old health observations fade,
active requests spread load, and provider cooldowns respect `Retry-After`. Proxy Auto tracks
success per destination independently: a broken connection can try another proxy, while a
provider's authentication or rate-limit response does not mark a working proxy unhealthy.
Cancelled requests do not affect health, and a partial answer never restarts on a different
route. Manual model choices and proxy list order stay user-controlled.

Capability and quality estimates are heuristics, not measured answer-quality benchmarks, and
routing statistics live in memory for the current tab only.

## Privacy and the optional proxy relay

Conversations live in IndexedDB, settings and API keys in localStorage, agent workspaces in OPFS,
and model weights in Cache Storage. All of it stays in your browser profile.

One feature does not fit the no-backend rule, and it is opt-in. If you configure a real proxy in
Settings, InBrowser cannot dial it from the page, because browsers do not speak HTTP CONNECT or
SOCKS. Those requests go through a relay instead:

```
browser -> relay (server/) -> Cloudflare Worker -> your proxy -> provider
```

This is the opposite of a shared hop rather than an example of one: the address the provider sees
is *the proxy you chose*, which moves you off the shared pool instead of onto it. The Worker
exists because whatever dials a proxy reveals its IP to whoever runs that proxy, and you can
point InBrowser at a proxy you control yourself. It is maintained separately, in
[**inbrowser-relay**](https://github.com/Choy0X/inbrowser-relay).

The two halves see very different things, and it is worth being exact:

- The **Worker** sees nothing readable. Your proxy's address and credentials are AES-256-GCM
  sealed before they reach it, and the rest is the encrypted connection to the provider.
- The **relay** does see your requests, including API keys, because it is what establishes that
  connection on your behalf. Whichever machine builds the request necessarily sees what is in it.
  It keeps no logs and writes nothing to disk, and the
  relay address is a setting, so you can point it at one you run yourself.

With no proxy configured, none of this is contacted and nothing changes.

Settings > Proxies also has **Allow unverified connections for all proxies**, off by default.
Unverified connections can expose API keys and messages to proxy operators; enable it only if you
trust every proxy you use.

## Quick start

```bash
git clone https://github.com/Choy0X/Inbrowser.git
cd Inbrowser
npm install
npm run dev        # app + relay on http://localhost:5173, one process
```

`npm run dev` runs the same server as production with Vite mounted inside it, so dev and
production route identically: a path that works in one cannot 404 in the other. Server edits
restart the process; client edits hot-reload.

## Self-hosting

```bash
npm run build      # typecheck, client build to dist/, server bundle
npm start          # the built app on http://localhost:4173
```

Deploying is `dist/`, `server/dist/relay.cjs`, `config.json` and a runtime. The server bundle is
self-contained, so there is no `node_modules` on the host. It runs under **Node 22+ or Bun**.

Everything configurable lives in one file, **`config.json`** at the repo root: brand strings, a
few client defaults, and the server's settings including the relay secret. Its `server` section
is never compiled into the browser bundle, and every key there can be overridden by an
environment variable, which is how to set the real secret, since the file itself is committed.

### Deployment notes

The app is a static `dist/` plus a single-file server, so any setup that can serve one and run
the other will work. Two things are worth knowing before you size it:

**Put a CDN in front.** `dist/` is **311 MB**, most of it WebAssembly language runtimes, and
without an edge cache every cold visitor pulls all of it from your origin. If you use Cloudflare,
note that it does not cache `.wasm`, `.tar` or `.pch` by default, so those need an explicit cache
rule. Fronting the origin also keeps its address out of the open.

**Run the server as an unprivileged service.** It terminates TLS to providers when a user has
configured a proxy, so it should be sandboxed like anything else handling credentials: its own
user, no write access outside its own directory, and a reverse proxy terminating public TLS in
front of it.

## How to install

The section above covers the shape of a deployment. This is the full recipe the production
instance actually runs, end to end, on a fresh **Debian** VPS (x86_64 or aarch64) behind
**Cloudflare**, with **inbrowser-relay** (the proxy egress Worker) deployed alongside it. Adapt
package names and unit files if you're on a different distribution; the sequence itself doesn't
change.

**Before you start, you'll need:**

- A Debian VPS with root access, at least ~4 GB of RAM+swap free (the client build holds the
  whole module graph plus multi-megabyte Monaco/WebLLM chunks in memory) and ~10 GB free disk
  for the build (`node_modules` alone is roughly 2.1 GB, `dist/` about 300 MB).
- **Node.js 22+** already on the box. The production server runs under Node; the build tool
  (Bun) is installed separately in step 5 and never runs the app itself.
- A domain on **Cloudflare**, with an **Origin Certificate** for it: Cloudflare dashboard,
  SSL/TLS > Origin Server > Create Certificate. Keep the certificate and private key handy;
  you'll copy them to the box in step 9. This only works with SSL/TLS mode set to **Full
  (strict)** (see step 13), because an Origin Certificate is trusted by Cloudflare, not by
  browsers directly.
- A [Cloudflare account](https://dash.cloudflare.com) with Workers enabled, for **inbrowser-relay**.

### 1. Generate the shared relay secret, and deploy the Worker

The app and the Worker authenticate each other with one shared secret. Generate it once, before
either side is deployed:

```bash
openssl rand -hex 32
```

Keep the output. Then, from a clone of
[**inbrowser-relay**](https://github.com/Choy0X/inbrowser-relay):

```bash
npm install
npx wrangler secret put RELAY_SECRET     # paste the value you generated above
npx wrangler deploy
```

Before deploying, set `ALLOWED_ORIGINS` in the Worker's `wrangler.toml` to your app's real
domain (comma-separated; a bare host, a full origin, or a `*.` wildcard all work). Note the
Worker's resulting URL: you'll point the app at `wss://<that-worker>/v1` in step 6. Full detail
on this half, including what it can and can't see, lives in
[inbrowser-relay's own README](https://github.com/Choy0X/inbrowser-relay#deploy).

### 2. Get the app onto the server

```bash
git clone https://github.com/Choy0X/Inbrowser.git /opt/inbrowser
cd /opt/inbrowser
```

Any path works; the rest of this guide assumes `/opt/inbrowser`.

### 3. System packages

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring \
  apt-transport-https ufw fail2ban unattended-upgrades openssl iproute2 redis-server redis-tools
```

**Redis 7 or newer is required** (check with `redis-server --version`). It backs the proxy
catalog cache (step 7), on its own dedicated instance, not the system default.

**Caddy** (TLS termination, step 9) isn't in Debian's default repos:

```bash
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

If total RAM+swap is under ~4 GB, add 2 GB of swap before building, or the build is likely to be
OOM-killed:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl -w vm.swappiness=10
```

### 4. Create a dedicated service user

Neither the build nor the running service should run as root:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin inbrowser
sudo chown -R inbrowser:inbrowser /opt/inbrowser
```

### 5. Install Bun, and build

Bun is a build tool only here; pin a version so a later Bun release can't change the build
under a redeploy:

```bash
curl -fsSL https://bun.sh/install | BUN_INSTALL=/tmp/bun bash -s 'bun-v1.3.14'
sudo install -m 0755 /tmp/bun/bin/bun /usr/local/bin/bun
```

Then build as the service user, not root, with the JS heap raised to most of the box's RAM (the
default ceiling is well under total RAM regardless of how much is actually free, and Rollup
needs the room for the Monaco/WebLLM chunks):

```bash
sudo -u inbrowser bash -c '
  cd /opt/inbrowser
  export NODE_OPTIONS="--max-old-space-size=$(( $(awk "/MemTotal/{print int(\$2/1024)}" /proc/meminfo) * 3 / 4 ))"
  bun install --frozen-lockfile
  bun run build
'
```

Confirm it actually produced both halves: `dist/index.html` (client) and
`server/dist/relay.cjs` (server). `--frozen-lockfile` fails if `bun.lock` doesn't describe
exactly what `package.json` asks for (usually a dependency added and installed with npm
instead of Bun). Fix that by running `bun install` from a checkout and committing the updated
lockfile; don't drop `--frozen-lockfile` on the server as the fix.

### 6. Configure the relay secret on this server

This has to be the **exact same value** generated in step 1: a mismatch isn't visible as an
error; the server starts fine and users see "The relay could not authenticate this request."

```bash
sudo install -d -m 0700 /etc/inbrowser
printf 'RELAY_SECRET=%s\n' '<the value from step 1>' | sudo tee /etc/inbrowser/relay.env
sudo chmod 0600 /etc/inbrowser/relay.env
```

Also point the app at the Worker from step 1 by setting `server.workerUrl` in `config.json` to
`wss://<your-worker>/v1` (this isn't a secret, so it's fine committed), or override it with a
`WORKER_URL` environment variable in the systemd unit below instead.

### 7. Set up a dedicated Redis cache

A separate authenticated instance on its own port, so it can't collide with any other use of the
system default on 6379, and so its cache data (proxy-catalog snapshots, not user data) never
needs the durability a general-purpose Redis would default to:

```bash
REDIS_PASSWORD=$(openssl rand -hex 32)
sudo install -d -m 0750 -o root -g redis /etc/inbrowser-redis

sudo tee /etc/inbrowser-redis/redis.conf > /dev/null <<EOF
bind 127.0.0.1
port 6380
protected-mode yes
requirepass ${REDIS_PASSWORD}
daemonize no
supervised no
databases 1
save ""
appendonly no
maxmemory 1024mb
maxmemory-policy noeviction
EOF
sudo chmod 0640 /etc/inbrowser-redis/redis.conf
sudo chown root:redis /etc/inbrowser-redis/redis.conf

printf 'REDIS_URL=redis://127.0.0.1:6380\nREDIS_PASSWORD=%s\nREDIS_KEY_PREFIX=inbrowser:v1:\n' \
  "$REDIS_PASSWORD" | sudo tee /etc/inbrowser/redis.env > /dev/null
sudo chmod 0600 /etc/inbrowser/redis.env
```

Give it a systemd unit of its own (`/etc/systemd/system/inbrowser-redis.service`):

```ini
[Unit]
Description=InBrowser dedicated Redis cache
After=network.target

[Service]
Type=simple
User=redis
Group=redis
ExecStart=/usr/bin/redis-server /etc/inbrowser-redis/redis.conf
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now inbrowser-redis
redis-cli -h 127.0.0.1 -p 6380 -a "$REDIS_PASSWORD" PING   # expect PONG
```

### 8. Create the systemd service for the app

`/etc/systemd/system/inbrowser.service`:

```ini
[Unit]
Description=InBrowser
After=network-online.target inbrowser-redis.service
Wants=network-online.target inbrowser-redis.service

[Service]
Type=simple
User=inbrowser
Group=inbrowser

# config.json and dist/ are resolved against the working directory, and a wrong
# one fails silently - every setting just falls back to its default.
WorkingDirectory=/opt/inbrowser

# Without this the server takes its dev branch and imports vite, which isn't in
# the production bundle.
Environment=NODE_ENV=production
Environment=PORT=4173
EnvironmentFile=-/etc/inbrowser/relay.env
EnvironmentFile=/etc/inbrowser/redis.env

ExecStart=/usr/bin/node /opt/inbrowser/server/dist/relay.cjs
Restart=always
RestartSec=2

# Four workers rather than one process: a garbage-collection pause on a single
# process would stall every live streamed reply at once.
Environment=CLUSTER_WORKERS=4

# Baseline sandboxing. RestrictAddressFamilies needs AF_NETLINK (Fastify's own
# listen-address logging enumerates network interfaces) and AF_UNIX (node:cluster's
# primary/worker IPC) alongside the obvious AF_INET/AF_INET6, or the service
# crash-loops while still reporting "active".
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
StateDirectory=inbrowser
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now inbrowser
```

### 9. Terminate TLS with Caddy

Copy the Origin Certificate and key from the prerequisites onto the box (`scp`, a pasted file,
however you prefer) and install them where Caddy can read them:

```bash
sudo install -m 0640 -o root -g caddy origin.pem /etc/caddy/origin.pem
sudo install -m 0640 -o root -g caddy origin.key /etc/caddy/origin.key
```

`/etc/caddy/Caddyfile`:

```caddyfile
your-domain.com {
	# An Origin Certificate is trusted only by Cloudflare, and Caddy's automatic
	# HTTPS (ACME) can't succeed behind the proxy anyway - naming the files here
	# disables it for this site, which is what we want.
	tls /etc/caddy/origin.pem /etc/caddy/origin.key

	# Strip the header that can carry a configured proxy's credentials before it
	# ever reaches the access log.
	log {
		format filter {
			wrap json
			request>headers>X-Relay-Meta delete
		}
	}

	reverse_proxy 127.0.0.1:4173 {
		# A streamed chat reply must not be buffered.
		flush_interval -1
	}
}

# Every subdomain redirects to the apex. Needs its own Cloudflare DNS record
# (proxied) per subdomain to ever be reached at all - see step 13.
*.your-domain.com {
	tls /etc/caddy/origin.pem /etc/caddy/origin.key
	redir https://your-domain.com{uri} permanent
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

### 10. Lock down the firewall

Allow SSH **before** anything else is denied, or you lock yourself out:

```bash
sudo ufw allow 22/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
```

Restrict 443 to Cloudflare's own published ranges: this is what actually stops the origin being
reached directly, bypassing TLS.

```bash
for range in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$range" to any port 443 proto tcp
done
sudo ufw --force enable
```

Port 4173 is closed to the outside by the default-deny above; that's what keeps the app from
being reachable without TLS in front of it.

### 11. Basic hardening

Security-only automatic updates, reboot left manual (an unattended reboot of a single-box
deployment is an outage nobody scheduled):

```bash
sudo tee /etc/apt/apt.conf.d/51inbrowser-unattended > /dev/null <<'EOF'
Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Automatic-Reboot "false";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
```

fail2ban for sshd (the only service exposed to the whole internet, since 443 is Cloudflare-only):

```bash
sudo tee /etc/fail2ban/jail.d/inbrowser.local > /dev/null <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
EOF
sudo systemctl enable --now fail2ban
```

**Deliberately not covered:** sshd itself is left alone. If you harden it (`PasswordAuthentication
no`, `PermitRootLogin prohibit-password`), verify a second session logs in successfully before
closing the one you have.

### 12. Verify

```bash
systemctl is-active inbrowser inbrowser-redis
curl -s http://127.0.0.1:4173/health                       # expect {"ok":true,...}
curl -sI http://127.0.0.1:4173/ | grep -i cross-origin      # COOP/COEP must both be present
```

Missing COOP/COEP means `crossOriginIsolated` is false in the browser, which silently breaks
`SharedArrayBuffer` and interactive Python `input()`. If `/health` doesn't answer, check
`journalctl -u inbrowser -n 50 --no-pager`.

### 13. Finish up in the Cloudflare dashboard

Nothing after this point can be scripted from the box itself:

1. **DNS.** An A record for your domain pointing at this server, **proxied** (orange cloud).
   Add `www` (and any other subdomain) the same way: the Caddyfile redirects every subdomain to
   the apex, but only for names that actually resolve and are proxied; a grey-cloud record
   points at an IP the firewall drops.
2. **SSL/TLS mode: Full (strict).** An Origin Certificate is trusted nowhere else.
3. **Cache rules for the runtime assets.** Cloudflare doesn't cache `.wasm`, `.tar` or `.pch` by
   default, so without a rule every cold visitor pulls the full WebAssembly runtime set (~300 MB)
   from your origin instead of the edge. Add a cache rule matching
   `/pyodide/* /php/* /ruby/* /r/* /cpp/* /assets/* /monacoeditorwork/*` that respects the
   origin's TTL.
4. **Always Use HTTPS: on.** Port 80 is closed on the origin.

### Operating it

```bash
systemctl status inbrowser
systemctl status inbrowser-redis
journalctl -u inbrowser -f
```

To update: pull as the service user, rebuild, restart.

```bash
sudo -u inbrowser git -C /opt/inbrowser pull
sudo -u inbrowser bash -c 'cd /opt/inbrowser && bun install --frozen-lockfile && bun run build'
sudo systemctl restart inbrowser
```

## Development

```bash
npm run dev               # app + relay on one port, Vite in middleware mode
npm run build             # typecheck, client build, server bundle
npm run typecheck:server  # the server half on its own
npm start                 # serve the build
```

The stack is React 18, TypeScript, Vite 6 and Tailwind on the client, and Fastify on the server
with a deliberately short dependency allowlist, since that process terminates TLS to providers.
Routes are pre-rendered to static HTML at build time, so every URL serves real content to
crawlers and to anything that does not execute JavaScript.

`npm run build` typechecks both halves before it emits anything, so a type error fails the build
rather than shipping.

## Browser support

| | Local models (WebGPU) | Everything else |
|---|---|---|
| Chrome / Edge 113+ | Yes | Yes |
| Firefox 141+ (Windows) | Yes | Yes |
| Safari 26+ | Yes | Yes |
| Older browsers | No | Yes |

Hosted providers, code runtimes, agents and skills work in any modern browser. Only local model
inference needs WebGPU.

## FAQ

**Is it really free?**
Yes, and there is no paid tier. The hosted providers it ships with are free services with their
own rate limits; local models have no limits at all because nothing is being called.

**Do I need an API key?**
No. You can add your own keys for providers that need them, and they stay in your browser, but
the app is usable without any.

**Does my data leave my browser?**
Your conversations, files and settings do not. Provider requests obviously reach the provider you
chose, called directly from your browser. The one exception is the opt-in proxy relay described
[above](#privacy-and-the-optional-proxy-relay), which the privacy policy states plainly.

**How big is the model download?**
It depends on the model. The catalog spans roughly 300 MB to several GB, shown per model in the
Store before you install. It is a one-time cost per model.

**Can it work completely offline?**
Yes, once the app shell is installed as a PWA and at least one local model is cached.

**How does this compare to Ollama or LM Studio?**
Those are desktop applications and will run larger models faster, because they are not bound by
what a browser can address. InBrowser needs no install and no admin rights, runs on a locked-down
or managed device, and puts code execution, agents and skills in the same tab as the model.

**Can I self-host it?**
Yes, for yourself. Note the license below before hosting a public instance.

## License

See [LICENSE](./LICENSE): free to clone, use and modify with attribution to **Choy0X**;
publishing or hosting a public instance is reserved to the author.

Bundled third-party components keep their own licenses, notably a GPL-2.0 `busybox.wasm` binary
and several GPL/LGPL npm packages used by the PHP and filesystem runtimes. See LICENSE for
details.

---

<div align="center">
  <sub>
    Built by <a href="https://github.com/Choy0X">Choy0X</a> &middot;
    <a href="https://inbrowser.tech">inbrowser.tech</a> &middot;
    Proxy egress Worker: <a href="https://github.com/Choy0X/inbrowser-relay">inbrowser-relay</a>
  </sub>
</div>
