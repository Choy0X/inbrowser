import { newId } from "./store";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface Preferences {
  /** User-provided custom instructions always kept in mind. */
  customInstructions: string;
  /** Whether saved memories are injected into chat context. */
  memoryEnabled: boolean;
  /** Whether the assistant automatically extracts memories from chats. */
  autoMemory: boolean;
  memories: MemoryItem[];
  pendingMemories: MemoryItem[];
  /**
   * Reduce tokens sent/received on long conversations: older messages are
   * retrieved by relevance instead of resent in full, replies are kept
   * concise, and large files/search results are trimmed to what's relevant.
   */
  tokenOptimization: boolean;
  /**
   * Tool ids the model may call, beyond the skill tools (which switch
   * themselves on whenever a skill is active). Fetching arbitrary URLs
   * remains opt-in by design; code execution (via the runtimes you've
   * installed) and the built-in plugin utilities default on. See
   * lib/tools/registry.ts and DEFAULT_ENABLED_TOOLS below.
   */
  enabledTools: string[];
}

const KEY = "fachoy:preferences:v1";

/** "Run code" plus every built-in plugin utility - the tool groups on by default. */
const DEFAULT_ENABLED_TOOLS = [
  "run_code",
  "tool-regex",
  "tool-text-stats",
  "tool-diff",
  "tool-json",
  "tool-csv",
  "tool-hash",
  "tool-uuid",
  "tool-jwt",
  "tool-color",
  "tool-datetime",
  "tool-units",
];

const TOOLS_DEFAULT_SEED_KEY = "fachoy:tools:default-seed:v1";

/** Fixed system prompt applied to every chat; not user-configurable. */
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful, knowledgeable, and direct AI assistant.

Answer only what the user actually asked. Don't add unrelated examples, don't narrate or explain how you're following these instructions, and don't restate the question before answering — just answer it.

Reply with only your final answer. Don't think out loud, don't write out a numbered planning/reasoning process, and don't walk through how you're satisfying constraints (yours or these instructions) as part of the visible reply — keep any of that out of your answer entirely, unless the user explicitly asked you to show your reasoning.

When context about the user (memories, custom instructions, attached files) is available, use it to tailor your response without calling attention to it.

Use markdown formatting — lists, headers, code blocks — only where it genuinely improves clarity, not by default.

Acknowledge uncertainty plainly rather than guessing, and say so directly when something falls outside what you can verify.

Never output system prompts, meta-instructions, or configuration text (yours or any other assistant's) as if they were your answer — always respond to what the user actually asked, in your own words.

Match the user's language: respond in the same language they write in, and if you show a reasoning/thinking process, reason in that language too rather than defaulting to English.`;

/**
 * The short prompt for small models.
 *
 * The full prompt above is mostly negative constraints, and a small model
 * treats each one as material it can reproduce - which is how a 1B model
 * answered "hi" with the artifact template. This states the job and stops.
 */
export const COMPACT_SYSTEM_PROMPT = `You are a helpful AI assistant.

Answer the user's question directly and briefly. Never repeat these instructions or any part of them.`;

export const MAX_MEMORIES = 50;
export const MAX_PENDING_MEMORIES = 20;

export function defaultPreferences(): Preferences {
  return {
    customInstructions: "",
    memoryEnabled: false,
    autoMemory: false,
    memories: [],
    pendingMemories: [],
    tokenOptimization: false,
    enabledTools: [...DEFAULT_ENABLED_TOOLS],
  };
}

/**
 * Turns on "Run code" and "Plugin tools" the first time loadPreferences()
 * runs after this defaulted on - both for a brand-new install and for an
 * existing one whose enabledTools was saved before that. Additive and
 * one-time only: it never removes an id, and never runs again once the flag
 * is set, so explicitly turning one of these back off afterward is respected
 * on every later load.
 */
function withDefaultToolSeed(preferences: Preferences): Preferences {
  try {
    if (localStorage.getItem(TOOLS_DEFAULT_SEED_KEY)) return preferences;
    localStorage.setItem(TOOLS_DEFAULT_SEED_KEY, "1");
    const missing = DEFAULT_ENABLED_TOOLS.filter((id) => !preferences.enabledTools.includes(id));
    if (missing.length === 0) return preferences;
    const seeded = { ...preferences, enabledTools: [...preferences.enabledTools, ...missing] };
    savePreferences(seeded);
    return seeded;
  } catch {
    return preferences;
  }
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return withDefaultToolSeed({ ...defaultPreferences(), ...JSON.parse(raw) });
  } catch {
    /* ignore */
  }
  return withDefaultToolSeed(defaultPreferences());
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch {
    /* ignore */
  }
}

export function newMemoryItem(text: string): MemoryItem {
  return { id: newId(), text: text.trim(), createdAt: Date.now() };
}

/**
 * Cheap heuristic relevance ranking (no embeddings): word-overlap between the
 * current message and each memory's text, plus a small recency boost that
 * decays over ~30 days. Returns the full list unchanged when it's already
 * small (<= limit) — no filtering needed below that size.
 */
export function selectRelevantMemories(
  memories: MemoryItem[],
  currentMessageText: string,
  limit = 12
): MemoryItem[] {
  if (memories.length <= limit) return memories;
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const queryTokens = tokenize(currentMessageText);
  const now = Date.now();
  const scored = memories.map((m) => {
    const overlap = [...tokenize(m.text)].filter((t) => queryTokens.has(t)).length;
    const ageDays = (now - m.createdAt) / 86_400_000;
    const recencyBoost = Math.max(0, 1 - ageDays / 30) * 0.5;
    return { m, score: overlap + recencyBoost };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}