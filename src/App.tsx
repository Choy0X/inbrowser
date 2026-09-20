import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from "react-router-dom";
import { PanelLeftOpen } from "lucide-react";
import type {
  Attachment,
  ChatMessage,
  Conversation,
  GeneratedArtifact,
  MessageSearch,
  OmniModel,
} from "./lib/types";
import type { CapabilityIndex } from "./lib/capabilities";
import { buildCapabilityIndexFromProviders, modelCapabilities } from "./lib/capabilities";
import {
  ARTIFACT_SYSTEM_PROMPT,
  createArtifactStreamParser,
  reduceArtifactEvent,
  type ArtifactStreamEvent,
} from "./lib/artifacts";
import { createFencedCodeArtifactParser } from "./lib/fencedCodeArtifacts";
import {
  chatStream,
  editImages,
  generateImages,
  generateVideo,
  getSettings,
  loadModelsAndCapabilities,
  messageToPayload,
  runCompletion,
  saveSettings,
  testGatewayConnection,
  testProviderConnection,
  testProxyConnection,
  webSearch,
  type CustomProxy,
  type GatewaySettings,
  type ProviderConnection,
  type ProxyTestResult,
  type ToolCallWire,
  type ChatMessageInput,
} from "./lib/onniroute";
import { migrateProxies } from "./lib/gatewaySettings";
import { ensureDefaultProviderDiscovery, ensureDefaultProxies } from "./lib/gateway/defaultSeeding";
import {
  clearConversations,
  flushConversations,
  loadConversations,
  loadUi,
  newId,
  saveConversations,
  saveUi,
  type ThemeMode,
} from "./lib/store";
import { applyThemeColor } from "./lib/theme";
import { runTool, toolDefs, toolsForTurn, type ToolContext } from "./lib/tools/registry";
import { syncToolPlugins } from "./lib/tools/toolPlugins";
import { RUN_CODE_SYSTEM_PROMPT } from "./lib/tools/codeTools";
import { backupFilename, exportBackup, mergeById, parseBackup, restoreSkills, restoreProxyMasterSetting } from "./lib/backup";
import type { Preferences } from "./lib/preferences";
import { promptScaleFor } from "./lib/promptScale";
import { RICH_OUTPUT_SYSTEM_PROMPT } from "./lib/richOutput";
import { recoverFencedArtifactMessage } from "./lib/artifactRecovery";
import {
  COMPACT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  loadPreferences,
  newMemoryItem,
  savePreferences,
  selectRelevantMemories,
  MAX_PENDING_MEMORIES,
} from "./lib/preferences";
import {
  CONCISE_DIRECTIVE,
  OUTPUT_MAX_TOKENS,
  RETRIEVED_CONTEXT_END,
  RETRIEVED_CONTEXT_START,
  SEARCH_EXCERPT_BUDGET_CHARS,
  needsSummaryUpdate,
  partitionHistory,
  selectRelevantExcerpt,
  selectRelevantMessages,
  updateOldTierSummary,
} from "./lib/tokenOptimization";
import type { Skill } from "./lib/skills";
import { findSkillTokensInText, loadSkills, saveSkills, truncateResourceText } from "./lib/skills";
import { getSkillResources } from "./lib/skillstore";
import type { ScheduledTask, TaskInput } from "./lib/tasks";
import { createTask, deleteTask, fetchTasks, importTask, runTaskNow, updateTask } from "./lib/tasks";
import { startTaskScheduler } from "./lib/taskRunner";
import type { PageExcerpt } from "./lib/reader";
import { readTopResults } from "./lib/reader";
import { Sidebar } from "./components/Sidebar";
import { LocalModelProgress } from "./components/LocalModelProgress";
import { AnalyticsConsentBar } from "./components/AnalyticsConsentBar";
import { BrowserDock } from "./components/BrowserPanel";
import type { Agent } from "./lib/agents";
import { loadAgents, saveAgents } from "./lib/agents";
import { ChatView } from "./components/ChatView";
import { PROVIDERS_CHANGED_EVENT, syncInstalledLocalModels } from "./lib/gateway/local/register";
import { installedModelIdsSync } from "./lib/plugins/executors";
import { ModelPickerModal } from "./components/ModelPickerModal";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { RouteFallback } from "./components/RouteFallback";
import { Tooltip } from "./components/Tooltip";
import { ConfirmDialog } from "./components/Dialog";
import type { GenerationMode } from "./components/GenerationPanel";
import { fetchChangelog, pendingEntries, type ChangelogEntry } from "./lib/changelog";
import { startUpdateChecker, applyUpdate } from "./lib/updateCheck";
import { APP_NAME } from "./lib/appConfig";
import { useRouteHead } from "./lib/seo/useRouteHead";

/**
 * Route pages are lazy; chat is not.
 *
 * Every view used to be a static import, so the Monaco-, pdf- and docx-bearing
 * chunks of pages nobody had opened rode in the same entry chunk as the chat
 * screen and had to be parsed before anything could appear. Chat is the landing
 * route and holds the LCP element, so it stays eager; the rest arrive when they
 * are first visited, behind the one <Suspense> around <Routes> below.
 *
 * This costs nothing for search: the pre-rendered shell already carries each
 * page's text, so a crawler never waits on a chunk. See src/lib/seo/.
 */
const LibraryView = lazy(() => import("./components/LibraryView").then((m) => ({ default: m.LibraryView })));
const StoreView = lazy(() => import("./components/StoreView").then((m) => ({ default: m.StoreView })));
const TasksView = lazy(() => import("./components/TasksView").then((m) => ({ default: m.TasksView })));
const PrivacyView = lazy(() => import("./components/PrivacyView").then((m) => ({ default: m.PrivacyView })));
const NotFoundView = lazy(() => import("./components/NotFoundView").then((m) => ({ default: m.NotFoundView })));
const AgentBuilderView = lazy(() =>
  import("./components/AgentBuilderView").then((m) => ({ default: m.AgentBuilderView })),
);
const ChangelogView = lazy(() =>
  import("./components/ChangelogView").then((m) => ({ default: m.ChangelogView })),
);
const AboutView = lazy(() => import("./components/AboutView").then((m) => ({ default: m.AboutView })));

type GatewayStatus = "checking" | "ok" | "error";

/** Editor keystrokes rewrite the whole array; coalesce them into one write. */
const PERSIST_DEBOUNCE_MS = 500;

