/**
 * Every URL this app answers, and what each one says about itself.
 *
 * This is the single source of truth behind four consumers that live in four
 * different worlds:
 *
 *   1. `useRouteHead` in the browser, which retitles the document on navigation;
 *   2. `seoHtmlPlugin` in vite.config.ts, which emits one static HTML shell per
 *      route at build time (and the sitemap, robots.txt and llms.txt);
 *   3. `scripts/verify-seo.ts`, which asserts all of the above agree;
 *   4. indirectly the Fastify server, which resolves a path to a shell file.
 *
 * WHY THIS FILE HAS ZERO IMPORTS, AND MUST KEEP HAVING NONE. Consumer 2 runs in
 * vite.config.ts's Node context, where `__APP_CONFIG__` does not exist; consumer
 * 1 runs in the bundle, which may never import config.json. A single `import`
 * from either side would make this file loadable by only one of them. So it
 * holds no absolute URL and names no domain - paths are origin-relative and the
 * origin is joined on by whoever renders. `verify:seo` asserts the zero-import
 * and no-domain properties directly, because they are easy to break by accident
 * and the breakage is not obvious.
 *
 * ADDING A ROUTE. Add it here and add the matching `<Route>` in App.tsx.
 * `verify:seo` checks both directions, so a route with no metadata and metadata
 * with no route are each a build failure. That is deliberate: the old failure
 * mode was a new page silently inheriting the homepage's title and canonical.
 */

export interface SeoSection {
  heading: string;
  body: string;
}

/**
 * Routes whose prose is generated from the same data the React view renders,
 * rather than authored here. See `src/lib/seo/content/`.
 */
export type SeoContentSource = "features" | "privacy" | "changelog";

export interface SeoRoute {
  /** Origin-relative, lowercase, no trailing slash except the root. */
  path: string;
  /** Empty means: use the brand title verbatim. Only the root does this. */
  title: string;
  /** 70-160 characters, unique across routes. This is the SERP snippet. */
  description: string;
  /** Must match the `<h1>` the real page renders. `verify:seo` checks it. */
  h1: string;
  intro: string;
  /** Authored prose. Empty when `contentSource` supplies the body instead. */
  sections: SeoSection[];
  contentSource?: SeoContentSource;
  indexable: boolean;
  /** Sitemap hints. Ignored for non-indexable routes. */
  priority: number;
  changefreq: "daily" | "weekly" | "monthly" | "yearly";
  jsonLd: "home" | "page" | "none";
  /** The component rendering the real page, for the anti-cloaking check. */
  sourceFile: string;
}

