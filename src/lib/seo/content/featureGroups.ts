/**
 * What the app can do, as data.
 *
 * Lifted out of DiscoverFeaturesContent.tsx so it can have two readers: the
 * React view renders it to JSX for a visitor, and the build-time
 * shell generator (src/lib/seo/renderShell.ts) renders the same array to plain
 * HTML for a crawler. Writing the prose twice would mean the indexed copy and
 * the visible copy drift apart within a release, which is both an SEO problem
 * and, if it got far enough, a cloaking one.
 *
 * Zero imports on purpose - vite.config.ts imports this during the build, where
 * neither JSX nor `__APP_CONFIG__` exists.
 */

export interface Feature {
  name: string;
  description: string;
  example: string;
}

export interface FeatureGroup {
  category: string;
  features: Feature[];
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    category: "Chat",
    features: [
      {
        name: "Live streaming replies",
        description: "Answers appear token-by-token as they're generated, with a stop control while still writing.",
        example: "Ask a question and watch the answer type itself out in real time.",
      },
      {
        name: "Model picker",
        description: "A searchable list of every model across all connected providers, with context size and capability badges.",
        example: 'Click the model name in the header, type "llama" to filter, and pick a specific model.',
      },
      {
        name: '"Auto" smart routing',
        description: "Picks the best available model per message and silently retries another if one fails or is rate-limited.",
        example: 'Leave the model on "Auto" and a coding question gets routed to a tool-capable model automatically.',
      },
      {
        name: "Conversation history",
        description: "Every chat saves automatically to your browser's local database as you type - no account, no server.",
        example: "Close the tab mid-conversation and come back tomorrow - it's still in the sidebar.",
      },
      {
        name: "Multiple conversations",
        description: "Keep any number of separate chat threads, rename them, or delete individual ones.",
        example: 'Keep one thread for "trip planning" and another for "code review."',
      },
    ],
  },
  {
    category: "Providers & routing",
    features: [
      {
        name: "Keyless AI providers",
        description: "Several real providers work with zero signup or API key - just add and start chatting.",
        example: 'Open Settings, add "Pollinations AI" with one click, and it\'s usable right away.',
      },
      {
        name: "Automatic failover",
        description: "When a provider is rate-limited or fails, Auto mode tries the next healthy candidate instead of showing an error.",
        example: "A free provider hits its rate limit mid-session; the next message is silently answered by a different one.",
      },
      {
        name: "In-browser local models",
        description: "Over 160 open models can be downloaded once and then run entirely on your own device - no network call, no rate limit.",
        example: "Install a small model from the Store, then chat with it with no internet connection.",
      },
      {
        name: "Gemini Nano",
        description: "Chrome's built-in model runs with zero download, useful as an instant fallback.",
        example: "Add the Gemini Nano connection in Settings; it answers instantly with no download wait.",
      },
      {
        name: "Bring-your-own gateway",
        description: "Point the app at your own self-hosted gateway server instead of connecting to providers directly.",
        example: "Run a gateway implementing the OmniRoute protocol (github.com/diegosouzapw/OmniRoute) on a home server, enter its URL in Settings, and route every chat through it.",
      },
      {
        name: "Real proxy support",
        description:
          "Route requests through your own HTTP, HTTPS, SOCKS5 or SOCKS4 proxy, with health-based failover across a pool of them. Useful when a provider is blocked in your region.",
        example:
          "Add a SOCKS5 proxy in Settings > Proxies, press Test to see which IP you now exit from, and every chat, search and image request leaves from there instead of your own address.",
      },
    ],
  },
  {
    category: "Web search",
    features: [
      {
        name: "Web search toggle",
        description: "Lets the assistant search the live web and read the full text of top results before answering.",
        example: "Toggle search on and ask about something recent - the assistant cites a page it actually read.",
      },
      {
        name: "Alternative search backends",
        description: "Switch the default search backend to a keyed provider for different result quality.",
        example: "Add a free Serper key in Settings and switch the search backend for more precise results.",
      },
    ],
  },
  {
    category: "Skills",
    features: [
      {
        name: "Skills",
        description: "A reusable expert instruction pack that can be summoned mid-conversation to change how the assistant behaves.",
        example: 'Install a "Code Reviewer" skill and click it in the composer before pasting code.',
      },
      {
        name: "Skill marketplace",
        description: "Install skills from any public GitHub repo publishing the standard marketplace format, with full instructions shown before installing.",
        example: "Browse the bundled marketplace in the Store, preview a skill, and click Install.",
      },
    ],
  },
  {
    category: "Tools",
    features: [
      {
        name: "Web browsing tool",
        description: "The assistant can open URLs, follow links, and read page text through a CORS-friendly reader.",
        example: 'Ask "summarize this documentation page" with a URL.',
      },
      {
        name: "Code execution tool",
        description: "The assistant can run code in any installed language runtime, sandboxed with a timeout, instead of just describing it.",
        example: "Ask for a brute-force computation and get back the real, computed value.",
      },
      {
        name: "Utility tool plugins",
        description: "Exact developer utilities the model can call directly - regex, diff, JSON/CSV, hashing, IDs, JWT, color, dates, units.",
        example: 'Ask "decode this JWT" and the assistant calls the exact tool.',
      },
      {
        name: "Data connectors",
        description: "Register your own REST API endpoints so the assistant can call them as tools.",
        example: "Add a weather API connector, then ask the assistant to look up today's forecast.",
      },
    ],
  },
  {
    category: "Agents",
    features: [
      {
        name: "Agents",
        description: "A standalone system prompt, model, and toolset that works through a task across multiple steps until done.",
        example: "Build a research agent with browsing tools and give it a question to investigate on its own.",
      },
      {
        name: "Sub-agents & swarm mode",
        description: "An agent can delegate to other agents, or fan work out to several member agents in parallel and synthesize their results.",
        example: "A research-team agent delegates to specialist sub-agents as needed.",
      },
      {
        name: "Step trace",
        description: "Every agent run shows its full step-by-step trace - not just the final answer - so it can be debugged.",
        example: "Watch each step an agent takes as it runs, laid out in order.",
      },
    ],
  },
  {
    category: "Store & plugins",
    features: [
      {
        name: "Plugin catalog",
        description: "A single catalog of everything installable - language runtimes, utility tools, and local AI models - all installing straight into the browser.",
        example: 'Install "Python" from the Store to enable code execution in Python.',
      },
    ],
  },
  {
    category: "Automations",
    features: [
      {
        name: "Scheduled tasks",
        description: "Schedule a recurring prompt that runs automatically while the tab is open, recording its result and history.",
        example: 'Create a daily task, "Summarize today\'s top AI news," and check back each morning.',
      },
    ],
  },
  {
    category: "Backup",
    features: [
      {
        name: "Full backup export/import",
        description: "Export chats, skills, memories, and tasks as a single zip and re-import later, merging by ID.",
        example: "Export a backup before switching computers, then import it on the new machine.",
      },
    ],
  },
  {
    category: "Media generation",
    features: [
      {
        name: "Image generation & editing",
        description: "Generate images from a text prompt, or edit an existing image with an instruction.",
        example: 'Type "a watercolor painting of a lighthouse at dusk" and generate.',
      },
      {
        name: "Video generation",
        description: "Generate short video clips from a text prompt.",
        example: 'Prompt "a slow zoom-in on a cup of coffee" and generate a clip.',
      },
      {
        name: "Audio transcription",
        description: "Transcribe attached audio files to text.",
        example: "Attach a voice memo and ask the assistant to summarize what was said.",
      },
    ],
  },
  {
    category: "Memory",
    features: [
      {
        name: "Persistent memory",
        description: "The assistant can remember durable, personal facts across conversations and apply them in future chats.",
        example: 'Mention once that you prefer metric units; it applies that in later chats too.',
      },
      {
        name: "Review before saving",
        description: "Auto-learned facts queue as pending for you to approve, edit, or reject before they become permanent.",
        example: "Confirm or dismiss a suggested memory from the Settings memory tab.",
      },
    ],
  },
  {
    category: "Appearance",
    features: [
      {
        name: "Light / dark mode",
        description: "A single cohesive design with an instant, persistent light/dark toggle.",
        example: "Toggle to Dark in Settings for a near-black interface at night.",
      },
    ],
  },
];