function titleFrom(text: string): string {
  const firstLine = (text.split("\n").find((l) => l.trim()) || "New chat").trim();
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

/** Build the system context note that grounds the assistant reply on search results. */
function searchContextFor(
  search: MessageSearch,
  excerpts?: PageExcerpt[],
  optimize = false
): string | undefined {
  if (search.results.length === 0) return undefined;

  const cited = (i: number) => `[${i + 1}]`;
  const lines = search.results
    .map((r, i) => `${cited(i)} ${r.title} — ${r.url}\n${(r.snippet ?? "").trim()}`)
    .join("\n\n");

  // Real page text (when the reader returns it) is what lets the model quote
  // exact values — a snippet alone can't carry "the time right now". Prefer it
  // over the provider's `content` field when both exist, tag with the same
  // citation number as the source result.
  const naiveClip = (raw: string, max = SEARCH_EXCERPT_BUDGET_CHARS) => {
    const t = raw.trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  };
  const clip = (raw: string, max = SEARCH_EXCERPT_BUDGET_CHARS) =>
    optimize ? selectRelevantExcerpt(raw, search.query, max) : naiveClip(raw, max);
  const excerptBlocks: string[] = [];
  const used = new Set<number>();
  for (const excerpt of excerpts ?? []) {
    if (used.has(excerpt.resultIndex)) continue;
    const result = search.results[excerpt.resultIndex];
    const sourceText = (result?.content ?? "").trim();
    const body = clip(sourceText.length > excerpt.text.length ? sourceText : excerpt.text);
    used.add(excerpt.resultIndex);
    excerptBlocks.push(`${cited(excerpt.resultIndex)} ${excerpt.title || result?.title || excerpt.url}\n${body}`);
  }
  // Results that carry full `content` from the provider but weren't deep-read.
  search.results.forEach((r, i) => {
    if (used.has(i)) return;
    const text = (r.content ?? "").trim();
    if (text.length > 0) {
      used.add(i);
      excerptBlocks.push(`${cited(i)} ${r.title}\n${clip(text)}`);
    }
  });

  const excerptSection =
    excerptBlocks.length > 0
      ? `\n\nRelevant page content (fetched or provided):\n\n${excerptBlocks.join("\n\n")}`
      : "";

  return (
    `Web search for "${search.query}" returned the following results:\n\n` +
    `${lines}${excerptSection}\n\n` +
    `Answer the user's question using these sources when relevant. ` +
    `The results may contain the exact answer (times, dates, prices, numbers, statistics): ` +
    `if a source states a precise value, quote it directly rather than paraphrasing or hedging. ` +
    `Cite sources inline as [n] matching the numbering above.` +
    ` Only say information isn't available when no source actually provides it.`
  );
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeId = matchPath("/chat/:id", location.pathname)?.params.id ?? null;

  // The build emits a correct <head> per URL, so this is only for navigation
  // inside the app, where the document is never re-fetched. See lib/seo/head.ts.
  useRouteHead();

  // Migration of legacy oversized inline code blocks (messageMigrations.ts)
  // happens later, via the chunked/progress-tracked effect below — not here.
  // A synchronous migration on boot would block first paint for exactly the
  // conversation this feature exists to avoid blocking on.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // History lives in IndexedDB (convostore.ts), so it arrives asynchronously.
  // Until it does, saving is suppressed - otherwise the initial empty state
  // would be written back over the stored history as a deletion. State, not a
  // ref: the stale-link redirect below (activeId set but no matching
  // conversation) must re-run once loading finishes even when that doesn't
  // also change `activeConversation` (the genuinely-stale-link case), which
  // a ref's silent mutation can't trigger.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [models, setModels] = useState<OmniModel[]>([]);
  const [capabilityIndex, setCapabilityIndex] = useState<CapabilityIndex>(() =>
    buildCapabilityIndexFromProviders([])
  );
  const [settings, setSettings] = useState<GatewaySettings>(() => getSettings());
  const [status, setStatus] = useState<GatewayStatus>("checking");
  const [streaming, setStreaming] = useState(false);
  const [searching, setSearching] = useState(false);
  const [ui, setUi] = useState(() => loadUi());
  const [defaultSearchEnabled, setDefaultSearchEnabled] = useState(false);
  // Pending "temporary chat" mode for the *next* conversation, set from the
  // toggle while there's no active chat yet (home page, or an empty new
  // chat). Consumed once sendMessage actually creates that conversation.
  const [defaultTemporary, setDefaultTemporary] = useState(false);
  const [defaultModel, setDefaultModel] = useState("auto");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [skills, setSkills] = useState<Skill[]>(() => loadSkills());
  const [agents, setAgents] = useState<Agent[]>(() => loadAgents());
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  interface GenRequest {
    mode: GenerationMode;
    prompt?: string;
    image?: { dataUrl: string; name?: string } | null;
  }
  const [genRequest, setGenRequest] = useState<GenRequest | null>(null);
  const [generating, setGenerating] = useState(false);

  const [openArtifact, setOpenArtifact] = useState<{ messageId: string; artifactId: string } | null>(null);
  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem("fachoy:artifactPanelWidth"));
    return Number.isFinite(stored) && stored >= 320 && stored <= 800 ? stored : 440;
  });

  const abortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const modelsRef = useRef<OmniModel[]>([]);

  // Active skills per conversation (possibly more than one — a message can
  // embed multiple distinct skill tokens), so read_skill_file/list_skill_files
  // resolve against the right skill even when switching between chats
  // mid-session. Keyed convoId -> skillId -> that skill's resolved resources.
  const activeSkillsRef = useRef<Map<string, Map<string, { resources: Skill["resources"] }>>>(
    new Map()
  );

  /** Mirror of preferences.enabledTools, read inside runAssistant. */
  const enabledToolIdsRef = useRef<string[]>(preferences.enabledTools ?? []);
  useEffect(() => {
    enabledToolIdsRef.current = preferences.enabledTools ?? [];
  }, [preferences.enabledTools]);

  // Stable mirror of `skills` state for callbacks (handleSkillTool) that must
  // stay referentially stable across renders yet always see the latest list —
  // same pattern as `conversationsRef` below.
  const skillsRef = useRef<Skill[]>(skills);
  skillsRef.current = skills;
  /** Same render-time mirror, so the unmount flush sees the latest agents. */
  const agentsRef = useRef<Agent[]>(agents);
  agentsRef.current = agents;

  // Per-conversation cooldown for auto memory extraction, keyed by assistant-turn
  // count at last extraction. In-memory only, not persisted.
  const lastExtractedAssistantCount = useRef<Map<string, number>>(new Map());

  // One-shot web-search intent: set when the user toggles search ON, consumed by
  // the very next sendMessage (and only that one). This is the single source of
  // truth for search, so a fresh chat never gets its intent silently reset and a
  // message never searches against a stale/off state.
  const pendingSearchRef = useRef(false);

  // Records which conversation consumed a one-shot web search, so it can be reset
  // only after that exchange finishes streaming.
  const lastSearchConsumedId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = (await loadConversations()).map(conversation => ({
        ...conversation, messages: conversation.messages.map(recoverFencedArtifactMessage),
      }));
      if (cancelled) return;
      // Merge rather than replace: a chat may already have been created in the
      // moment before the store finished loading.
      setConversations((current) => {
        if (current.length === 0) return stored;
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...stored.filter((c) => !seen.has(c.id))];
      });
      setHistoryLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    saveConversations(conversations);
  }, [conversations, historyLoaded]);

  // saveConversations() above is debounced (store.ts) so a burst of state
  // changes — e.g. every streamed token — doesn't re-serialize the whole
  // history on each one. Flush immediately whenever the tab might disappear,
  // so at most one debounce window of data is ever at risk.
  useEffect(() => {
    const flush = () => flushConversations();
    const onVisibility = () => {
      if (document.hidden) flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  useEffect(() => {
    saveUi({ ...ui, defaultSearchEnabled });
  }, [ui, defaultSearchEnabled]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  // Typing in the agent/skill editors updates this state on every keystroke, and
  // each write is a full JSON serialize of every agent or skill. Debounce it and
  // flush on unmount so a keypress no longer costs a localStorage round trip.
  useEffect(() => {
    const timer = setTimeout(() => saveAgents(agents), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [agents]);

  useEffect(() => {
    const timer = setTimeout(() => saveSkills(skills), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [skills]);

  // The debounced writes above lose at most one window if the tab disappears
  // mid-edit, so flush them on the same events that flush conversations.
  useEffect(() => {
    const flush = () => {
      saveAgents(agentsRef.current);
      saveSkills(skillsRef.current);
    };
    const onVisibility = () => {
      if (document.hidden) flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // Apply the active mode to <html>, and follow OS changes in "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const mode: "light" | "dark" =
        ui.theme === "system" ? (mq.matches ? "dark" : "light") : ui.theme;
      document.documentElement.dataset.theme = mode;
      document.documentElement.style.colorScheme = mode;
      applyThemeColor(mode);
    };
    apply();
    if (ui.theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [ui.theme]);

  const changeTheme = useCallback((theme: ThemeMode) => {
    setUi((u) => ({ ...u, theme }));
  }, []);

  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // Direct mode builds the model/capability list synchronously from
  // configured connections; gateway mode fetches it from the connected
  // gateway. See loadModelsAndCapabilities in lib/onniroute.ts.
  const refreshGateway = useCallback(async () => {
    setStatus("checking");
    const { models: modelList, index, ok } = await loadModelsAndCapabilities();
    setModels(modelList);
    modelsRef.current = modelList;
    setCapabilityIndex(index);
    setStatus(ok ? "ok" : "error");
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await fetchTasks());
    } catch {
      /* keep stale list on transient failures */
    }
  }, []);

  useEffect(() => {
    void refreshGateway();
    // Installing a local model from the store adds it to its connection, which
    // is what makes it selectable. Without this the picker only picked it up
    // after some other settings save.
    // Models installed before installs registered themselves are on disk but
    // absent from the picker; reconcile once on load rather than making the
    // user reinstall gigabytes to fix bookkeeping.
    syncInstalledLocalModels(installedModelIdsSync());
    const onProvidersChanged = () => void refreshGateway();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, onProvidersChanged);
    return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, onProvidersChanged);
  }, [refreshGateway]);

  // Tool plugins the user has enabled must be registered before the first turn,
  // or the model is offered a toolset that silently omits them.
  useEffect(() => {
    void syncToolPlugins();
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  useEffect(() => startTaskScheduler(() => void refreshTasks()), [refreshTasks]);

  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [pendingChangelog, setPendingChangelog] = useState<ChangelogEntry[]>([]);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  useEffect(() => {
    startUpdateChecker(() => {
      setUpdateAvailable(true);
      setShowUpdatePrompt(true);
      void fetchChangelog(true).then((all) => setPendingChangelog(pendingEntries(all, __APP_VERSION__)));
    });
  }, []);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const currentModel = activeConversation?.model ?? defaultModel;
  const caps = modelCapabilities(currentModel, capabilityIndex);
  const providerSummary =
    settings.mode === "gateway"
      ? (() => {
          try {
            return new URL(settings.gateway.baseUrl).host;
          } catch {
            return settings.gateway.baseUrl;
          }
        })()
      : (() => {
          const enabledCount = settings.providers.filter((p) => p.enabled).length;
          return enabledCount > 0 ? `${enabledCount} provider${enabledCount === 1 ? "" : "s"}` : "No providers configured";
        })();
  const activeSkillIds = activeId ? [...(activeSkillsRef.current.get(activeId)?.keys() ?? [])] : [];
  const activeSkillNames = activeSkillIds
    .map((id) => skills.find((s) => s.id === id)?.name)
    .filter((name): name is string => !!name);

  // A /chat/:id URL for a conversation that no longer exists (deleted, stale
  // shared link) — send the user back to the empty-chat landing route. Gated
  // on `historyLoaded`: conversations start as [] and arrive asynchronously
  // from IndexedDB (see the load effect above), so a direct/refreshed visit
  // to a /chat/:id URL would otherwise see "no matching conversation yet"
  // during that first render and bounce to "/" before the real data ever
  // had a chance to load — killing every valid deep link and hard refresh.
  useEffect(() => {
    if (activeId && !activeConversation && historyLoaded) navigate("/", { replace: true });
  }, [activeId, activeConversation, historyLoaded, navigate]);

  const updateConvo = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
  }, []);

  const appendToMessage = useCallback(
    (convoId: string, msgId: string, updater: (m: ChatMessage) => ChatMessage) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convoId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map((m) => (m.id === msgId ? updater(m) : m)),
              }
            : c
        )
      );
    },
    []
  );

  /** Applies one parsed artifact-stream event onto a message's `files` array. */
  const applyArtifactEvent = useCallback(
    (convoId: string, msgId: string, ev: ArtifactStreamEvent) => {
      appendToMessage(convoId, msgId, (m) => ({ ...m, files: reduceArtifactEvent(m.files ?? [], ev) }));
    },
    [appendToMessage]
  );

  const updateArtifact = useCallback(
    (convoId: string, msgId: string, artifactId: string, content: string) => {
      appendToMessage(convoId, msgId, (m) => ({
        ...m,
        files: (m.files ?? []).map((f) => (f.id === artifactId ? { ...f, editedContent: content } : f)),
      }));
    },
    [appendToMessage]
  );

  /** Saves a user edit to one inline fenced code block; `null` reverts it. */
  const updateCodeBlock = useCallback(
    (convoId: string, msgId: string, key: string, content: string | null) => {
      appendToMessage(convoId, msgId, (m) => {
        const next = { ...(m.codeEdits ?? {}) };
        // A revert deletes the entry rather than storing a copy of the
        // original, so an untouched message carries no codeEdits at all.
        if (content === null) delete next[key];
        else next[key] = content;
        return { ...m, codeEdits: Object.keys(next).length ? next : undefined };
      });
    },
    [appendToMessage]
  );

  /** Best-effort background memory extraction from a completed exchange. */
  const extractMemory = useCallback(async (convoId: string) => {
    const convo = conversationsRef.current.find((c) => c.id === convoId);
    if (!convo) return;
    const assistantTurns = convo.messages.filter((m) => m.role === "assistant" && m.content).length;
    const lastAt = lastExtractedAssistantCount.current.get(convoId) ?? -Infinity;
    if (assistantTurns - lastAt < 3) return;
    lastExtractedAssistantCount.current.set(convoId, assistantTurns);
    const userMsg = [...convo.messages].reverse().find((m) => m.role === "user");
    const assistantMsg = [...convo.messages].reverse().find((m) => m.role === "assistant" && m.content);
    if (!userMsg || !assistantMsg) return;
    try {
      const text = await runCompletion({
        model: "auto",
        maxTokens: 256,
        messages: [
          {
            role: "system",
            content:
              "You extract durable, personal facts about the user from a conversation exchange. " +
              "Output a compact list, one fact per line, with no numbering or bullets. " +
              "Only include stable preferences, context or personal details worth remembering long-term; " +
              "ignore transient or task-specific content. If nothing is worth remembering, output exactly: NONE",
          },
          {
            role: "user",
            content: `User: ${userMsg.content.slice(0, 4000)}\n\nAssistant: ${assistantMsg.content.slice(0, 4000)}`,
          },
        ],
      });
      const facts = text
        .split("\n")
        .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
        .filter((line) => line && line.toUpperCase() !== "NONE");
      if (facts.length === 0) return;
      const candidates = facts.slice(0, 3).map((t) => newMemoryItem(t.slice(0, 200)));
      setPreferences((prev) => {
        if (!prev.memoryEnabled || !prev.autoMemory) return prev;
        const existingTexts = [...prev.memories, ...prev.pendingMemories].map((m) =>
          m.text.toLowerCase()
        );
        const added = candidates.filter(
          (n) =>
            !existingTexts.some(
              (e) => e.includes(n.text.toLowerCase()) || n.text.toLowerCase().includes(e)
            )
        );
        if (added.length === 0) return prev;
        return {
          ...prev,
          pendingMemories: [...added, ...prev.pendingMemories].slice(0, MAX_PENDING_MEMORIES),
        };
      });
    } catch {
      /* extraction is best-effort — never disrupt chat */
    }
  }, []);

  /** Best-effort background fold of aged-out history into the rolling old-tier summary. */
  const maybeUpdateOldTierSummary = useCallback(async (convoId: string) => {
    const convo = conversationsRef.current.find((c) => c.id === convoId);
    if (!convo || !needsSummaryUpdate(convo)) return;
    try {
      const { summary, summarizedThrough } = await updateOldTierSummary(convo);
      updateConvo(convoId, (c) => ({ ...c, oldTierSummary: summary, oldTierSummarizedThrough: summarizedThrough }));
    } catch {
      /* summarization is best-effort — never disrupt chat; will retry next qualifying turn */
    }
  }, [updateConvo]);

  const runAssistant = useCallback(
    async (convoId: string, model: string, messages?: ChatMessage[], searchNote?: string) => {
      // Tracked locally (not re-derived from conversationsRef) because the ref
      // only refreshes at render time — re-reading it here can return a stale
      // snapshot missing the message that was just added synchronously by the
      // caller, causing the model to respond to an earlier turn instead.
      let liveMessages: ChatMessage[] =
        messages ?? conversationsRef.current.find((c) => c.id === convoId)?.messages ?? [];
      if (liveMessages.length === 0) return;

      // The tool set for this turn comes from the registry: skill tools switch
      // themselves on when a skill is active, everything else is opt-in.
      const toolCtx: ToolContext = {
        convoId,
        activeSkills: activeSkillsRef.current.get(convoId) ?? new Map(),
        skills: skillsRef.current,
      };
      const turnTools = caps.toolCalling
        ? toolsForTurn(toolCtx, { enabledIds: enabledToolIdsRef.current })
        : [];
      const hasRunCode = turnTools.some((t) => t.id === "run_code");
      const toolLoopEnabled = turnTools.length > 0;
      const MAX_TOOL_ROUNDS = 6;
      let rounds = 0;

      const buildPayload = (): ChatMessageInput[] => {
        const context: ChatMessage[] = [];
        // Scaled to the model. A small model handed a long list of clauses and
        // one concrete example reproduces the example - a 1B model answered
        // "hi" with the artifact contract's own template.
        const scale = promptScaleFor(model, modelCapabilities(model, capabilityIndex));
        context.push({
          id: newId(),
          role: "system",
          content: scale.compact ? COMPACT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
          timestamp: Date.now(),
        });
        if (scale.artifacts) {
          context.push({ id: newId(), role: "system", content: ARTIFACT_SYSTEM_PROMPT, timestamp: Date.now() });
        }
        if (scale.richOutput) {
          context.push({ id: newId(), role: "system", content: RICH_OUTPUT_SYSTEM_PROMPT, timestamp: Date.now() });
        }
        if (hasRunCode && !scale.compact) {
          context.push({ id: newId(), role: "system", content: RUN_CODE_SYSTEM_PROMPT, timestamp: Date.now() });
        }
        if (preferences.customInstructions.trim()) {
          context.push({
            id: newId(),
            role: "system",
            content: `Custom instructions:\n${preferences.customInstructions}`,
            timestamp: Date.now(),
          });
        }
        if (preferences.memoryEnabled && preferences.memories.length > 0) {
          const latestUserText =
            [...liveMessages].reverse().find((m) => m.role === "user")?.content ?? "";
          const relevant = selectRelevantMemories(preferences.memories, latestUserText);
          context.push({
            id: newId(),
            role: "system",
            content: `Facts known about the user:\n${relevant.map((m) => `- ${m.text}`).join("\n")}`,
            timestamp: Date.now(),
          });
        }
        if (preferences.tokenOptimization) {
          context.push({ id: newId(), role: "system", content: CONCISE_DIRECTIVE, timestamp: Date.now() });
        }
        if (searchNote) {
          context.push({ id: newId(), role: "system", content: searchNote, timestamp: Date.now() });
        }
        const activeForConvo = activeSkillsRef.current.get(convoId);
        if (activeForConvo) {
          for (const [skillId, { resources }] of activeForConvo) {
            const skill = skills.find((s) => s.id === skillId);
            if (!skill) continue;
            const parts: string[] = [skill.instructions];
            const list = (resources ?? []).map((r) => r.path);
            if (list.length > 0) {
              const textBlocks = (resources ?? [])
                .filter((r) => r.kind === "text" && r.text)
                .map((r) => `--- ${r.path} ---\n${truncateResourceText(r.text!)}`);
              parts.push(
                [
                  `This skill ships with the following bundled resource files:\n${list.join("\n")}`,
                  textBlocks.length > 0
                    ? `Their contents are provided below so you can use them without further reads:\n\n${textBlocks.join("\n\n")}`
                    : "You can read any of these files by calling the read_skill_file tool when you need their contents.",
                ].join("\n\n")
              );
            }
            context.push({
              id: newId(),
              role: "system",
              content: `Skill "${skill.name}" is active for this turn:\n\n${parts.join("\n\n")}`,
              timestamp: Date.now(),
            });
          }
        }

        if (!preferences.tokenOptimization) {
          return [
            ...context.map((m) => messageToPayload(m)),
            ...liveMessages.map((m) => messageToPayload(m)),
          ];
        }

        const convo = conversationsRef.current.find((c) => c.id === convoId);
        const { recent, middleCandidates } = partitionHistory(liveMessages, convo?.oldTierSummarizedThrough);
        const latestUserText =
          [...liveMessages].reverse().find((m) => m.role === "user")?.content ?? "";
        const retrieved = selectRelevantMessages(middleCandidates, latestUserText);

        if (convo?.oldTierSummary) {
          context.push({
            id: newId(),
            role: "system",
            content: `Summary of earlier conversation (older messages, condensed):\n${convo.oldTierSummary}`,
            timestamp: Date.now(),
          });
        }
        const historyPayload: ChatMessage[] = [];
        if (retrieved.length > 0) {
          historyPayload.push({ id: newId(), role: "system", content: RETRIEVED_CONTEXT_START, timestamp: Date.now() });
          historyPayload.push(...retrieved);
          historyPayload.push({ id: newId(), role: "system", content: RETRIEVED_CONTEXT_END, timestamp: Date.now() });
        }
        historyPayload.push(...recent);
        return [
          ...context.map((m) => messageToPayload(m)),
          ...historyPayload.map((m) => messageToPayload(m, true)),
        ];
      };

      const runTurn = async (): Promise<ToolCallWire[]> => {
        const payload = buildPayload();
        const assistantMsg: ChatMessage = {
          id: newId(),
          role: "assistant",
          content: "",
          model,
          timestamp: Date.now(),
        };
        updateConvo(convoId, (c) => ({ ...c, messages: [...c.messages, assistantMsg] }));
        setStreaming(true);
        const controller = new AbortController();
        abortRef.current = controller;
        let toolCalls: ToolCallWire[] = [];
        let assistantContent = "";
        let assistantFiles: GeneratedArtifact[] = [];
        let responseFailed = false;
        const artifactParser = createArtifactStreamParser();
        // Second stage on the tag parser's own prose output: a model that just
        // dumps a file in a plain ``` fence instead of the <fachoy-artifact>
        // contract still gets it promoted into a real file artifact rather
        // than left as inline chat text (see fencedCodeArtifacts.ts).
        const fenceParser = createFencedCodeArtifactParser();
        const applyFileEvents = (events: ArtifactStreamEvent[]) => {
          for (const ev of events) {
            assistantFiles = reduceArtifactEvent(assistantFiles, ev);
            applyArtifactEvent(convoId, assistantMsg.id, ev);
          }
        };
        const applyProseAndEvents = (rawProse: string, events: ArtifactStreamEvent[]) => {
          applyFileEvents(events);
          const fenced = fenceParser.push(rawProse);
          if (fenced.prose) {
            assistantContent += fenced.prose;
            appendToMessage(convoId, assistantMsg.id, (m) => ({ ...m, content: m.content + fenced.prose }));
          }
          applyFileEvents(fenced.events);
        };
        try {
          const previousModel = [...liveMessages].reverse().find((m) => m.resolvedModel)?.resolvedModel;
          const result = await chatStream({
            model: effectiveModel,
            messages: payload,
            allowArtifacts: promptScaleFor(model, modelCapabilities(model, capabilityIndex)).artifacts,
            signal: controller.signal,
            ...(previousModel ? { previousModel } : {}),
            onProxyUsed: proxy => appendToMessage(convoId, assistantMsg.id, m => ({ ...m, proxy })),
            ...(toolLoopEnabled ? { tools: toolDefs(turnTools), toolChoice: "auto" } : {}),
            ...(preferences.tokenOptimization ? { maxTokens: OUTPUT_MAX_TOKENS } : {}),
            onDelta: (delta) => {
              const { prose, events } = artifactParser.push(delta);
              applyProseAndEvents(prose, events);
            },
            onReasoning: (reasoning) =>
              appendToMessage(convoId, assistantMsg.id, (m) => ({
                ...m,
                reasoning: (m.reasoning ?? "") + reasoning,
              })),
            onError: (message) => {
              responseFailed = true;
              appendToMessage(convoId, assistantMsg.id, (m) => ({ ...m, error: message }));
            },
          });
          {
            const { prose, events } = artifactParser.flush();
            applyProseAndEvents(prose, events);
          }
          {
            // Closes out any fence still open when the turn ends (a model cut
            // off mid-file) so it ends up "truncated" rather than losing its
            // trailing content to the parser's internal buffer.
            const fenced = fenceParser.flush();
            if (fenced.prose) {
              assistantContent += fenced.prose;
              appendToMessage(convoId, assistantMsg.id, (m) => ({ ...m, content: m.content + fenced.prose }));
            }
            applyFileEvents(fenced.events);
          }
          toolCalls = result.toolCalls;
          if (!responseFailed && toolCalls.length === 0) {
            const recovered = recoverFencedArtifactMessage({ ...assistantMsg,
              content: assistantContent, files: assistantFiles });
            if (recovered.files !== assistantFiles) {
              assistantContent = recovered.content;
              assistantFiles = recovered.files ?? [];
              appendToMessage(convoId, assistantMsg.id, m => ({ ...m,
                content: assistantContent, files: assistantFiles }));
            }
          }
          if (toolCalls.length > 0) {
            appendToMessage(convoId, assistantMsg.id, (m) => ({
              ...m,
              toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
            }));
          }
          // Keep our own record of what this turn actually produced — the
          // ref-based conversations state won't be caught up yet if a next
          // tool-loop round needs this message right away.
          liveMessages = [
            ...liveMessages,
            {
              ...assistantMsg,
              content: assistantContent,
              ...(toolCalls.length > 0
                ? { toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })) }
                : {}),
              ...(assistantFiles.length > 0 ? { files: assistantFiles } : {}),
            },
          ];
          if (result.resolvedProvider || result.resolvedModel) {
            appendToMessage(convoId, assistantMsg.id, (m) => ({
              ...m,
              ...(result.resolvedProvider ? { provider: result.resolvedProvider } : {}),
              ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
              ...(result.resolvedProxy !== undefined ? { proxy: result.resolvedProxy } : {}),
            }));
          }
          if ((model === "auto" || model.startsWith("auto/")) && result.resolvedModel) {
            // Direct mode already returns a fully-qualified "alias/modelId" (picked
            // client-side, see gateway/autoRoute.ts) that matches an entry in
            // `models` exactly. Gateway mode reports a possibly-bare id via the
            // X-OmniRoute-Model response header that needs reconciling against the fetched model
            // list to get the routable id — don't pin a bare/unqualified id the
            // gateway can't route on a later request ("Unable to determine
            // provider for model '...'").
            //
            // This only updates the local `effectiveModel` (so a same-turn
            // tool-loop round keeps using the model that already answered) —
            // it deliberately does NOT persist onto the conversation's own
            // `model` field. Auto-picked models on a keyless/no-key connection
            // can be a mixed bag (some free, some paid, some transiently down);
            // pickAuto()'s freeAccess/keyRequired exclusion and in-turn
            // failover only run while the conversation stays on "auto".
            // Persisting the resolved id here used to silently convert every
            // later message in the conversation into a direct pick of that
            // one model via resolveDirect() — no exclusion, no retry — so a
            // model that later needs a key or goes down would fail identically
            // forever until the user manually reopened the picker and chose
            // "Auto" again. `previousModel` (passed into chatStream above)
            // already gives pickAuto() a same-model *preference* without that
            // downside.
            const raw = result.resolvedModel;
            const resolved =
              modelsRef.current.find((m) => m.id === raw || m.id.endsWith(`/${raw}`))?.id ??
              (raw.includes("/") ? raw : undefined);
            if (resolved) effectiveModel = resolved;
          }
          if (toolCalls.length === 0 && preferences.autoMemory && preferences.memoryEnabled && !controller.signal.aborted) {
            const done = conversationsRef.current
              .find((c) => c.id === convoId)
              ?.messages.find((m) => m.id === assistantMsg.id);
            if (done?.content && !done.error) void extractMemory(convoId);
          }
          if (preferences.tokenOptimization && !controller.signal.aborted) {
            void maybeUpdateOldTierSummary(convoId);
          }
        } catch (err) {
          // Never fail silently: keep the assistant bubble and surface the error.
          const message = err instanceof Error ? err.message : String(err);
          appendToMessage(convoId, assistantMsg.id, (m) => ({ ...m, error: message }));
        } finally {
          abortRef.current = null;
          setStreaming(false);
          // Drop the placeholder if it produced nothing (aborted immediately or
          // a pure tool-call turn with no text). A file-only reply - the whole
          // answer inside a <fachoy-artifact> tag or a fenced code block, with
          // no surrounding chat prose - leaves `content` empty too, so `files`
          // must count as "produced something" or this deletes the answer.
          updateConvo(convoId, (c) => ({
            ...c,
            messages: c.messages.filter(
              (m) =>
                !(
                  m.id === assistantMsg.id &&
                  !m.content &&
                  !m.error &&
                  !m.reasoning &&
                  !(m.files && m.files.length > 0) &&
                  !(m.toolCalls && m.toolCalls.length > 0)
                )
            ),
          }));
        }
        return toolCalls;
      };

      const resolveToolCalls = async (skip = false): Promise<void> => {
        const last = liveMessages[liveMessages.length - 1];
        const calls = last?.toolCalls ?? [];
        const toolMsgs: ChatMessage[] = [];
        for (const call of calls) {
          let content = "";
          if (skip) {
            content = "Tool call skipped: maximum tool round limit reached.";
          } else {
            try {
              const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
              content = await runTool(call.name, args, { ...toolCtx, signal: abortRef.current?.signal }, turnTools);
            } catch (err) {
              content = `Error running tool "${call.name}": ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          const toolMsg: ChatMessage = {
            id: newId(),
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
            timestamp: Date.now(),
          };
          toolMsgs.push(toolMsg);
          updateConvo(convoId, (c) => ({
            ...c,
            updatedAt: Date.now(),
            messages: [...c.messages, toolMsg],
          }));
        }
        if (toolMsgs.length > 0) liveMessages = [...liveMessages, ...toolMsgs];
        if (skip && last) {
          appendToMessage(convoId, last.id, (m) => ({
            ...m,
            error: `Tool loop stopped after ${MAX_TOOL_ROUNDS} rounds - the assistant's last request wasn't completed.`,
          }));
        }
      };

      let effectiveModel = model;

      while (true) {
        rounds++;
        const calls = await runTurn();
        if (calls.length === 0) break;
        if (!toolLoopEnabled) break;
        if (rounds >= MAX_TOOL_ROUNDS) {
          await resolveToolCalls(true);
          break;
        }
        await resolveToolCalls();
      }
    },
    [
      activeSkillsRef,
      appendToMessage,
      applyArtifactEvent,
      caps.toolCalling,
      extractMemory,
      maybeUpdateOldTierSummary,
      preferences,
      skills,
      updateConvo,
    ]
  );

  /**
   * Activates a skill for a conversation — idempotent per (convoId, skillId),
   * so calling the same skill token twice across messages is a no-op. Awaits
   * the skill's bundled resources (when not already inlined on the record) so
   * buildPayload() always has them ready by the time the very turn that
   * called this skill is actually sent.
   */
  const activateSkillForConvo = useCallback(async (convoId: string, skill: Skill): Promise<void> => {
    if (activeSkillsRef.current.get(convoId)?.has(skill.id)) return;
    // IndexedDB is the source of truth for resource bodies: the localStorage
    // copy of a skill carries only a path/kind manifest (see stripResourceBodies),
    // so reading `skill.resources` first would inline empty files after a reload.
    const stored = await getSkillResources(skill.id);
    const resources = stored.length > 0 ? stored : (skill.resources ?? []);
    const convoSkills = activeSkillsRef.current.get(convoId) ?? new Map();
    if (convoSkills.has(skill.id)) return; // activated concurrently while awaiting
    convoSkills.set(skill.id, { resources: resources.length > 0 ? resources : [] });
    activeSkillsRef.current.set(convoId, convoSkills);
  }, []);

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (streaming || searching) return;
      let convoId = activeId;
      let model = defaultModel;
      let searchEnabled: boolean;

      // Search intent comes from the pending one-shot flag OR the current chat's
      // toggle state. Consumed exactly once so no stale search ever leaks through,
      // and so a fresh chat uses the value that reflects what the toggle showed.
      const consumeSearch =
        pendingSearchRef.current ||
        (activeId
          ? false
          : defaultSearchEnabled) ||
        (conversationsRef.current.find((c) => c.id === activeId)?.searchEnabled ?? false);
      searchEnabled = consumeSearch;
      pendingSearchRef.current = false;

      if (!convoId) {
        const id = newId();
        convoId = id;
        model = defaultModel;
        const isTemporary = defaultTemporary;
        setDefaultTemporary(false);
        const convo: Conversation = {
          id,
          title: isTemporary ? "Temporary Chat" : titleFrom(text),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: defaultModel,
          messages: [],
          searchEnabled,
          temporary: isTemporary,
        };
        setConversations((prev) => [convo, ...prev]);
        navigate(`/chat/${id}`);
      } else {
        const convo = conversationsRef.current.find((c) => c.id === convoId);
        model = convo?.model ?? defaultModel;
      }

      const userMsg: ChatMessage = {
        id: newId(),
        role: "user",
        content: text,
        attachments,
        timestamp: Date.now(),
      };
      const existing = conversationsRef.current.find((c) => c.id === convoId);
      const newMessages = [...(existing?.messages ?? []), userMsg];

      updateConvo(convoId, (c) => ({
        ...c,
        title: c.title === "New chat" ? titleFrom(text) : c.title,
        updatedAt: Date.now(),
        model,
        messages: newMessages,
      }));

      let searchNote: string | undefined;
      if (searchEnabled && text.trim()) {
        lastSearchConsumedId.current = convoId;
        const searchAbort = new AbortController();
        searchAbortRef.current = searchAbort;
        setSearching(true);
        try {
          const search = await webSearch(text, searchAbort.signal);
          updateConvo(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === userMsg.id ? { ...m, search } : m)),
          }));
          // Read the top hits server-side so the answer can quote exact facts.
          const excerpts = await readTopResults(search.results, 3, searchAbort.signal);
          searchNote = searchContextFor(search, excerpts, preferences.tokenOptimization);
        } catch (err) {
          const message =
            searchAbort.signal.aborted
              ? "Search cancelled"
              : err instanceof Error
                ? err.message
                : String(err);
          updateConvo(convoId, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === userMsg.id
                ? { ...m, search: { query: text, provider: "", results: [], error: message } }
                : m
            ),
          }));
        } finally {
          searchAbortRef.current = null;
          setSearching(false);
        }
      }

      // Activate every skill token embedded in the sent text (once each, in
      // first-occurrence order) — awaited so buildPayload() always has each
      // skill's resources ready by the time this very turn is sent.
      for (const skill of findSkillTokensInText(text, skills)) {
        await activateSkillForConvo(convoId, skill);
      }

      void runAssistant(convoId, model, newMessages, searchNote);
    },
    [
      activateSkillForConvo,
      activeId,
      defaultModel,
      defaultSearchEnabled,
      defaultTemporary,
      navigate,
      preferences.tokenOptimization,
      runAssistant,
      searching,
      skills,
      streaming,
      updateConvo,
    ]
  );

  const stop = useCallback(() => {
    searchAbortRef.current?.abort();
    abortRef.current?.abort();
    setSearching(false);
    setStreaming(false);
  }, []);

  const handleGenerate = useCallback(
    async (input: { mode: GenerationMode; prompt: string; model: string; image: string | File | null }) => {
      if (generating) return;
      let convoId = activeId;
      if (!convoId) {
        convoId = newId();
        const convo: Conversation = {
          id: convoId,
          title: titleFrom(input.prompt),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: defaultModel,
          messages: [],
        };
        setConversations((prev) => [convo, ...prev]);
        navigate(`/chat/${convoId}`);
      }

      setGenerating(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const mediaMsg: ChatMessage = {
        id: newId(),
        role: "assistant",
        content: "",
        model: input.model,
        timestamp: Date.now(),
      };

      const payload: ChatMessage = { ...mediaMsg, media: [] };

      // Let the user see a "working" placeholder immediately.
      updateConvo(convoId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, payload] }));

      try {
        const produced =
          input.mode === "video"
            ? await generateVideo({ prompt: input.prompt, model: input.model, signal: controller.signal })
            : input.mode === "edit"
              ? await editImages({
                  prompt: input.prompt,
                  image: input.image ?? "",
                  model: input.model,
                  signal: controller.signal,
                })
              : await generateImages({ prompt: input.prompt, model: input.model, signal: controller.signal });

        const caption =
          `**${input.mode === "video" ? "Generated video" : "Generated image"}**\n\n${input.prompt}` +
          (input.model && input.model !== "auto" ? `\n\n_Model: ${input.model}_` : "");

        setConversations((prev) =>
          prev.map((c) =>
            c.id === convoId
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === mediaMsg.id
                      ? { ...m, content: caption, media: produced }
                      : m
                  ),
                }
              : c
          )
        );
      } catch (err) {
        const message = controller.signal.aborted
          ? "Generation cancelled"
          : err instanceof Error
            ? err.message
            : String(err);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convoId
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === mediaMsg.id
                      ? { ...m, content: "", media: [], error: message }
                      : m
                  ),
                }
              : c
          )
        );
      } finally {
        abortRef.current = null;
        setGenerating(false);
        setGenRequest(null);
      }
    },
    [activeId, defaultModel, generating, navigate, updateConvo]
  );

  const openGenerate = useCallback(
    (mode: GenerationMode, opts?: { prompt?: string; image?: { dataUrl: string; name?: string } }) => {
      setGenRequest({ mode, prompt: opts?.prompt, image: opts?.image ?? null });
    },
    []
  );

  const closeGenerate = useCallback(() => {
    setGenRequest(null);
  }, []);

  const onOpenArtifact = useCallback((messageId: string, artifactId: string) => {
    setOpenArtifact({ messageId, artifactId });
  }, []);

  const onCloseArtifact = useCallback(() => {
    setOpenArtifact(null);
  }, []);

  const onEditArtifact = useCallback(
    (messageId: string, artifactId: string, content: string) => {
      if (!activeId) return;
      updateArtifact(activeId, messageId, artifactId, content);
    },
    [activeId, updateArtifact]
  );

  const onEditCodeBlock = useCallback(
    (messageId: string, key: string, content: string | null) => {
      if (!activeId) return;
      updateCodeBlock(activeId, messageId, key, content);
    },
    [activeId, updateCodeBlock]
  );

  // Reaches MessageBubble (an inline code block offers it when the runtime for
  // its language isn't installed), so it has to be reference-stable or every
  // bubble re-renders on each App render.
  const onOpenPlugins = useCallback(() => navigate("/plugins"), [navigate]);

  const onResizeArtifactPanel = useCallback((width: number) => {
    const clamped = Math.min(800, Math.max(320, width));
    setArtifactPanelWidth(clamped);
    localStorage.setItem("fachoy:artifactPanelWidth", String(clamped));
  }, []);

  const readDocument = useCallback(
    async (prompt: string, attachments: Attachment[]) => {
      if (streaming || searching) return;
      // Attach files directly via the normal send flow (the attachments carry
      // extracted text / images, so the LLM receives full document content).
      void sendMessage(prompt, attachments);
    },
    [sendMessage, streaming, searching]
  );

  // Auto-toggle web search off after assistant finishes streaming (one-shot):
  // only reset the chat that actually consumed a search, and only after that one
  // exchange completed — never on conversation creation or toggle, which was the
  // source of the "toggle doesn't work on a new chat" bug.
  useEffect(() => {
    if (!streaming && activeId && lastSearchConsumedId.current === activeId) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId && c.searchEnabled ? { ...c, searchEnabled: false } : c
        )
      );
      if (conversationsRef.current.find((c) => c.id === activeId)?.searchEnabled) {
        setDefaultSearchEnabled(false);
      }
      lastSearchConsumedId.current = null;
    }
  }, [streaming, activeId]);

  const retry = useCallback(
    (messageId: string) => {
      if (streaming || !activeId) return;
      const convo = conversationsRef.current.find((c) => c.id === activeId);
      if (!convo) return;
      const index = convo.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const kept = convo.messages.slice(0, index);
      updateConvo(activeId, (c) => ({ ...c, messages: kept, updatedAt: Date.now() }));
      const lastUser = [...kept].reverse().find((m) => m.role === "user");
      if (lastUser) void runAssistant(activeId, convo.model, kept);
    },
    [activeId, runAssistant, streaming, updateConvo]
  );

  const editMessage = useCallback(
    (messageId: string, newText: string) => {
      if (streaming || !activeId) return;
      const convo = conversationsRef.current.find((c) => c.id === activeId);
      if (!convo) return;
      const index = convo.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const target = convo.messages[index];
      if (target.role !== "user") return;
      // Keep messages up to (and including) the edited user message, replacing its
      // content, then regenerate the assistant reply that followed it.
      const edited: ChatMessage = { ...target, content: newText };
      const kept = [...convo.messages.slice(0, index), edited];
      updateConvo(activeId, (c) => ({ ...c, messages: kept, updatedAt: Date.now() }));
      void runAssistant(activeId, convo.model, kept);
    },
    [activeId, runAssistant, streaming, updateConvo]
  );

  const discardTemp = useCallback(() => {
    const isTemp = conversationsRef.current.find((c) => c.id === activeId)?.temporary;
    if (isTemp) navigate("/", { replace: true });
    setConversations((prev) => prev.filter((c) => !c.temporary));
  }, [activeId, navigate]);

  const newChat = useCallback(() => {
    // No id is minted here — the chat doesn't exist yet. sendMessage/
    // handleGenerate/useSkill already create a conversation (with a fresh id)
    // lazily on first use, the same way an already-empty "/" landing works.
    discardTemp();
    navigate("/");
  }, [discardTemp, navigate]);

  const selectChat = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const target = prev.find((c) => c.id === id);
        if (!target) return prev;
        // Leaving an empty chat discards it; temp chats are only kept while active.
        // `.filter()` always returns a new array reference even when nothing
        // actually changed — bail out to the same `prev` reference when it's
        // a no-op, so a plain chat switch doesn't trigger the
        // conversations-persistence effect (a full localStorage rewrite of
        // the user's entire history) for no reason. (Legacy fence migration
        // — messageMigrations.ts — happens separately, via the chunked
        // effect below, not here.)
        const filtered = prev.filter((c) => c.id === id || (!c.temporary && c.messages.length > 0));
        return filtered.length === prev.length ? prev : filtered;
      });
      navigate(`/chat/${id}`);
    },
    [navigate]
  );

  /**
   * Toggle temporary mode for the *next* message. Only meaningful before a
   * conversation has actually started: once a chat has a first message, it
   * has to stay whatever it already is, because flipping `temporary` on a
   * real conversation later gets it swept into the "discard all temporary
   * chats" filter and wipes it out. With no active chat yet (home page, or
   * an empty already-temporary chat), this just flips the pending default
   * rather than eagerly creating and navigating to a new conversation.
   */
  const toggleTemporary = useCallback(() => {
    if (activeId) {
      const convo = conversationsRef.current.find((c) => c.id === activeId);
      if (!convo || convo.messages.length > 0) return;
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, temporary: !c.temporary } : c))
      );
      return;
    }
    setDefaultTemporary((prev) => !prev);
  }, [activeId]);

  const toggleSearch = useCallback(() => {
    if (activeId) {
      setConversations((prev) => {
        const target = prev.find((c) => c.id === activeId);
        const next = target ? !target.searchEnabled : !defaultSearchEnabled;
        pendingSearchRef.current = next;
        return prev.map((c) => (c.id === activeId ? { ...c, searchEnabled: next } : c));
      });
    } else {
      setDefaultSearchEnabled((prev) => {
        const next = !prev;
        pendingSearchRef.current = next;
        return next;
      });
    }
  }, [activeId, defaultSearchEnabled]);

  const deleteChat = useCallback(
    (id: string) => {
      const next = conversationsRef.current.filter((c) => c.id !== id);
      setConversations(next);
      activeSkillsRef.current.delete(id);
      lastExtractedAssistantCount.current.delete(id);
      if (activeId === id) navigate(next[0] ? `/chat/${next[0].id}` : "/", { replace: true });
    },
    [activeId, navigate]
  );

  const deleteAllChats = useCallback(() => {
    stop();
    setConversations([]);
    void clearConversations();
    activeSkillsRef.current.clear();
    lastExtractedAssistantCount.current.clear();
    navigate("/", { replace: true });
  }, [navigate, stop]);

  const renameChat = useCallback(
    (id: string, title: string) => {
      updateConvo(id, (c) => ({ ...c, title, updatedAt: Date.now() }));
    },
    [updateConvo]
  );

  const selectModel = useCallback(
    (id: string) => {
      setDefaultModel(id);
      if (activeId) updateConvo(activeId, (c) => ({ ...c, model: id }));
    },
    [activeId, updateConvo]
  );

  const handleSaveSettings = useCallback(
    (next: GatewaySettings) => {
      saveSettings(next);
      setSettings(next);
      void refreshGateway();
    },
    [refreshGateway]
  );

  // One-time default-seed bootstrap: gatewaySettings.ts's getSettings() already
  // seeded keyless provider connections synchronously (see
  // withDefaultProviderSeed), so this only covers the two steps that need the
  // network - discovering their real model catalogs, and populating a starter
  // proxy pool via the same "smart selection" the free-proxy finder uses. Both
  // are flag-gated in defaultSeeding.ts and persist themselves; this effect
  // just reflects whatever they changed into UI state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const afterDiscovery = await ensureDefaultProviderDiscovery(settings);
      if (cancelled) return;
      if (afterDiscovery !== settings) setSettings(afterDiscovery);
      const afterProxies = await ensureDefaultProxies(afterDiscovery);
      if (cancelled) return;
      if (afterProxies !== afterDiscovery) setSettings(afterProxies);
      if (afterDiscovery !== settings || afterProxies !== afterDiscovery) void refreshGateway();
    })();
    return () => {
      cancelled = true;
    };
    // Runs exactly once on mount - settings/refreshGateway are read from the
    // closure over the initial values deliberately, since this is a one-shot
    // bootstrap, not a subscription to later settings changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTestConnection = useCallback(async (connection: ProviderConnection) => {
    return testProviderConnection(connection);
  }, []);

  const handleTestGateway = useCallback(async (baseUrl: string, apiKey: string) => {
    return testGatewayConnection(baseUrl, apiKey);
  }, []);

  /** `relayUrl` carries the unsaved Settings draft, so a relay can be tried before it is saved. */
  const handleTestProxy = useCallback(
    async (proxy: CustomProxy, relayUrl?: string, allowInsecureProxyTls?: boolean): Promise<ProxyTestResult> => {
      return testProxyConnection(proxy, relayUrl, allowInsecureProxyTls);
    },
    []
  );

  const handleExportBackup = useCallback(async () => {
    const blob = await exportBackup({
      conversations: conversationsRef.current,
      preferences,
      tasks,
      skills,
      providers: settings.providers,
      proxies: settings.proxies,
      proxiesEnabled: settings.proxiesEnabled,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupFilename();
    a.click();
    URL.revokeObjectURL(url);
  }, [preferences, tasks, skills, settings]);

  /** Merge saved items, and restore the master proxy choice when the backup includes it. */
  const handleImportBackup = useCallback(
    async (file: File): Promise<string> => {
      const payload = parseBackup(await file.arrayBuffer());
      const parts: string[] = [];

      const convos = mergeById(conversationsRef.current, payload.conversations);
      if (convos.added > 0) setConversations(convos.merged);
      parts.push(`${convos.added} chat${convos.added === 1 ? "" : "s"}`);

      if (payload.skills?.length) {
        const restored = await restoreSkills(skillsRef.current, payload.skills);
        if (restored.added > 0) setSkills(restored.merged);
        parts.push(`${restored.added} skill${restored.added === 1 ? "" : "s"}`);
      }

      if (payload.tasks?.length) {
        const merged = mergeById(tasks, payload.tasks);
        for (const task of payload.tasks) {
          if (!tasks.some((t) => t.id === task.id)) await importTask(task);
        }
        if (merged.added > 0) await refreshTasks();
        parts.push(`${merged.added} task${merged.added === 1 ? "" : "s"}`);
      }

      if (payload.preferences?.memories?.length) {
        const merged = mergeById(preferences.memories, payload.preferences.memories);
        if (merged.added > 0) setPreferences((p) => ({ ...p, memories: merged.merged }));
        parts.push(`${merged.added} memor${merged.added === 1 ? "y" : "ies"}`);
      }

      // Credentials are never in the backup (see backup.ts) — a restored
      // provider/proxy lands disabled-of-key, re-entered once in Settings.
      let settingsNext = settings;
      let restoredCredentialed = false;
      if (payload.providers?.length) {
        const incoming = payload.providers.map((p) => ({ ...p, apiKey: "" }));
        const merged = mergeById(settingsNext.providers, incoming);
        if (merged.added > 0) {
          settingsNext = { ...settingsNext, providers: merged.merged };
          restoredCredentialed = true;
        }
        parts.push(`${merged.added} provider${merged.added === 1 ? "" : "s"}`);
      }
      if (payload.proxies?.length) {
        // A v2 archive carries CORS-template proxies, which the real-proxy
        // transport cannot use. Running them through the same migration as the
        // ones in localStorage drops them here too, rather than merging entries
        // that would be dead on arrival.
        const { proxies: incoming } = migrateProxies(
          payload.proxies.map((p) => ({ ...p, password: undefined }))
        );
        const merged = mergeById(settingsNext.proxies, incoming);
        if (merged.added > 0) {
          settingsNext = { ...settingsNext, proxies: merged.merged };
          restoredCredentialed = true;
        }
        parts.push(`${merged.added} prox${merged.added === 1 ? "y" : "ies"}`);
      }
      settingsNext = restoreProxyMasterSetting(settingsNext, payload);
      if (typeof payload.proxiesEnabled === "boolean") parts.push(`proxy routing ${payload.proxiesEnabled ? "on" : "off"}`);
      if (settingsNext !== settings) {
        setSettings(settingsNext);
        saveSettings(settingsNext);
      }

      return `Imported ${parts.join(", ")}.${
        restoredCredentialed ? " Re-add API keys/auth for the restored provider(s)/proxy(ies) in Settings." : ""
      }`;
    },
    [preferences.memories, tasks, refreshTasks, settings]
  );

  const handleSavePreferences = useCallback((next: Preferences) => {
    setPreferences(next);
  }, []);

  const handleSaveSkills = useCallback((next: Skill[]) => {
    setSkills(next);
  }, []);

  const handleCreateTask = useCallback(
    async (input: TaskInput) => {
      await createTask(input);
      await refreshTasks();
    },
    [refreshTasks]
  );

  const handleUpdateTask = useCallback(
    async (id: string, patch: Partial<TaskInput>) => {
      await updateTask(id, patch);
      await refreshTasks();
    },
    [refreshTasks]
  );

  const handleDeleteTask = useCallback(
    async (id: string) => {
      await deleteTask(id);
      await refreshTasks();
    },
    [refreshTasks]
  );

  const handleRunTaskNow = useCallback(
    async (id: string) => {
      await runTaskNow(id);
      await refreshTasks();
    },
    [refreshTasks]
  );

  const resolvedOpenArtifact = openArtifact
    ? (() => {
        const msg = activeConversation?.messages.find((m) => m.id === openArtifact.messageId);
        const artifact = msg?.files?.find((f) => f.id === openArtifact.artifactId);
        return artifact
          ? {
              messageId: openArtifact.messageId,
              artifact,
              resolvedModel: msg?.resolvedModel,
              provider: msg?.provider,
            }
          : null;
      })()
    : null;

  const chatView = (
    <ChatView
      conversation={activeConversation}
      model={currentModel}
      streaming={streaming}
      searching={searching}
      caps={caps}
      skills={skills}
      activeSkillNames={activeSkillNames}
      temporary={activeConversation?.temporary ?? defaultTemporary}
      searchEnabled={activeConversation?.searchEnabled ?? defaultSearchEnabled}
      models={models}
      capabilityIndex={capabilityIndex}
      genRequest={genRequest}
      generating={generating}
      onToggleSearch={toggleSearch}
      onToggleTemporary={toggleTemporary}
      onSend={sendMessage}
      onStop={stop}
      onEditMessage={editMessage}
      onOpenModelPicker={() => setModelPickerOpen(true)}
      onRenameConversation={renameChat}
      onRetry={retry}
      onOpenGenerate={openGenerate}
      onCloseGenerate={closeGenerate}
      onGenerate={(input) => void handleGenerate(input)}
      onReadDocument={(prompt, atts) => void readDocument(prompt, atts)}
      openArtifact={resolvedOpenArtifact}
      artifactPanelWidth={artifactPanelWidth}
      onOpenArtifact={onOpenArtifact}
      onCloseArtifact={onCloseArtifact}
      onEditArtifact={onEditArtifact}
      onEditCodeBlock={onEditCodeBlock}
      onResizeArtifactPanel={onResizeArtifactPanel}
      onOpenPlugins={onOpenPlugins}
    />
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        collapsed={ui.sidebarCollapsed}
        tasksViewActive={location.pathname === "/tasks"}
        libraryViewActive={location.pathname.startsWith("/library")}
        storeViewActive={location.pathname.startsWith("/store")}
        agentsViewActive={location.pathname.startsWith("/agents")}
        onToggleCollapse={() => setUi((u) => ({ ...u, sidebarCollapsed: !u.sidebarCollapsed }))}
        onNewChat={newChat}
        onSelect={selectChat}
        onDelete={deleteChat}
        onDeleteAll={deleteAllChats}
        onRename={renameChat}
        onOpenSettings={openSettings}
        status={status}
        providerSummary={providerSummary}
        pendingMemoryCount={preferences.pendingMemories.length}
        updateAvailable={updateAvailable}
      />

      <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {ui.sidebarCollapsed && (
          <Tooltip label="Expand sidebar">
            <button
              type="button"
              onClick={() => setUi((u) => ({ ...u, sidebarCollapsed: false }))}
              className="absolute left-3 top-3 z-10 hidden rounded-full border border-border bg-bg-elevated p-2 text-fg-dim shadow-lift hover:text-fg md:flex"
            >
              <PanelLeftOpen size={16} />
            </button>
          </Tooltip>
        )}
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={chatView} />
            <Route path="/chat/:id" element={chatView} />
            <Route
              path="/tasks"
              element={
                <TasksView
                  tasks={tasks}
                  onRefresh={refreshTasks}
                  onCreate={handleCreateTask}
                  onUpdate={handleUpdateTask}
                  onDelete={handleDeleteTask}
                  onRunNow={handleRunTaskNow}
                />
              }
            />
            <Route
              path="/library"
              element={
                <LibraryView skills={skills} onSaveSkills={handleSaveSkills} />
              }
            />
            <Route path="/store" element={<StoreView skills={skills} onSaveSkills={handleSaveSkills} />} />
            <Route
              path="/agents"
              element={<AgentBuilderView agents={agents} onSaveAgents={setAgents} skills={skills} models={models} />}
            />
            <Route
              path="/changelog"
              element={<ChangelogView onRequestUpdate={() => setShowUpdatePrompt(true)} />}
            />
            {/* Two addressable pages, one component - see PrivacyView. */}
            <Route path="/features" element={<PrivacyView />} />
            <Route path="/privacy" element={<PrivacyView />} />
            <Route path="/about" element={<AboutView />} />
            {/* Previous paths, kept so existing links and bookmarks resolve.
                Mirrored by SEO_REDIRECTS and by the server's 301s. */}
            <Route path="/skills" element={<Navigate to="/library" replace />} />
            <Route path="/plugins" element={<Navigate to="/store" replace />} />
            {/* A real 404 page, not a redirect home: the server answers these
                with a 404 status, and the two must agree. */}
            <Route path="*" element={<NotFoundView />} />
          </Routes>
        </Suspense>
      </main>

      <ModelPickerModal
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        models={models}
        index={capabilityIndex}
        current={currentModel}
        onSelect={selectModel}
        onOpenSettings={() => openSettings("providers")}
      />
      <LocalModelProgress />
      <AnalyticsConsentBar />
      <BrowserDock />
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        onTestConnection={handleTestConnection}
        onTestGateway={handleTestGateway}
        onTestProxy={handleTestProxy}
        onExportBackup={handleExportBackup}
        onImportBackup={handleImportBackup}
        theme={ui.theme}
        onThemeChange={changeTheme}
        preferences={preferences}
        onSavePreferences={handleSavePreferences}
      />
      <ConfirmDialog
        open={showUpdatePrompt}
        onClose={() => setShowUpdatePrompt(false)}
        onConfirm={applyUpdate}
        title={`Update ${APP_NAME}?`}
        tone="default"
        confirmLabel="Update"
        message={
          <>
            {pendingChangelog.length > 0 && (
              <div className="mb-4 space-y-3">
                {pendingChangelog.map((entry) => (
                  <div key={entry.version}>
                    <div className="flex items-baseline gap-2">
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-xs font-medium text-accent">
                        v{entry.version}
                      </span>
                      <span className="text-xs text-fg-faint">{entry.date}</span>
                    </div>
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-sm text-fg-dim">
                      {entry.items.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            Reloading will lose any unsent message or in-progress reply.
          </>
        }
      />
    </div>
  );
}
