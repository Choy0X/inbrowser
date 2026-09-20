import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import monacoEditorModule from "vite-plugin-monaco-editor";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { VitePWA } from "vite-plugin-pwa";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import appConfig from "./config.json";
import { deriveBrand } from "./src/lib/brandDerive";
import {
  SEO_CHAT_PREFIX,
  SEO_NOT_FOUND_PATH,
  SEO_ROUTES,
  indexableRoutes,
  seoRouteFor,
  type SeoRoute,
} from "./src/lib/seo/routeTable";
import { injectSeo, type ShellChangelogEntry } from "./src/lib/seo/renderShell";

/**
 * @php-wasm's Emscripten glue does `import dependencyFilename from
 * "*.wasm?import"`, then only ever uses that value as a STRING passed to
 * locateFile() - it wants a URL, not an instantiated module. Whatever
 * bundler @php-wasm/web was built against treats `?import` as shorthand for
 * "resolved URL string", but Vite reserves literal `?import` for the real
 * WebAssembly/ESM-integration proposal (statically resolving the wasm
 * binary's own imports as ES modules) - unsupported here, and not actually
 * what this package needs.
 *
 * Worse: @php-wasm/web's own top-level dispatcher (getPHPLoaderModule)
 * dynamically imports EVERY PHP version's glue module with a literal string
 * path, for a version-selection switch that only matters at runtime - but
 * dynamic imports with literal paths are still statically discoverable, so
 * Rollup's build graph pulls in all of web-7-4 through web-8-5, each with
 * their own broken wasm import, even though only 8.5 is ever used. Neither a
 * `load` nor a `transform` hook here was observed to affect the actual
 * dev-server response or Rollup's build graph for these files (confirmed via
 * a crash deliberately introduced mid-debugging: the hook fires, but its
 * returned code has no visible effect on either pipeline) - a real mystery
 * this session's time didn't fully explain, not a "did not investigate"
 * shortcut.
 *
 * The robust fix instead: physically patch just the one PHP version this app
 * actually uses (8.5, both engine variants) directly on disk in
 * node_modules, replacing the broken import with a hardcoded string constant
 * pointing at this app's own self-hosted copy (see RUNTIME_ASSET_CONFIGS) -
 * before Vite/Rollup ever starts resolving anything, so there is no import
 * statement left for any wasm-handling plugin to trip on, and this app's own
 * code (phpWorker.ts) calls @php-wasm/universal's loadPHPRuntime() directly
 * with the patched module, bypassing @php-wasm/web's all-versions dispatcher
 * entirely - so Rollup's build graph never discovers (and never needs to
 * successfully load) the other, unused PHP versions at all.
 */
const PHP_GLUE_VARIANTS = [
  { variant: "jspi", version: "8_5_10" },
  { variant: "asyncify", version: "8_5_10" },
] as const;

function patchPhpWasmGluePlugin(): Plugin {
  const patch = () => {
    for (const { variant, version } of PHP_GLUE_VARIANTS) {
      const path = join(
        process.cwd(),
        "node_modules/@php-wasm/web-8-5",
        variant,
        "php_8_5.js"
      );
      let code: string;
      try {
        code = readFileSync(path, "utf-8");
      } catch {
        continue; // package not installed - not this plugin's concern
      }
      // The real source has no query string at all - `?import` only ever
      // appeared in Vite's own dev-server-served/rewritten output, which is
      // Vite's own convention for "this bare `.wasm` import is a real ESM
      // WebAssembly-integration import" (a Vite feature, not anything the
      // package's source actually wrote) - it's added *during* Vite's
      // internal rewriting, invisible to any hook operating on source text,
      // which is what made every earlier load/transform-hook attempt here a
      // no-op despite visibly firing.
      const importLineRe = /^import dependencyFilename from '\.\/[^']*\.wasm';$/m;
      if (!importLineRe.test(code)) continue; // already patched, or upstream changed shape
      const selfHostedPath = `/php/${variant}/${version}/php_8_5.wasm`;
      const patched = code.replace(importLineRe, `const dependencyFilename = ${JSON.stringify(selfHostedPath)};`);
      writeFileSync(path, patched);
    }
  };
  return {
    name: "patch-php-wasm-glue",
    enforce: "pre",
    // Fires for both `vite dev` and `vite build`, before either starts
    // resolving/crawling modules - the files are correct on disk by the time
    // anything tries to import them, so no resolveId/load/transform
    // interception is needed at all.
    buildStart() {
      patch();
    },
  };
}

// The CJS build of vite-plugin-monaco-editor exposes its factory at `.default`.
const monacoEditorPlugin = (
  (monacoEditorModule as unknown as { default?: () => Plugin }).default ??
  (monacoEditorModule as unknown as () => Plugin)
);