export const SEO_ROUTES: SeoRoute[] = [
  {
    path: "/",
    title: "",
    description:
      "Run AI models, twelve language runtimes, agents and skills entirely inside one browser tab on your own device. No account, no API key, no server needed.",
    h1: "InBrowser",
    intro:
      "InBrowser is a complete AI workspace that runs in a browser tab. Models, code execution, storage, agents and skills all execute on your own device. There is no account to create, no API key required to start, and no server of ours that sees your conversations.",
    sections: [
      {
        heading: "AI models that run on your own device",
        body: "Over 160 open models can be downloaded once and then run locally on WebGPU through WebLLM, with no network call and no rate limit afterwards. Chrome's built-in Gemini Nano works with no download at all. A local model has no key, no quota, and keeps working with the network switched off.",
      },
      {
        heading: "Keyless providers, called straight from your browser",
        body: "Several hosted providers work with no signup and no API key. Requests go directly from your browser to the provider rather than through a shared server, so rate limits apply per person instead of being exhausted by everyone at once. You can also point the app at your own self-hosted gateway, or route traffic through an HTTP, HTTPS, SOCKS5 or SOCKS4 proxy you control.",
      },
      {
        heading: "Code that runs in the tab",
        body: "Twelve language runtimes are compiled to WebAssembly and install into the browser on demand, including Python, JavaScript, C, C++, Ruby, PHP, R, Lua, Clojure and SQL. The assistant can execute code in any installed runtime and read back the real result, sandboxed with a timeout, instead of describing what the code would do.",
      },
      {
        heading: "Agents, skills and tools",
        body: "Agents combine a system prompt, a model policy and a toolset into a bounded plan-act-observe loop that reports every step it takes. Skills are reusable instruction packages in the standard Agent Skills format, installable from any public marketplace repository. Tool plugins give the model exact utilities to call for regular expressions, diffing, JSON, CSV, hashing, JWT, colour, dates and units.",
      },
      {
        heading: "Your data never leaves the browser",
        body: "Conversations, skills, memories, scheduled tasks and settings are stored in your browser's own IndexedDB, localStorage, OPFS and Cache Storage. Provider API keys stay on your device and are deliberately excluded from backup exports. Everything can be exported as a single archive and imported again elsewhere.",
      },
    ],
    indexable: true,
    priority: 1.0,
    changefreq: "weekly",
    jsonLd: "home",
    sourceFile: "src/components/Welcome.tsx",
  },
  {
    path: "/features",
    title: "Features",
    description:
      "Every capability InBrowser ships, with a concrete example for each: chat, routing, local models, search, skills, tools, agents and media generation.",
    h1: "Discover Features",
    intro:
      "Everything this app can do, with an example of each. Every item below is a feature that ships today, grouped by the part of the app it belongs to.",
    sections: [],
    contentSource: "features",
    indexable: true,
    priority: 0.9,
    changefreq: "weekly",
    jsonLd: "page",
    sourceFile: "src/components/PrivacyView.tsx",
  },
  {
    path: "/store",
    title: "Store",
    description:
      "Install language runtimes, utility tool plugins and local AI models directly into your browser. Everything runs on your own device after install.",
    h1: "Store",
    intro:
      "One catalog of everything installable: language runtimes, utility tools, local AI models and skills. Each entry installs into this browser and runs on your device rather than on a server.",
    sections: [
      {
        heading: "Language runtimes",
        body: "Python, JavaScript, C, C++, Ruby, PHP, R, Lua, Clojure, SQL and more, each compiled to WebAssembly and cached after the first install. C and C++ compile and link in the browser through clang and wasm-ld before executing. Once installed, a runtime works offline.",
      },
      {
        heading: "Local AI models",
        body: "Over 160 open models run on WebGPU through WebLLM. Weights download once into Cache Storage and the model is then usable with no network, no API key and no quota. Download progress is shown per model, and installed models appear in the normal model picker alongside hosted ones.",
      },
      {
        heading: "Tool plugins and skills",
        body: "Utility tool plugins give the assistant exact functions to call rather than approximating them: regular expressions, diffing, JSON and CSV handling, hashing, identifiers, JWT decoding, colour and contrast, dates and unit conversion. Skills install from any public repository that publishes the standard marketplace manifest, and the full instruction file is shown before anything is installed.",
      },
    ],
    indexable: true,
    priority: 0.8,
    changefreq: "weekly",
    jsonLd: "page",
    sourceFile: "src/components/StoreView.tsx",
  },
  {
    path: "/library",
    title: "Skill Library",
    description:
      "Manage installed skills: reusable instruction packages in the Agent Skills format that change how the assistant behaves mid-conversation.",
    h1: "Library",
    intro:
      "Reusable instruction packages. Call one from the composer to inject it into a conversation, and the assistant follows it for as long as it stays active.",
    sections: [
      {
        heading: "What a skill is",
        body: "A skill is a package in the standard Agent Skills format: an instruction file with structured frontmatter, plus any supporting files it references. Activating one injects its instructions into the conversation and enables a bounded two-tool loop so the assistant can read the skill's own bundled files as it works.",
      },
      {
        heading: "Installing and organising",
        body: "Skills install from a packaged archive or from any public repository that publishes the standard marketplace manifest. A single archive may contain several skills, and each becomes its own entry. Nothing installs unread: the full instruction file is displayed before you confirm.",
      },
      {
        heading: "Where skills are stored",
        body: "Installed skills and their bundled resources live in this browser's own storage, not on a server. They are included in backup exports, so a skill set moves between machines as a single archive.",
      },
    ],
    indexable: true,
    priority: 0.8,
    changefreq: "weekly",
    jsonLd: "page",
    sourceFile: "src/components/LibraryView.tsx",
  },
  {
    path: "/agents",
    title: "Agents",
    description:
      "Build autonomous agents with their own prompt, model policy and toolset. Every run shows a full step trace, and agents can delegate to sub-agents.",
    h1: "Agents",
    intro:
      "Agents work through a goal on their own, using the tools and workspace you give them. Each one is a system prompt, a model policy, a toolset and a bounded loop that keeps going until the task is done or a limit is reached.",
    sections: [
      {
        heading: "A bounded plan-act-observe loop",
        body: "Every run has a step cap, a token budget and an abort signal, and every stopping reason is reported rather than hidden. That is what makes an autonomous loop safe to leave running: it cannot spend without limit, and it always says why it stopped.",
      },
      {
        heading: "Sub-agents and swarm mode",
        body: "An agent can delegate to other agents through a depth-capped call tool with a shared scratchpad, which is how a researcher to writer to critic chain works. In swarm mode, work fans out to several member agents in parallel and their results are synthesised, with a per-member trace you can drill into.",
      },
      {
        heading: "A full step trace",
        body: "Every run shows its complete step-by-step trace, not just the final answer, including each tool call and each observation. An autonomous loop that only shows its conclusion cannot be trusted or debugged, so the trace is always available.",
      },
    ],
    indexable: true,
    priority: 0.8,
    changefreq: "weekly",
    jsonLd: "page",
    sourceFile: "src/components/AgentBuilderView.tsx",
  },
  {
    path: "/tasks",
    title: "Scheduled Tasks",
    description:
      "Schedule a recurring prompt that runs automatically while the tab is open, keeping a full history of every result it produced.",
    h1: "Scheduled tasks",
    intro:
      "A scheduled task is a prompt that runs on a repeating schedule and records what it returned each time, so you can check back rather than asking again.",
    sections: [
      {
        heading: "How scheduling works",
        body: "Tasks are stored in this browser and polled on an interval by the open tab. They do not run in the background and there is no daemon, which is the honest consequence of an app with no server: if no tab is open, nothing runs. A task that was missed runs at the next check instead.",
      },
      {
        heading: "Results and history",
        body: "Every run records its result, so a task doubles as a log of how an answer changed over time. Runs can be triggered by hand, and a task can be edited, paused or deleted at any point without losing what it already collected.",
      },
    ],
    indexable: true,
    priority: 0.4,
    changefreq: "monthly",
    jsonLd: "page",
    sourceFile: "src/components/TasksView.tsx",
  },
  {
    path: "/changelog",
    title: "Change Log",
    description:
      "What shipped in each release of InBrowser, newest first, including new runtimes, providers, agent capabilities and interface changes.",
    h1: "Change logs",
    intro:
      "What shipped in each release, newest first. The app updates in place, and this page is the record of what changed between versions.",
    sections: [],
    contentSource: "changelog",
    indexable: true,
    priority: 0.6,
    changefreq: "weekly",
    jsonLd: "page",
    sourceFile: "src/components/ChangelogView.tsx",
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "What happens to your data, in plain language: no accounts, no backend, local storage only, and exactly what the optional proxy relay can see.",
    h1: "Privacy Policy",
    intro:
      "What happens to your data, in plain language. This page describes the app's actual current behaviour rather than a static legal document, and is updated alongside the app itself.",
    sections: [],
    contentSource: "privacy",
    indexable: true,
    priority: 0.7,
    changefreq: "monthly",
    jsonLd: "page",
    sourceFile: "src/components/PrivacyView.tsx",
  },
  {
    path: "/about",
    title: "About",
    description:
      "InBrowser is an independent, open-source project. Every claim it makes is reproducible in the app itself, and the full source is public on GitHub.",
    h1: "About InBrowser",
    intro:
      "InBrowser is an independent, open-source project, not a company. There is no team page here because there is no team to list - what there is instead is a public source tree and an app where every claim below can be checked in one click.",
    sections: [
      {
        heading: "Verify it, don't take it on faith",
        body: "Every claim this site makes about running locally, storing nothing on a server, and needing no account is checkable in the app itself: open DevTools, watch the network tab, and confirm no provider, search or model-weight request ever targets this site's own origin except the optional proxy relay a visitor configures themselves. The full source is public at github.com/Choy0X/Inbrowser.",
      },
      {
        heading: "What actually runs where",
        body: "Chat models, code execution, agents, skills and storage all run on the visitor's own device: local models on WebGPU, twelve language runtimes compiled to WebAssembly, and conversations kept in the browser's own IndexedDB. Hosted providers are called directly from the browser rather than through a shared server, so a rate limit applies per person instead of being exhausted by everyone at once.",
      },
      {
        heading: "An independent project",
        body: "InBrowser has no company, no trademark and no commercial backing - it is built and maintained as an open-source project. That is stated plainly here rather than implied otherwise, because the credibility this site asks for should rest on what can be inspected, not on how official it sounds.",
      },
    ],
    indexable: true,
    priority: 0.6,
    changefreq: "monthly",
    jsonLd: "page",
    sourceFile: "src/components/AboutView.tsx",
  },

  // Not indexed, but still served a real shell so the document carries a correct
  // title and an explicit robots directive rather than inheriting the homepage's.
  {
    path: "/chat",
    title: "Chat",
    description:
      "A saved conversation. Conversations live only in this browser and are never uploaded, so this page has nothing for a search engine to index.",
    h1: "Chat",
    intro:
      "This conversation is stored in your own browser. Nothing on this page exists on a server, so there is nothing here to index.",
    sections: [],
    indexable: false,
    priority: 0,
    changefreq: "daily",
    jsonLd: "none",
    sourceFile: "src/components/ChatView.tsx",
  },
  {
    path: "/404",
    title: "Page not found",
    description:
      "That page does not exist. It may have been renamed or removed; the main sections of the app are linked below.",
    h1: "Page not found",
    intro: "That page does not exist. It may have been renamed or removed since you last visited.",
    sections: [],
    indexable: false,
    priority: 0,
    changefreq: "yearly",
    jsonLd: "none",
    sourceFile: "src/components/NotFoundView.tsx",
  },
];

/**
 * Paths that moved. Answered with a 301 by the server and a `<Navigate>` by the
 * router, so an old bookmark keeps working and passes its ranking on rather than
 * dying in the hard 404 that unknown paths now get.
 */
export const SEO_REDIRECTS: Record<string, string> = {
  "/skills": "/library",
  "/plugins": "/store",
};

/** Every `/chat/<id>` is answered by the one non-indexable chat shell. */
export const SEO_CHAT_PREFIX = "/chat/";

export const SEO_NOT_FOUND_PATH = "/404";

export function seoRouteFor(path: string): SeoRoute | undefined {
  return SEO_ROUTES.find((r) => r.path === path);
}

export function indexableRoutes(): SeoRoute[] {
  return SEO_ROUTES.filter((r) => r.indexable);
}
