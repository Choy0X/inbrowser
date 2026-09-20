/**
 * The privacy policy, as data.
 *
 * Lifted out of PrivacyPolicyContent.tsx for the same reason as
 * featureGroups.ts: the React view renders it for a visitor and the build-time
 * shell generator renders it for a crawler, and a policy that says two
 * different things depending on whether you run JavaScript is worse than a
 * policy nobody indexes.
 *
 * Takes the brand strings as arguments rather than importing appConfig, so the
 * module stays free of `__APP_CONFIG__` and vite.config.ts can call it during
 * the build. Paragraphs are plain strings; the JSX version used `<br /><br />`
 * for the breaks inside the relay section, which is the same thing said less
 * accessibly.
 */

export interface PolicyLink {
  href: string;
  label: string;
}

export interface PolicySection {
  title: string;
  paragraphs: string[];
  /** Rendered after the paragraphs, as a short list of external references. */
  links?: PolicyLink[];
}

export interface PolicyBrand {
  name: string;
  url: string;
  repoUrl: string;
}

export function privacyPolicySections(brand: PolicyBrand): PolicySection[] {
  const app = brand.name;
  return [
    {
      title: "Browser storage, no accounts",
      paragraphs: [
        `${app} keeps your conversation history, files, and settings in your browser and does not require an account. Network features still send requests: AI providers receive the content you ask them to process, our server serves the app, starter prompts, and the public proxy catalog, and the optional relay forwards provider requests when you configure a proxy. Those paths and the site's analytics are described below.`,
      ],
    },
    {
      title: "The starter prompts on the empty screen",
      paragraphs: [
        `The suggestions on the empty chat screen refresh once a day, so your browser asks a server of ours for them. That request carries two things: whether it is currently morning, afternoon, evening or night where you are, and up to three yes/no flags for what your selected model can do - whether it can look at images, run tools, and reason at length. They are there so you are not offered a prompt about a photo on a model that cannot see one.`,
        `The suggestion payload includes no account identifier, conversation content, files, or date. Like other web requests, it still exposes connection information to the services handling it. The list is selected from shared prompts for the same model abilities and time of day; it is not built from your activity. ${app} also saves the result in your browser's storage so the screen can work offline.`,
        `The prompts themselves are generated once a day by ${app}'s server and held in shared server state, not generated per visitor. Your request only reads the existing pool. Whoever deploys this copy of ${app} can disable starter prompts entirely.`,
      ],
    },
    {
      title: "Your history and settings are stored locally",
      paragraphs: [
        `Conversations, skills, memories, scheduled tasks, and settings are saved in your browser's own storage (IndexedDB, localStorage, OPFS, and Cache Storage). Content needed for a network feature, such as a message sent to an AI provider, leaves the browser when you use that feature. You can delete a conversation, clear all chats, or remove individual memories at any time.`,
      ],
    },
    {
      title: "AI providers are called directly from your browser",
      paragraphs: [
        `When you chat, search, or generate media, the request goes straight from your browser to whichever provider you selected - a keyless provider from the built-in list, your own API-keyed connection, or a self-hosted OmniRoute gateway you configured. Unless you have configured a proxy, ${app} does not relay that traffic through a server of its own, so each provider sees only your own request rather than a shared pool of everyone's traffic. Each provider is responsible for its own privacy practices once your request reaches it.`,
      ],
    },
    {
      title: "The optional proxy relay",
      paragraphs: [
        "If you configure a proxy in Settings, requests take a different path, because a browser cannot speak the protocols real proxies use. They are sent to the same server that served you this page, which opens a tunnel through a Cloudflare worker out to the proxy you chose. Two components, and they see very different things.",
        "The proxy address, credentials, and dial destination are encrypted in transit between the relay and the worker. The worker decrypts this connection information to open and authenticate the proxy connection. The HTTPS connection to the provider remains encrypted through the worker and proxy; they do not terminate that inner secure connection. The proxy operator sees the worker's connection address.",
        "The relay itself can read your request, the provider's response, and any API key in the request because it establishes the secure connection to the provider on your behalf. The application does not persist or log those contents or your proxy credentials. It forwards them for the request and keeps separate operational state, described below. The relay address is a setting, so you can use a relay you operate yourself.",
        "With no proxy configured, your provider requests go directly from your browser to the provider you picked. Requests for shared starter prompts and catalog listings may still contact our server.",
      ],
    },
    {
      title: "Public proxy catalog and shared operational state",
      paragraphs: [
        "The server maintains a public proxy catalog on a background schedule, hourly by default. It stores public proxy addresses, source references, and check results in Redis and in a catalog snapshot on disk. These are public proxy records, not your browsing history. Opening the catalog, searching, choosing a proxy, or reading saved catalog entries only reads existing results and does not trigger a scan. Background discovery and checks use the fixed catalog relay independently of your own proxy settings.",
        "Shared Redis state also includes generated starter prompts, background-job coordination, and expiring rate-limit counters. Counter keys use a keyed hash (HMAC) of the client address instead of storing the raw visitor IP address in Redis. This is pseudonymous operational data, not a guarantee of anonymity. The application does not put provider API keys, user proxy passwords, conversations, or relayed request and response contents into this shared state or its catalog snapshots.",
        "If shared state is unavailable, new proxied requests can fail temporarily while already established streams continue. Public proxies are operated by third parties, and a successful catalog check does not guarantee later availability, confidentiality, or anonymity. The relay and the destination provider still process information as described above.",
      ],
    },
    {
      title: "Web search and page reading",
      paragraphs: [
        `Search and "read this page" features fetch results and page text via r.jina.ai and DuckDuckGo's results page, called directly from your browser rather than through a server of ours - or through your proxy, if you configured one, in which case the relay above applies to them too.`,
      ],
    },
    {
      title: "API keys stay on your device",
      paragraphs: [
        "Any provider API key you enter is stored locally in your browser and sent only to the provider it belongs to - directly, or through the relay above if you configured a proxy. Keys and proxy passwords are deliberately excluded from the backup export/import feature, so an exported backup file never contains them.",
      ],
    },
    {
      title: "Local and offline AI models",
      paragraphs: [
        "Models you install to run in-browser (WebLLM on WebGPU, or Chrome's built-in Gemini Nano) run entirely on your own device. Once a model is downloaded, using it for chat requires no further network traffic at all.",
      ],
    },
    {
      title: "Installing skills",
      paragraphs: [
        "Installing a skill or marketplace entry fetches its files from GitHub or jsdelivr directly from your browser, the same way any other page asset would load.",
      ],
    },
    {
      title: "Site analytics",
      paragraphs: [
        `${app}'s public site uses Google Analytics to measure aggregate traffic to ${brand.url} - which pages are visited, roughly how many people, and where from. It works by a script that sets a cookie and reports page views to Google, whose own privacy policy governs what happens to that data on their side.`,
        `It sees which page you loaded, never what you typed. A conversation page reports only that a conversation page was viewed, not which one - the conversation's own address never reaches Google, the same way it never reaches a server of ours. A build with no analytics id configured, which is the default for anyone self-hosting this repository, loads no analytics at all.`,
        `On a build where analytics is configured, that script does not load until you say yes: a bar at the bottom of the screen asks the first time you visit, and declining it, or leaving it unanswered, means it never loads. You can change your answer at any time using the control next to this section's heading.`,
      ],
    },
    {
      title: "Changes to this policy",
      paragraphs: [
        "This page reflects the app's current, actual behavior rather than a static legal document, so it is updated alongside the app itself. See the change log for a history of what shipped.",
      ],
    },
    {
      title: "Questions",
      paragraphs: [
        `${app} is open source. Review the code yourself or raise a question at the repository, or visit the site.`,
      ],
      links: [
        { href: brand.repoUrl, label: brand.repoUrl },
        { href: brand.url, label: brand.url },
      ],
    },
  ];
}