/**
 * Runtime-fetched language-engine assets (self-hosted, never a CDN — see each
 * plugin's install(), e.g. pythonPlugin.ts). Each entry is downloaded lazily
 * (via Cache Storage, one bucket per language) rather than bundled inline, and
 * excluded from the PWA precache below (see RUNTIME_ASSET_BASE_PATHS) so a
 * user who never installs, say, Ruby never downloads its ~30 MB.
 *
 * Only started with Pyodide (the "stdlib-only v1" set: no `.whl` files, no
 * dev-only `.d.ts`/`console*.html`/source maps); generalized here so adding a
 * language's self-hosted assets is a data entry, not copy-pasted plumbing.
 * A package that Vite can bundle directly into its worker's own chunk (Lua,
 * SQLite, TypeScript, Clojure) needs no entry here at all — this list is only
 * for engines whose assets are too large to inline and must be fetched at
 * runtime from this app's own origin.
 */
interface RuntimeAssetConfig {
  /** Also the manifest filename prefix, e.g. "pyodide" -> pyodide-manifest.json. */
  id: string;
  /** Source directory under node_modules, e.g. "pyodide" or "@ruby/4.0-wasm-wasi/dist". */
  srcDir: string;
  /** Destination directory under the site root, e.g. "pyodide" -> served at /pyodide/. */
  destDir: string;
  files: string[];
}

const RUNTIME_ASSET_CONFIGS: RuntimeAssetConfig[] = [
  {
    id: "pyodide",
    srcDir: "pyodide",
    destDir: "pyodide",
    // pyodide.mjs itself is NOT listed here — it's imported as a normal npm
    // package and bundled into pyodideWorker's own chunk by Vite; only the
    // assets Pyodide fetches at runtime via `indexURL` need to live here.
    //
    // No `.whl` files, and the npm package ships none: the full set is ~250 MB.
    // pyodide-lock.json IS here, so Pyodide knows all ~356 packages exist and
    // would resolve each one against indexURL and 404. The wheels instead come
    // from a version-pinned CDN via `packageBaseUrl` — set in pyodideWorker.ts,
    // explained in lib/python/packages.ts — with their integrity checked
    // against the sha256 in this very lock file.
    files: ["pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide-lock.json", "python_stdlib.zip"],
  },
  {
    id: "php",
    srcDir: "@php-wasm/web-8-5",
    destDir: "php",
    // Both engine variants are self-hosted because the package picks between
    // them itself, at runtime, via a JSPI feature check (see phpWorker.ts) -
    // this app can't know in advance which one a given user's browser needs.
    files: ["jspi/php_8_5.js", "jspi/8_5_10/php_8_5.wasm", "asyncify/php_8_5.js", "asyncify/8_5_10/php_8_5.wasm"],
  },
  {
    id: "ruby",
    srcDir: "@ruby/4.0-wasm-wasi/dist",
    destDir: "ruby",
    // ruby+stdlib.wasm (not the smaller stdlib-less ruby.wasm, and not the
    // ~53MB debug+stdlib build) - rubyWorker.ts fetches and compiles it
    // directly itself, with no import-statement involved at all, unlike PHP.
    files: ["ruby+stdlib.wasm"],
  },
  {
    id: "r",
    srcDir: "webr/dist",
    destDir: "r",
    // Only the boot-critical core (~20MB) is tracked for the install
    // progress bar / Cache Storage manifest. webR also ships ~130 small
    // per-R-package data files (help/doc/translations/... .data.gz, each
    // lazily fetched by R's own package loader only when that specific
    // functionality is actually used) - those are still self-hosted (see the
    // separate broad copy target below, for the same /r/ path) so R's own
    // lazy-loading finds them on this app's own origin same as it would on
    // its default CDN, just not part of what "installed" tracks or shows
    // progress for; ordinary HTTP caching covers them well enough given how
    // small and rarely any single one changes.
    files: ["R.wasm", "R.js", "webr-worker.js", "libRblas.so", "libRlapack.so"],
  },
  {
    id: "cpp",
    srcDir: "browsercc/dist",
    destDir: "cpp",
    // A real Clang/LLVM 20 toolchain (clang + wasm-ld + a wasi-libc/libc++
    // sysroot), serving BOTH the C and the C++ runtimes - see
    // lib/plugins/clangPlugin.ts for the shared C / C++ store plugin.
    // The file list is exhaustive: clang.js/lld.js are the only
    // things index.js imports, and clang.wasm/lld.wasm/sysroot.tar/
    // stdc++.h.pch are the only URLs any of the three ever fetches
    // (verified by grepping every `new URL(`/`fetch(`/`from "` literal in
    // them). Miss one and it 404s into the SPA fallback, surfacing as a
    // WebAssembly CompileError whose first bytes are `<!do` - the same trap
    // documented for wasi-sh further down this file.
    //
    // stdc++.h.pch is 18.5MB of the ~113MB total and is pure latency
    // insurance: `#include <bits/stdc++.h>` IS a real header in this sysroot
    // so it compiles without the PCH, it just costs 8-20s of front-end time
    // on every single run. It is only valid for the exact flag triple
    // `-O2 -std=c++20 -fno-exceptions`, which is why clangToolchain.ts pins
    // precisely that for C++.
    files: [
      "index.js",
      "clang.js",
      "clang.wasm",
      "lld.js",
      "lld.wasm",
      "sysroot.tar",
      "stdc++.h.pch",
    ],
  },
];

const RUNTIME_ASSET_BASE_PATHS = RUNTIME_ASSET_CONFIGS.map((c) => `/${c.destDir}/`);

// Workbox serializes matchers into sw.js without their enclosing config scope.
// Embed the paths at build time so the emitted functions are self-contained.
function runtimeAssetMatcher(runtimeAssets: boolean) {
  const isRuntimeAsset = `${JSON.stringify(RUNTIME_ASSET_BASE_PATHS)}.some((p) => url.pathname.startsWith(p))`;
  return new Function(
    "{ url, sameOrigin }",
    `return sameOrigin && ${runtimeAssets
      ? isRuntimeAsset
      : `/\\.(?:js|css|woff2?)$/.test(url.pathname) && !${isRuntimeAsset}`};`,
  ) as (context: { url: URL; sameOrigin: boolean }) => boolean;
}

// Derived by the same function the browser bundle calls (src/lib/appConfig.ts),
// so the page head and the app cannot disagree about the title or the origin.
// These five used to be spelled out here and again in appConfig.ts.
const BRAND = deriveBrand(appConfig.app);

const HTML_BRAND_VARS: Record<string, string> = {
  __APP_NAME__: BRAND.name,
  __APP_TITLE__: BRAND.title,
  __APP_URL__: BRAND.url,
  __APP_DESCRIPTION__: BRAND.description,
  __APP_OG_IMAGE__: BRAND.ogImage,
};

/**
 * index.html is static markup, not a module, so it can't `import` from
 * config.json the way the rest of the app does. This fills in the
 * `__APP_*__` placeholders index.html carries instead - same values, one
 * source - on every dev request and in the production build.
 */
function htmlBrandPlugin(): Plugin {
  return {
    name: "html-brand-vars",
    transformIndexHtml(html) {
      return Object.entries(HTML_BRAND_VARS).reduce(
        (out, [token, value]) => out.replaceAll(token, value),
        html,
      );
    },
  };
}


/** The faces used for body text and for every button label, latin subset. */
const PRELOAD_FONT_PATTERNS = [/^inter-latin-wght-normal-.*\.woff2$/, /^jetbrains-mono-latin-400-normal-.*\.woff2$/];

function withFontPreloads(html: string, outDir: string): string {
  let names: string[];
  try {
    names = readdirSync(join(outDir, "assets"));
  } catch {
    return html;
  }
  const tags = PRELOAD_FONT_PATTERNS.map((pattern) => names.find((n) => pattern.test(n)))
    .filter((n): n is string => Boolean(n))
    .map((n) => `    <link rel="preload" as="font" type="font/woff2" href="/assets/${n}" crossorigin />`)
    .join("\n");
  if (!tags) return html;
  return html.replace("</head>", `${tags}\n  </head>`);
}

/** Every /assets/ URL the document itself references: entry, preloads, css, fonts. */
const BOOT_ASSET_URLS = /(?:src|href)="(\/assets\/[^"]+)"/g;

/**
 * Fills index.html's `__BOOT_BYTES__` token with the total uncompressed size
 * of everything the document pulls before it can render - the entry chunk, its
 * modulepreloads, the stylesheet and the two preloaded faces. The boot overlay
 * divides by it to turn the resource timeline into a real percentage.
 *
 * Uncompressed on purpose. The overlay counts `decodedBodySize`, which stays
 * populated on a warm cache hit where `transferSize` is 0; measuring the wire
 * instead would need a compressed denominator, and Cloudflare - not this build
 * - decides what that is, so the bar would stall at roughly a third.
 *
 * Only knowable here: the hashed names are decided by the bundle, and
 * withFontPreloads has only just added the two font tags. In dev the token is
 * never substituted, which is what makes the overlay fall back to a plain
 * skeleton - see the boot script in index.html.
 */
function withBootBytes(html: string, outDir: string): string {
  const counted = new Set<string>();
  let total = 0;
  for (const [, url] of html.matchAll(BOOT_ASSET_URLS)) {
    if (counted.has(url)) continue;
    counted.add(url);
    try {
      total += statSync(join(outDir, url.slice(1))).size;
    } catch {
      // A referenced file that is not on disk would otherwise abort the build
      // over a progress bar. Skipping it only biases the total low, and the
      // overlay clamps at 100%.
    }
  }
  return html.replaceAll("__BOOT_BYTES__", String(total));
}

/**
 * Per-route HTML, robots.txt, sitemap.xml and llms.txt.
 *
 * The app is a client-only SPA, so before this existed every URL served the
 * same `dist/index.html` with an empty `<body>`: one title, one description,
 * and a canonical hardcoded to the homepage on all nine routes. A crawler saw a
 * blank page and was told every page was really the homepage.
 *
 * This emits one real document per route instead. Both paths below call the
 * SAME `injectSeo`, which is what makes `npm run dev` and `npm start` return
 * identical HTML for a given URL - they used to differ, because dev ran a Vite
 * transform pipeline and production read a file straight off disk:
 *
 *   - DEV: `transformIndexHtml` receives the real request URL as `ctx.path`,
 *     because server/src/dev.ts calls `vite.transformIndexHtml(request.url, …)`.
 *   - BUILD: `closeBundle` reads the finished `dist/index.html` - which already
 *     carries the hashed script and stylesheet references and the PWA manifest
 *     link - and rewrites only what is between the markers for each other
 *     route. Deriving every shell from that one file is why no shell can ever
 *     reference a stale bundle.
 *
 * `order: "post"` and the plugin's position after pwaPlugin() matter: the shells
 * must be emitted after VitePWA has injected the manifest link and after
 * Workbox has globbed dist/, so they inherit the former and are not swept into
 * the precache by the latter (globIgnores says so too, for when ordering moves).
 */
function seoHtmlPlugin(): Plugin {
  let outDir = "dist";
  let root = process.cwd();

  const readChangelog = (): ShellChangelogEntry[] => {
    try {
      return JSON.parse(readFileSync(join(root, "public/changelog.json"), "utf8"));
    } catch {
      // The changelog shell degrades to its intro rather than failing the build.
      return [];
    }
  };

  const shellFor = (html: string, route: SeoRoute, changelog: ShellChangelogEntry[]) =>
    injectSeo(html, { route, brand: BRAND, allRoutes: SEO_ROUTES, changelog });

  /** "/" -> "", "/library" -> "library", "/chat" -> "chat". */
  const dirFor = (path: string) => path.replace(/^\//, "");

  const emit = (relPath: string, body: string) => {
    const full = join(outDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  return {
    name: "seo-html",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },

    /**
     * The three crawler files in development.
     *
     * They are emitted by closeBundle below, which never runs under `vite
     * dev`, and they are deliberately not in public/ either - so in dev they
     * did not exist at all. Worse, the 404 they produced was not recognisable
     * as one: server/src/routing.ts's ROUTE_SEGMENT rejects any path
     * containing a dot, so they fell through to the SEO 404 shell, whose <h1>
     * is "Page not found" - identical to what the React catch-all renders.
     *
     * Same pure renderers as the build, so dev and production cannot disagree
     * about their contents. Registering here rather than returning a post hook
     * puts this ahead of Vite's own middlewares, and server/src/dev.ts mounts
     * vite.middlewares before its Fastify setNotFoundHandler, so the request
     * is answered before it can reach either.
     */
    configureServer(server) {
      const files: Record<string, [string, () => string]> = {
        "/robots.txt": ["text/plain; charset=utf-8", renderRobots],
        "/sitemap.xml": ["application/xml; charset=utf-8", renderSitemap],
        "/llms.txt": ["text/plain; charset=utf-8", renderLlmsTxt],
      };
      server.middlewares.use((req, res, next) => {
        const entry = files[(req.url ?? "").split("?")[0]];
        if (!entry) return next();
        res.setHeader("Content-Type", entry[0]);
        // Production sends max-age=3600; dev must not, or an edit to
        // routeTable.ts sits behind a stale browser cache for an hour.
        res.setHeader("Cache-Control", "no-store");
        res.end(entry[1]());
      });
    },

    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // In build `ctx.path` is "/index.html"; in dev it is the request URL.
        const requested = (ctx.path || "/").split("?")[0];
        const path = requested === "/index.html" ? "/" : requested;
        const route =
          seoRouteFor(path) ??
          (path.startsWith(SEO_CHAT_PREFIX) ? seoRouteFor("/chat") : undefined) ??
          seoRouteFor(SEO_NOT_FOUND_PATH)!;
        return shellFor(html, route, readChangelog());
      },
    },

    closeBundle() {
      // Preload the two faces that are on the critical path. The stylesheet
      // that declares them is itself render-blocking, so without this the
      // browser only discovers the woff2 after parsing it - one extra
      // round trip in front of the first text the visitor sees. The hashed
      // names are only knowable now, which is why this happens here and not in
      // index.html. Written back to dist/index.html first so that every route
      // shell, all of which are derived from it below, inherits the same tags.
      //
      // withBootBytes runs second and must: it sizes the asset URLs in the
      // document, and the two font preloads only exist once withFontPreloads
      // has added them. Both land in dist/index.html before the loop below
      // derives the other eight shells from it, so all nine agree.
      const rootHtml = withBootBytes(
        withFontPreloads(readFileSync(join(outDir, "index.html"), "utf8"), outDir),
        outDir,
      );
      writeFileSync(join(outDir, "index.html"), rootHtml);
      const changelog = readChangelog();
      const manifest: Record<string, string> = { "/": "index.html" };

      for (const route of SEO_ROUTES) {
        if (route.path === "/") continue;
        // The 404 lives at dist/404.html, not dist/404/index.html: the server
        // sends it for a path that by definition has no directory of its own.
        const relPath =
          route.path === SEO_NOT_FOUND_PATH
            ? "404.html"
            : `${dirFor(route.path)}/index.html`;
        emit(relPath, shellFor(rootHtml, route, changelog));
        manifest[route.path] = relPath;
      }

      emit("robots.txt", renderRobots());
      emit("sitemap.xml", renderSitemap());
      emit("llms.txt", renderLlmsTxt());
      // Never read by the server, which resolves against the filesystem so a
      // rebuild is picked up without a restart. It exists so verify:seo can
      // prove the emitter and the server agree about what was emitted.
      emit("route-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

function renderRobots(): string {
  const lines = [
    "# https://www.robotstxt.org/robotstxt.html",
    "",
    "User-agent: *",
    "Allow: /",
    // Conversations are private, local-only data. They have no server-side
    // existence at all, so there is nothing to crawl and a real cost to trying.
    `Disallow: ${SEO_CHAT_PREFIX}`,
    "Disallow: /v1/",
    // Tens of megabytes of WebAssembly engines. Crawling them burns the budget
    // for the pages that actually rank.
    ...RUNTIME_ASSET_BASE_PATHS.map((p) => `Disallow: ${p}`),
    "",
    // An app whose whole subject is in-browser AI wants to be citable by AI
    // search, so the assistant crawlers are allowed deliberately rather than
    // left to the wildcard.
    ...["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "CCBot"].flatMap(
      (bot) => [`User-agent: ${bot}`, "Allow: /", `Disallow: ${SEO_CHAT_PREFIX}`, ""],
    ),
    `Sitemap: ${BRAND.url}/sitemap.xml`,
    "",
  ];
  return lines.join("\n");
}

function renderSitemap(): string {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = indexableRoutes()
    .map((route) =>
      [
        "  <url>",
        `    <loc>${route.path === "/" ? `${BRAND.url}/` : `${BRAND.url}${route.path}`}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority.toFixed(1)}</priority>`,
        "  </url>",
      ].join("\n"),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * llms.txt - a plain-text map of the site for AI assistants that fetch it.
 * Not a Google signal and not a substitute for anything above; it costs one
 * generated file and the route table already holds everything it needs.
 */
function renderLlmsTxt(): string {
  const routes = indexableRoutes();
  const home = routes.find((r) => r.path === "/");
  return [
    `# ${BRAND.name}`,
    "",
    `> ${BRAND.description}`,
    "",
    home?.intro ?? "",
    "",
    "## Pages",
    "",
    ...routes.map(
      (r) =>
        `- [${r.title || BRAND.name}](${r.path === "/" ? `${BRAND.url}/` : `${BRAND.url}${r.path}`}): ${r.description}`,
    ),
    "",
    "## Notes",
    "",
    `- Source: ${BRAND.repoUrl}`,
    "- Conversations are stored only in the visitor's browser and are not crawlable.",
    "",
  ].join("\n");
}

/**
 * Offline support.
 *
 * Only the app shell is precached. The full build is ~36 MB (Monaco alone
 * ships a 6.8 MB TypeScript worker) and Pyodide adds 13 MB on top, so
 * precaching everything would mean a huge download before the app is usable.
 * Instead, the shell installs immediately and every other same-origin chunk is
 * cached the first time it is actually used, which makes the app work offline
 * from the second visit without paying for features nobody opened.
 *
 * Provider traffic is never cached: only same-origin assets and the webfonts
 * are, so a cached reply can never be served in place of a live model response
 * or a fresh search result.
 */
function pwaPlugin() {
  return VitePWA({
    // "prompt", not "autoUpdate": a new build installs and waits instead of
    // silently taking over a tab the user has open - src/lib/updateCheck.ts
    // registers manually (injectRegister: false, below) and only flips
    // in-app state on onNeedRefresh, so applying the update is always the
    // user's own call, never automatic.
    registerType: "prompt",
    injectRegister: false,
    includeAssets: ["icon.svg", "favicon-32.png", "apple-touch-icon.png"],
    manifest: {
      name: appConfig.app.name,
      short_name: appConfig.app.name,
      description: appConfig.app.description,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#FFFFFF",
      theme_color: "#FFFFFF",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    },
    workbox: {
      // Shell only - see the note above.
      globPatterns: ["**/*.{css,html}", "assets/index-*.js"],
      globIgnores: [
        ...RUNTIME_ASSET_CONFIGS.map((c) => `${c.destDir}/**`),
        "**/*.worker*.js",
        "**/*.map",
        // The per-route SEO shells (dist/library/index.html and friends) and the
        // 404 page. Nothing ever requests those URLs directly - the server sends
        // them in answer to /library and to an unknown path - so precaching them
        // would add ~10 entries and ~10 changed revisions per deploy for no
        // benefit. dist/index.html is not matched by the first pattern and is
        // still precached, which navigateFallback needs.
        "**/*/index.html",
        "404.html",
      ],
      navigateFallback: "index.html",
      // The runtime-asset prefixes, plus the server's own routes. The API
      // entries are close to a no-op - navigateFallback only fires for
      // request.mode === "navigate", and relayFetch issues a POST - but the
      // relay is same-origin now, so spelling it out removes the question.
      navigateFallbackDenylist: [
        ...RUNTIME_ASSET_BASE_PATHS.map((p) => new RegExp(`^${p}`)),
        /^\/v1\//,
        /^\/health$/,
        // Real files on disk that a person can type into the address bar.
        // Typing one IS a navigation (request.mode === "navigate"), so without
        // this the NavigationRoute hands back the precached index.html and
        // React's catch-all renders "Page not found" - on a site that serves
        // all three correctly. Crawlers never run a service worker, which is
        // why this was invisible to verify:seo and to curl alike. Mirrors
        // CRAWLER_FILES in server/src/static.ts. Deliberately NOT $-anchored:
        // Workbox tests the denylist against pathname + search, so
        // /robots.txt?x=1 has to be denied too.
        /^\/robots\.txt/,
        /^\/sitemap\.xml/,
        /^\/llms\.txt/,
        // Everything else that is a real file at the root - /og.png,
        // /changelog.json, /route-manifest.json, /manifest.webmanifest. No app
        // route contains a dot, and this matches the root level only, so
        // /chat/<id> is unaffected however the id is spelled.
        /^\/[^/]+\.[^/]+$/,
      ],
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      cleanupOutdatedCaches: true,
      runtimeCaching: [
        {
          // Lazy chunks and Monaco/pdf/docx workers: immutable, hashed names.
          urlPattern: runtimeAssetMatcher(false),
          handler: "CacheFirst",
          options: {
            cacheName: "fachoy-assets",
            expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 90 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // Each language engine keeps its own Cache Storage entry (see e.g.
          // pythonPlugin.ts); caching it here as well would store it twice.
          urlPattern: runtimeAssetMatcher(true),
          handler: "NetworkOnly",
        },
      ],
    },
    devOptions: { enabled: false },
  });
}

/**
 * Writes dist/<destDir>/<id>-manifest.json listing exactly the files that
 * were actually copied, so a plugin's install() can never drift from what
 * this build really ships for the pinned engine version.
 */
function runtimeManifestPlugin(config: RuntimeAssetConfig): Plugin {
  const manifestName = `${config.id}-manifest.json`;
  const writeManifest = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const files = config.files.filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
    writeFileSync(join(dir, manifestName), JSON.stringify({ files }, null, 2));
  };
  return {
    name: `${config.id}-manifest`,
    closeBundle() {
      writeManifest(join(process.cwd(), "dist", config.destDir));
    },
    // Dev server never runs closeBundle — vite-plugin-static-copy serves
    // node_modules files directly without copying in dev, so serve the
    // manifest from a small middleware reading the same source files.
    configureServer(server) {
      server.middlewares.use(`/${config.destDir}/${manifestName}`, (_req, res) => {
        const files = config.files.filter((f) => {
          try {
            return statSync(join(process.cwd(), "node_modules", config.srcDir, f)).isFile();
          } catch {
            return false;
          }
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ files }));
      });
    },
  };
}

/**
 * vite-plugin-monaco-editor's dev-mode worker middleware (workerMiddleware.js)
 * serves each worker bundle with a raw `res.end()`, bypassing Vite's own
 * `server.headers` middleware entirely - so in dev the response for e.g.
 * `/monacoeditorwork/editor.worker.bundle.js` carries no
 * Cross-Origin-Embedder-Policy header, even though this page sets COEP (for
 * the interactive-stdin feature - see the `server.headers` block below) and
 * is therefore crossOriginIsolated. A dedicated worker spawned from a
 * crossOriginIsolated document must itself get a response with a matching
 * COEP header or the browser refuses to start it, firing a bare `error`
 * event on the Worker with no message - which is what
 * src/lib/monacoWorkerFix.ts's classic `new Worker(url)` hit: monaco's own
 * console warning "Could not create web worker(s)" with no underlying cause,
 * confirmed live by comparing a direct fetch() of the same URL (200 OK) against
 * `new Worker()` on it (bare error, no network entry) versus `new Worker()` on
 * a blob: URL built from that same fetched text (loads fine, since blob:
 * worker scripts are exempt from the COEP response-header check).
 *
 * This plugin must run BEFORE monacoEditorPlugin in the array below: Vite
 * calls configureServer middlewares in plugin order, and `res.setHeader`
 * only needs to land before the monaco plugin's own middleware calls
 * `res.end()` - it does not need to be the one sending the response.
 * Production/preview are unaffected: there the worker bundles are files
 * under dist/, served by the Fastify app in `server/` (whose onRequest hook stamps this header
 * on every response) or Vite's own preview static server (which does apply
 * `preview.headers`), not through this dev-only middleware.
 */
function monacoWorkerDevHeadersPlugin(): Plugin {
  return {
    name: "monaco-worker-dev-coep-header",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/monacoeditorwork/")) {
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    patchPhpWasmGluePlugin(),
    htmlBrandPlugin(),
    pwaPlugin(),
    // After pwaPlugin deliberately: the route shells must inherit the manifest
    // link it injects, and must be written after Workbox has globbed dist/.
    seoHtmlPlugin(),
    monacoWorkerDevHeadersPlugin(),
    // Bundles the Monaco editor and its language workers locally (offline-friendly).
    // publicPath must NOT be "/" - the plugin's own dev-mode worker-path
    // builder (workerMiddleware.js's getWorkPath) does plain string
    // concatenation, `config.base + publicPath + '/' + filename`, not path
    // joining. With both `base` and `publicPath` equal to "/" that produces
    // "///editor.worker.bundle.js" - a URL with no valid host component -
    // which then gets wrapped in a blob whose importScripts() call on that
    // same broken inner URL throws "The URL '...' is invalid" the moment any
    // Monaco worker (editor, typescript, json, ...) tries to spawn. The
    // plugin's own default ("monacoeditorwork") avoids this by never being
    // "/" in the first place; kept explicit here so this doesn't regress
    // back to "/" without the reason being obvious.
    monacoEditorPlugin({ publicPath: "monacoeditorwork" }),
    viteStaticCopy({
      // dest carries any subdirectory a file entry has (e.g. "jspi/x.wasm"),
      // computed here rather than left to the plugin - and rename.stripBase
      // is still required even so: without it, this plugin nests the file's
      // *entire source path* underneath dest (producing e.g.
      // dist/php/jspi/8_5_10/node_modules/@php-wasm/.../php_8_5.wasm),
      // rather than just placing its basename there. stripBase reduces an
      // exact (non-glob) src to its basename, which is exactly what's wanted
      // now that dest already carries the subdirectory - it no longer risks
      // colliding jspi/php_8_5.js with asyncify/php_8_5.js as it would if
      // dest were flat.
      targets: RUNTIME_ASSET_CONFIGS.flatMap((config) =>
        config.files.map((f) => {
          const slash = f.lastIndexOf("/");
          const subDir = slash === -1 ? "" : f.slice(0, slash);
          return {
            src: `node_modules/${config.srcDir}/${f}`,
            dest: subDir ? `${config.destDir}/${subDir}` : config.destDir,
            rename: { stripBase: true },
          };
        })
      ),
    }),
    // webR's remaining assets beyond the 5 boot-critical core files (see the
    // "r" entry above). `webr/dist/*` (one level) picks up the handful of
    // other top-level files (webr.js/.cjs/.mjs, esbuild.d.ts, source maps -
    // harmless if copied, unused at runtime). The real gap it misses is
    // `vfs/`: webR's own virtual filesystem image (etc/usr/var, ~109 files,
    // ~25MB) holding every base-R package's lazily-loaded data (help, docs,
    // translations, ...) - R fetches these from `/r/vfs/...` on demand, so
    // without this second target advanced stdlib functionality would 404 at
    // runtime despite basic execution working fine. `repl/` and `webR/` (the
    // package's other two dist subdirectories) are pure `.d.ts` files and
    // `tests/` is test fixtures - none are runtime assets, so neither glob
    // here reaches them and both are correctly left uncopied.
    viteStaticCopy({
      targets: [
        { src: "node_modules/webr/dist/*", dest: "r", rename: { stripBase: true } },
        // stripBase:true here would collapse every vfs file to just its
        // basename (it always strips the *entire* matched directory, not
        // only the glob's fixed prefix) - fatal for vfs, whose ~109 files
        // include plenty of same-named files across different R packages
        // (DESCRIPTION, NAMESPACE, ...) that would silently overwrite one
        // another. stripBase:3 strips exactly "node_modules/webr/dist" (3
        // segments) and keeps everything below it - "vfs/etc/...",
        // "vfs/usr/...", etc - intact under dest "r".
        { src: "node_modules/webr/dist/vfs/**/*", dest: "r", rename: { stripBase: 3 } },
      ],
    }),
    ...RUNTIME_ASSET_CONFIGS.map((config) => runtimeManifestPlugin(config)),
  ],
  define: {
    // Read from package.json rather than duplicated here, so a version bump
    // is a one-line edit. Exposed to the client so it can tell which of the
    // update system's pending changelog entries are actually new to it.
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync("package.json", "utf-8")).version),
    // Only the two public sections. config.json's `server` section holds the
    // relay secret, so it must never be inlined into the bundle - importing the
    // whole file from src/ would do exactly that. verify:relay asserts a built
    // dist/ contains none of it.
    __APP_CONFIG__: JSON.stringify({ app: appConfig.app, client: appConfig.client }),
  },
  optimizeDeps: {
    // @php-wasm/web's module graph statically references every PHP version's
    // intl-extension .so/.dat files via `import("...?url")`, which esbuild's
    // dependency scanner (used here, unlike Vite's own plugin pipeline which
    // understands "?url") has no loader for - pre-bundling it hard-fails the
    // whole dep-optimization pass. Same treatment as pyodide: excluded from
    // the scanner entirely, loaded via native dynamic ESM resolution instead.
    // wasi-sh resolves its bundled busybox.wasm via `new URL('../dist/busybox.wasm',
    // import.meta.url)` - a pattern Vite's own plugin pipeline rewrites to an
    // absolute same-origin path, but esbuild's dependency pre-bundler does not:
    // pre-bundled into node_modules/.vite/deps/wasi-sh.js, import.meta.url there
    // is the *chunk's* URL, so the relative lookup lands one directory off
    // (.vite/deps/dist/busybox.wasm, which doesn't exist) and 404s straight into
    // Vite's SPA index.html fallback - a WebAssembly.compile() CompileError with
    // "<!do" as the first bytes. Same failure class, same fix, as pyodide below.
    exclude: ["pyodide", "@php-wasm/web", "wasi-sh"],
    /**
     * Dependencies that are only reachable from a Web Worker, behind a lazy
     * `new Worker(...)`. Vite's dependency scanner does not reliably crawl
     * worker entry points, so without this it discovers them the first time a
     * user actually spawns the worker - which triggers a re-optimization and a
     * **full page reload**, cancelling whatever the click had started:
     *
     *   [vite] new dependencies optimized: wasmoon
     *   [vite] optimized dependencies changed. reloading
     *
     * That is what made installing a runtime for the first time reload the page
     * and require a second click. Pre-bundling them at server start costs a
     * moment of startup and removes the reload entirely. Dev-only behaviour;
     * a production build has no optimizer.
     */
    // @php-wasm/universal (a dependency of @php-wasm/web, itself excluded
    // above) does `import { parse, stringify } from "ini"` - a named import
    // from a CJS package. Vite's dev server only applies its more thorough
    // CJS->ESM interop to pre-bundled deps; served raw, "ini" fails with
    // "does not provide an export named 'parse'". @php-wasm/universal itself
    // has no .so/.dat references (those live only in the per-version
    // web-X-Y packages, reachable exclusively through @php-wasm/web's own
    // dynamic imports), so pre-bundling it here is safe.
    include: [
      "sql.js",
      "wasmoon",
      "esbuild-wasm",
      "@mlc-ai/web-llm",
      "@php-wasm/universal",
      "wasm-feature-detect",
      // The full deep path, not just "@ruby/wasm-wasi": DefaultRubyVM isn't
      // exported from that package's root ("." only re-exports vm.js/
      // console.js) - only from this subpath - and Vite's optimizeDeps
      // genuinely needs the exact specifier used in the importing code for a
      // subpath entry point like this to actually get pre-bundled.
      "@ruby/wasm-wasi/dist/browser",
      "webr",
      // Imported normally (it is small pure JS) by clangToolchain.ts, unlike
      // browsercc itself, which is loaded by URL from /cpp/ and so is
      // deliberately invisible to the bundler.
      "@bjorn3/browser_wasi_shim",
    ],
    // Give the scanner the worker entries explicitly, so a future runtime's
    // dependency is found at start-up rather than mid-session.
    entries: ["index.html", "src/workers/*.ts"],
  },
  // pyodideWorker.ts imports the "pyodide" package, which itself contains
  // dynamic imports (code-splitting) — Rollup requires ES module output for
  // that, and Vite's default worker format ("iife") rejects it outright.
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    // Bind all interfaces by default so the dev server is reachable from
    // other devices on the LAN without needing an extra `--host` flag.
    host: true,
    // Cross-origin isolation, so SharedArrayBuffer/Atomics.wait() are
    // available - the only way to actually pause a running Pyodide program
    // and let a human answer input() live. "credentialless", not
    // "require-corp": it still enables crossOriginIsolated without demanding
    // a Cross-Origin-Resource-Policy header from every third-party resource
    // this app already loads (providers, jsdelivr wheels, WebLLM weights,
    // r.jina.ai, generated images/video) that we don't control.
    //
    // These apply only when running bare `vite`. The app is normally served by
    // the Fastify server in `server/`, which sets the same two headers on every
    // response from one onRequest hook - that is the source of truth, and it
    // covers dev too, since Vite runs inside it in middleware mode. Any other
    // host serving dist/ needs them as well for this one feature to activate;
    // everything else keeps working with zero configuration.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    // docgen (the docx/pdf-lib *writer*, for exporting generated documents) is
    // only ever reached via dynamic import() from ArtifactPanel.tsx, but Vite
    // still auto-preloads dynamic-import targets found in eagerly-loaded
    // modules as a "warm the cache" heuristic - which defeats the point of
    // splitting it out for a feature most sessions never use. Excluding it
    // here keeps it a real lazy fetch instead of a preloaded one.
    modulePreload: {
      resolveDependencies: (_filename, deps) => deps.filter((dep) => !dep.includes("docgen")),
    },
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ["react-markdown", "remark-gfm", "react-syntax-highlighter"],
          pdf: ["pdfjs-dist"],
          docx: ["mammoth"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
          // Real .docx/.pdf *writers* for generated document artifacts — distinct
          // from the "pdf"/"docx" chunks above, which are the *reader* libs used
          // for user-uploaded attachments.
          docgen: ["docx", "pdf-lib", "unified", "remark-parse", "mdast-util-to-string"],
          // Local inference runtime. Named explicitly so it doesn't land in a
          // generic "index-*" chunk, which the shell precache glob would then
          // match - it is ~6 MB and is loaded only when a local model is used.
          webllm: ["@mlc-ai/web-llm"],
        },
      },
    },
  },
});
