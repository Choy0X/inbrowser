/**
 * The one auto-routing classifier engine for direct mode (client-side,
 * provider-diverse routing).
 *
 * Ported from OmniRoute's real auto-routing source
 * (open-sse/services/autoCombo/*.ts, open-sse/services/specificity*.ts —
 * github.com/diegosouzapw/OmniRoute), scaled down to what a stateless,
 * no-backend, no-DB, no-LLM-call browser app can actually compute: the
 * complexity/specificity heuristics, the static task-fitness table, the
 * self-healing exclusion state machine, and a condensed multi-factor score.
 * Dropped entirely: quota %, account tier, prompt-cache/session affinity,
 * quota reset windows, connection-pool density, and the feedback-quality
 * DB — those need server-side account infrastructure this app doesn't have.
 * No factor here ever calls an LLM; every signal is a regex/heuristic scan
 * or in-memory stat.
 */
import type { ChatMessageInput, ToolDef } from "./types";
import { isSmallModel } from "../modelSize";

// ─── request text extraction ─────────────────────────────────────────────

function textOf(content: ChatMessageInput["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: ChatMessageInput[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(textOf(m.content)), 0);
}

// ─── specificity/complexity detectors (ported from specificityRules.ts) ──

export interface SpecificityBreakdown {
  codeComplexity: number;
  mathComplexity: number;
  reasoningDepth: number;
  contextSize: number;
  toolCalling: number;
  domainSpecificity: number;
}

interface RuleInput {
  allText: string;
  messages: ChatMessageInput[];
  tools?: ToolDef[];
  systemPrompt?: string;
}

function detectCodeComplexity({ allText }: RuleInput): number {
  const codeBlocks = allText.match(/```[\s\S]*?```/g)?.length ?? 0;
  const inlineCode = allText.match(/`[^`]+`/g)?.length ?? 0;
  const langIndicators = [
    /function\s+\w+\s*\(/gi,
    /const\s+\w+\s*=/gi,
    /import\s+.*from/gi,
    /class\s+\w+/gi,
    /interface\s+\w+/gi,
    /async\s+function/gi,
    /def\s+\w+\s*\(/gi,
    /SELECT\s+.*FROM/gi,
    /\$\{.*\}/g,
  ];
  const langMatches = langIndicators.reduce((sum, re) => sum + (allText.match(re)?.length ?? 0), 0);
  return Math.min(25, Math.round(codeBlocks * 5 + inlineCode * 0.5 + langMatches * 2));
}

function detectMathComplexity({ allText }: RuleInput): number {
  const latex = allText.match(/\$\$[\s\S]*?\$\$|\$[^$]+\$/g)?.length ?? 0;
  const mathIndicators = [
    /[+\-*/^]=/g,
    /\b(sin|cos|tan|log|sqrt|sum|prod|int|lim)\s*\(/gi,
    /\b\d+\s*[+\-*/]\s*\d+\s*=/g,
    /∑|∏|∫|√|∞|π/g,
    /\b[a-z]'\s*\(/gi,
  ];
  const mathMatches = mathIndicators.reduce((sum, re) => sum + (allText.match(re)?.length ?? 0), 0);
  return Math.min(20, Math.round(latex * 4 + mathMatches * 1.5));
}

function detectReasoningDepth({ allText, messages }: RuleInput): number {
  // Numbered structure is a weak signal, independent of the prose language.
  const structuredSteps = allText.match(/^\s*\p{Nd}+[.)]\s+\S/gmu)?.length ?? 0;
  const messageDepthBonus = Math.min(5, messages.length);
  return Math.min(20, structuredSteps * 2 + messageDepthBonus);
}

function detectContextSize({ messages, tools, systemPrompt }: RuleInput): number {
  const toolTokens = (tools ?? []).reduce((sum, t) => sum + estimateTokens(JSON.stringify(t.function)), 0);
  const total = estimateMessageTokens(messages) + (systemPrompt ? estimateTokens(systemPrompt) : 0) + toolTokens;
  if (total > 100000) return 15;
  if (total > 64000) return 13;
  if (total > 32000) return 10;
  if (total > 16000) return 7;
  if (total > 8000) return 5;
  if (total > 4000) return 3;
  if (total > 1000) return 1;
  return 0;
}

function detectToolCalling({ tools }: RuleInput): number {
  const toolCount = tools?.length ?? 0;
  if (toolCount === 0) return 0;
  if (toolCount > 20) return 10;
  if (toolCount > 10) return 8;
  if (toolCount > 5) return 6;
  if (toolCount > 2) return 4;
  return 2;
}

function getSpecificityBreakdown(input: RuleInput): SpecificityBreakdown {
  return {
    codeComplexity: detectCodeComplexity(input),
    mathComplexity: detectMathComplexity(input),
    reasoningDepth: detectReasoningDepth(input),
    contextSize: detectContextSize(input),
    toolCalling: detectToolCalling(input),
    domainSpecificity: 0,
  };
}

export type SpecificityLevel = "trivial" | "simple" | "moderate" | "complex" | "expert";
export type Tier = "free" | "cheap" | "premium";

function getSpecificityLevel(score: number): SpecificityLevel {
  if (score <= 5) return "trivial";
  if (score <= 20) return "simple";
  if (score <= 40) return "moderate";
  if (score <= 65) return "complex";
  return "expert";
}

function getRecommendedMinTier(level: SpecificityLevel): Tier {
  if (level === "trivial" || level === "simple") return "free";
  if (level === "moderate" || level === "complex") return "cheap";
  return "premium";
}

/** Inferred purely from which breakdown category dominates — no DB, no LLM call. */
export type TaskType = "coding" | "domain" | "default";

function inferTaskType(b: SpecificityBreakdown): TaskType {
  if (b.codeComplexity > 0 && b.codeComplexity >= b.domainSpecificity) return "coding";
  if (b.domainSpecificity > 0) return "domain";
  return "default";
}

export interface RequestProfile {
  inputTokens?: number;
  needsVision?: boolean;
  needsTools?: boolean;
  score: number;
  level: SpecificityLevel;
  recommendedMinTier: Tier;
  taskType: TaskType;
  breakdown: SpecificityBreakdown;
}

/** Classify the outgoing request. Pure function over the request shape — zero network/LLM calls. */
export function classifyRequest(
  messages: ChatMessageInput[],
  tools?: ToolDef[],
  systemPrompt?: string
): RequestProfile {
  // Old assistant answers should not dictate the intent of a new question.
  // Keep full history for context budgeting, but classify the current turn.
  const lastUser = messages.findLastIndex(m => m.role === "user");
  const allText = messages.slice(Math.max(0, lastUser)).map((m) => textOf(m.content)).join("\n");
  const breakdown = getSpecificityBreakdown({ allText, messages, tools, systemPrompt });
  const structuralScore = Math.min(
    100,
    breakdown.codeComplexity +
      breakdown.mathComplexity +
      breakdown.reasoningDepth +
      breakdown.contextSize +
      breakdown.toolCalling +
      breakdown.domainSpecificity
  );
  // Missing structural evidence means unknown intent, not a trivial task.
  const unknownTask = breakdown.codeComplexity === 0 && breakdown.mathComplexity === 0;
  const score = unknownTask ? Math.max(21, structuralScore) : structuralScore;
  const level = getSpecificityLevel(score);
  // Count the actual wire payload, including tool calls and schemas. Images
  // need their own budget rather than treating base64 characters as text.
  const needsVision = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"));
  const inputTokens = messages.reduce((sum, m) => sum + 8 + estimateTokens(textOf(m.content)) +
    (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) +
    (Array.isArray(m.content) ? m.content.filter(p => p.type === "image_url").length * 2048 : 0), 0) +
    estimateTokens(JSON.stringify(tools ?? [])) +
    (systemPrompt && !messages.some(m => m.role === "system" && textOf(m.content) === systemPrompt) ? estimateTokens(systemPrompt) : 0);
  return { score, level, recommendedMinTier: getRecommendedMinTier(level), taskType: inferTaskType(breakdown), breakdown,
    inputTokens, needsVision, needsTools: Boolean(tools?.length) || messages.some(m => m.role === "tool" || m.tool_calls?.length) };
}

// ─── cost estimate + tier bucket (existing COST_HINTS, extended with a tier bucket) ──

const COST_HINTS: [RegExp, number][] = [
  [/nano|mini|haiku|flash-lite|8b/i, 1],
  [/flash|small|lite/i, 2],
  [/gpt-4o|sonnet|flash-thinking/i, 6],
  [/opus|gpt-4\.5|o1-pro|ultra/i, 20],
];
const costCache = new Map<string, number>();

function estimateCost(modelId: string): number {
  const cached = costCache.get(modelId);
  if (cached !== undefined) return cached;
  let cost = 5;
  for (const [pattern, hint] of COST_HINTS) {
    if (pattern.test(modelId)) {
      cost = hint;
      break;
    }
  }
  costCache.set(modelId, cost);
  return cost;
}

function costTier(modelId: string): Tier {
  const cost = estimateCost(modelId);
  if (cost <= 1) return "free";
  if (cost <= 6) return "cheap";
  return "premium";
}

function tierAffinity(modelId: string, recommendedMinTier: Tier): number {
  const order: Tier[] = ["free", "cheap", "premium"];
  const diff = Math.abs(order.indexOf(costTier(modelId)) - order.indexOf(recommendedMinTier));
  if (diff === 0) return 1.0;
  if (diff === 1) return 0.7;
  return 0.3;
}

// ─── static task-fitness table (condensed port of taskFitness.ts, layer 4 only) ──

const FITNESS_TABLE: Record<TaskType, Record<string, number>> = {
  coding: {
    "claude-sonnet": 0.95,
    "claude-opus": 0.92,
    "claude-haiku": 0.78,
    "gpt-4o-mini": 0.8,
    "gpt-4o": 0.9,
    "gpt-4-turbo": 0.88,
    o3: 0.95,
    o1: 0.93,
    "gemini-2.5-flash": 0.82,
    "gemini-2.5-pro": 0.92,
    "gemini-flash": 0.8,
    "gemini-pro": 0.85,
    "deepseek-coder": 0.9,
    "deepseek-v3": 0.85,
    "deepseek-r1": 0.88,
    qwen: 0.78,
    llama: 0.72,
    mistral: 0.75,
  },
  domain: {
    "claude-opus": 0.95,
    "claude-sonnet": 0.9,
    "gemini-2.5-pro": 0.93,
    "gemini-pro": 0.88,
    "gpt-4o": 0.88,
    o1: 0.9,
    o3: 0.93,
    "deepseek-r1": 0.85,
  },
  default: {
    "claude-sonnet": 0.85,
    "claude-opus": 0.85,
    "gpt-4o": 0.85,
    "gemini-pro": 0.8,
    "deepseek-v3": 0.75,
    "gemini-flash": 0.72,
  },
};

const WILDCARD_BOOSTS: { pattern: string; taskType: TaskType; boost: number }[] = [
  { pattern: "coder", taskType: "coding", boost: 0.15 },
  { pattern: "code", taskType: "coding", boost: 0.1 },
  { pattern: "thinking", taskType: "domain", boost: 0.1 },
];

/** Longest-pattern-first match, porting OmniRoute's fix for a shorter pattern
 *  ("gpt-4o") shadowing a more specific one ("gpt-4o-mini") in match order. */
function staticFitnessScore(modelId: string, taskType: TaskType): number | null {
  const normalized = modelId.toLowerCase();
  const table = FITNESS_TABLE[taskType] ?? FITNESS_TABLE.default;
  const entries = Object.entries(table).sort((a, b) => b[0].length - a[0].length);
  for (const [pattern, score] of entries) {
    if (normalized.includes(pattern)) return score;
  }
  return null;
}

function wildcardFitnessScore(modelId: string, taskType: TaskType): number {
  const normalized = modelId.toLowerCase();
  let score = 0.5;
  for (const wc of WILDCARD_BOOSTS) {
    if (taskType === wc.taskType && normalized.includes(wc.pattern)) score += wc.boost;
  }
  return Math.min(1.0, score);
}

function getTaskFitness(modelId: string, taskType: TaskType): number {
  return staticFitnessScore(modelId, taskType) ?? wildcardFitnessScore(modelId, taskType);
}

// ─── recorded stats (health/latency/stability) ───────────────────────────

export interface Stats {
  updatedAt?: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  /** Last N latencies, for a rolling stddev (stability factor). */
  recentLatencies: number[];
  /** Last N outcomes (true=success), most recent last. Health is derived from
   *  this window, not the lifetime successes/failures above — a model that's
   *  failing right now should lose trust quickly regardless of how good its
   *  history was (that's the whole reported bug: a model with a long history
   *  of successes kept a high lifetime ratio long after it started failing
   *  every call). */
  recentOutcomes: boolean[];
}

const MAX_RECENT_LATENCIES = 10;
const MAX_RECENT_OUTCOMES = 10;

interface ExclusionEntry {
  excludedAt: number;
  cooldownMs: number;
  retryAfterUntil?: number;
}

/**
 * One tracking scope: model-level (key = "alias/modelId") or connection-level
 * (key = alias). The exact same stats/exclusion/cooldown machinery runs for
 * both — a connection with a cratering recent success rate (bad key, wrong
 * base URL, requires a signed-in session) gets deprioritized as a whole,
 * instead of requiring every one of its models to independently fail enough
 * times first. That's the main fix for one broken provider poisoning "auto"
 * across a catalog of thousands of models.
 */
export interface HealthStore {
  stats: Map<string, Stats>;
  exclusions: Map<string, ExclusionEntry>;
}

export function createHealthStore(): HealthStore {
  return { stats: new Map(), exclusions: new Map() };
}

const modelStore: HealthStore = createHealthStore();
const connectionStore: HealthStore = createHealthStore();
const modelLoad = new Map<string, number>();
const connectionLoad = new Map<string, number>();

/** Reserve only an actual attempt, never a speculative routing lookup. */
export function beginModelAttempt(key: string): () => void {
  const connection = connectionKeyOf(key);
  modelLoad.set(key, (modelLoad.get(key) ?? 0) + 1);
  connectionLoad.set(connection, (connectionLoad.get(connection) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const [store, id] of [[modelLoad, key], [connectionLoad, connection]] as const) {
      const remaining = (store.get(id) ?? 1) - 1;
      if (remaining > 0) store.set(id, remaining); else store.delete(id);
    }
  };
}

/** Model keys are "alias/modelId" — the connection's alias is everything
 *  before the first "/", the same convention resolveDirect() relies on. */
function connectionKeyOf(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  return slash === -1 ? modelKey : modelKey.slice(0, slash);
}

export function getStats(store: HealthStore, key: string): Stats {
  let s = store.stats.get(key);
  if (!s) {
    s = { successes: 0, failures: 0, totalLatencyMs: 0, recentLatencies: [], recentOutcomes: [] };
    store.stats.set(key, s);
  }
  return s;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── self-healing exclusion (ported from selfHealing.ts) ────────────────
// The real answer to "if a model is not working then move to another one":
// persistent, cooldown-based exclusion that survives across separate user
// turns (not just a within-retry excluded set), with automatic re-admission.

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;
const EXCLUSION_THRESHOLD = 0.2;

export function isCoolingDown(store: HealthStore, key: string, now = Date.now()): boolean {
  const entry = store.exclusions.get(key);
  return entry ? now - entry.excludedAt < entry.cooldownMs : false;
}

function evaluateHealth(store: HealthStore, key: string, healthScore: number, cooldownOverrideMs?: number): void {
  const entry = store.exclusions.get(key);
  const now = Date.now();
  if (healthScore < EXCLUSION_THRESHOLD || entry) {
    if (entry) {
      entry.cooldownMs = cooldownOverrideMs ?? Math.min(entry.cooldownMs * 2, MAX_COOLDOWN_MS);
      entry.excludedAt = now;
      if (cooldownOverrideMs !== undefined) entry.retryAfterUntil = now + cooldownOverrideMs;
    } else {
      store.exclusions.set(key, { excludedAt: now, cooldownMs: cooldownOverrideMs ?? DEFAULT_COOLDOWN_MS,
        retryAfterUntil: cooldownOverrideMs === undefined ? undefined : now + cooldownOverrideMs });
    }
    return;
  }
}

/** Recency-weighted: the neutral 0.7 prior until enough recent samples exist,
 *  then the recent-window success ratio. */
export function healthFactor(store: HealthStore, key: string): number {
  const s = getStats(store, key);
  // A small prior prevents one lucky success from outranking established
  // routes, while failures influence the very next decision.
  const successCount = s.recentOutcomes.filter(Boolean).length;
  const confidence = Math.exp(-Math.max(0, Date.now() - (s.updatedAt ?? Date.now())) / (30 * 60 * 1000));
  return 0.7 + confidence * ((2.1 + successCount) / (3 + s.recentOutcomes.length) - 0.7);
}

/** Recent exponentially weighted response latency, with a neutral cold start. */
export function recentLatency(store: HealthStore, key: string): number {
  return getStats(store, key).recentLatencies.reduce((avg, value) => avg * 0.65 + value * 0.35, 2000);
}

/** Blend of model-level and connection-level recent health — a connection-wide
 *  problem deprioritizes all its models even before any single one individually
 *  racks up enough failures on its own. */
function blendedHealth(key: string): number {
  const modelHealth = healthFactor(modelStore, key);
  const connHealth = healthFactor(connectionStore, connectionKeyOf(key));
  return 0.6 * modelHealth + 0.4 * connHealth;
}

export function recordStoreOutcome(
  store: HealthStore,
  key: string,
  ok: boolean,
  latencyMs: number,
  hardFailure: boolean,
  cooldownOverrideMs?: number
): void {
  const s = getStats(store, key);
  s.updatedAt = Date.now();
  if (ok) {
    s.successes += 1;
    const safeLatency = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 2000;
    s.totalLatencyMs += safeLatency;
    s.recentLatencies.push(safeLatency);
    if (s.recentLatencies.length > MAX_RECENT_LATENCIES) s.recentLatencies.shift();
  } else {
    s.failures += 1;
  }
  s.recentOutcomes.push(ok);
  if (s.recentOutcomes.length > MAX_RECENT_OUTCOMES) s.recentOutcomes.shift();

  // A malformed (non-JSON) response, or a rate limit (cooldownOverrideMs set)
  // is essentially never a transient blip that a same-model retry would fix —
  // force this evaluation's effective health to 0 so it excludes immediately
  // through the same cooldown/doubling logic above, instead of needing
  // enough failures to accumulate first.
  const forceExclude = !ok && (hardFailure || cooldownOverrideMs !== undefined);
  if (ok) {
    // An older in-flight success cannot cancel a newer Retry-After window.
    if ((store.exclusions.get(key)?.retryAfterUntil ?? 0) <= Date.now()) store.exclusions.delete(key);
    return;
  }
  const effectiveHealth = forceExclude ? 0 : healthFactor(store, key);
  evaluateHealth(store, key, effectiveHealth, cooldownOverrideMs);
}

// ─── runtime-learned free access ─────────────────────────────────────────
// There's no reliable *static* way to know in advance which model ids work
// with no API key — naming conventions like "-free" are incomplete (e.g.
// OpenCode Zen's "big-pickle" has no such suffix but answers with zero auth
// anyway). A successful call made with no key is direct proof, so remember
// it for the rest of the session: every later "auto" pick prefers it, no
// per-provider special-casing needed. Session-lifetime only, same as every
// other store here.
const learnedFreeAccess = new Set<string>();

export function isKnownFreeAccess(key: string): boolean {
  return learnedFreeAccess.has(key);
}

// Mirror-image of the above: a mixed free/paid catalog (OpenCode Free, Kilo
// Gateway) can also PROVE a model needs a key we don't have — a clean 401/403
// on a connection with no configured key. That's stronger than ordinary
// health decay (which needs several recent failures before excluding), so
// remember it immediately and don't offer that model again this session
// while still unkeyed.
const learnedKeyRequired = new Set<string>();

export function isKnownKeyRequired(key: string): boolean {
  return learnedKeyRequired.has(key);
}

// A configured key can be valid yet still not cover every model — a mixed
// free/paid catalog under one keyed endpoint (Api.Airforce is the case that
// surfaced this: a free-tier key 402/403s on models needing an active
// subscription or PAYG balance). `keyRequired` above only fires when the
// connection has NO key at all, so this is a separate, always-checked signal:
// once a real request proves a specific model needs payment this account
// doesn't have, remember it for the rest of the session regardless of
// whether a key is configured, same immediacy as `learnedKeyRequired`.
const learnedPaymentRequired = new Set<string>();

export function isKnownPaymentRequired(key: string): boolean {
  return learnedPaymentRequired.has(key);
}

/**
 * Direct mode is keyless-catalog-focused: a connection with no
 * API key configured should only offer/route to models actually known to
 * work with no key, not just whatever hasn't failed yet — see the OpenCode
 * "Missing API key" / "Qwen3Guard" sagas earlier this session. But a
 * brand-new keyless connection (a fresh custom endpoint, or a preset with no
 * static free-tagging at all) starts with zero signal either way, and the
 * only way to ever learn a model is free is to actually try it — so when a
 * connection has no confirmed-free model yet, fall back to its full (still
 * proven-key-required-excluded) catalog so it can bootstrap. Once at least
 * one of its models is confirmed free (statically tagged or a real
 * anonymous success), only those are offered from then on.
 */
export function selectUsableModels<T extends { id: string; freeAccess?: boolean }>(
  connectionAlias: string,
  hasKey: boolean,
  models: T[]
): T[] {
  // Payment-gated models are excluded first and unconditionally: unlike the
  // freeAccess/keyRequired bootstrap below (which fails open when there's no
  // signal yet), this only fires once a real request has already proven the
  // model needs money this connection's key doesn't have — that holds
  // whether or not a key is configured, so there's nothing to fail open to.
  const usable = models.filter((m) => !isKnownPaymentRequired(`${connectionAlias}/${m.id}`));
  if (hasKey) return usable;
  const eligible = usable.filter((m) => !isKnownKeyRequired(`${connectionAlias}/${m.id}`));
  const knownFree = eligible.filter((m) => m.freeAccess || isKnownFreeAccess(`${connectionAlias}/${m.id}`));
  return knownFree.length > 0 ? knownFree : eligible;
}

/** Used only when a 429 didn't come with its own `Retry-After` — a
 *  conservative guess, never the primary mechanism (see `recordOutcome`). */
export const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 60 * 1000;

/**
 * Call after every completed request so future routing decisions reflect
 * reality. `hardFailure` (a non-JSON/malformed upstream response — see
 * GatewayError.malformed) excludes immediately rather than waiting for
 * several recent failures to accumulate. `noKeyUsed` marks a successful
 * call as proof this model works with no API key at all. `keyRequired`
 * marks a failed call as proof this model needs a key we don't have.
 * `rateLimited` (a 429) also excludes immediately, but for a duration taken
 * from `retryAfterMs` (the provider's own `Retry-After` header) when given —
 * rate-limit windows are entirely provider-specific, so this app never
 * hardcodes one; `RATE_LIMIT_FALLBACK_COOLDOWN_MS` only covers a provider
 * that returns a 429 without saying how long to wait. `paymentRequired`
 * marks a failed call as proof this model needs a subscription/balance this
 * connection's key doesn't have - independent of `keyRequired`, which only
 * covers a missing key entirely.
 */
export function recordOutcome(
  key: string,
  ok: boolean,
  latencyMs: number,
  opts: {
    hardFailure?: boolean;
    noKeyUsed?: boolean;
    keyRequired?: boolean;
    paymentRequired?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
    connectionFailure?: boolean;
  } = {}
): void {
  const cooldownOverrideMs = opts.rateLimited ? opts.retryAfterMs ?? RATE_LIMIT_FALLBACK_COOLDOWN_MS : undefined;
  recordStoreOutcome(modelStore, key, ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
  // A model-specific failure must not quarantine a whole mixed catalog.
  if (ok || opts.connectionFailure) {
    recordStoreOutcome(connectionStore, connectionKeyOf(key), ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
  }
  if (opts.noKeyUsed && ok) learnedFreeAccess.add(key);
  if (ok) {
    learnedKeyRequired.delete(key);
    learnedPaymentRequired.delete(key);
  }
  if (opts.keyRequired && !ok) learnedKeyRequired.add(key);
  if (opts.paymentRequired && !ok) learnedPaymentRequired.add(key);
}

// ─── condensed multi-factor scoring (ported from scoring.ts) ────────────
// OmniRoute's own DEFAULT_WEIGHTS, renormalized over only the factors this
// app can actually compute (quota/tierPriority/cacheAffinity/session
// availability/resetWindowAffinity/connectionDensity/quality all need
// server-side account infra this stateless app doesn't have).

const WEIGHTS = {
  health: 0.28,
  costInv: 0.08,
  latencyInv: 0.18,
  taskFit: 0.22,
  stability: 0.06,
  tierAffinity: 0.08,
  contextAffinity: 0.05,
  connectionDiversity: 0.05,
};

export interface RoutingCandidate {
  key: string;
  modelId: string;
  /** For the small-model floor below — optional since not every caller has it. */
  contextLength?: number;
  maxOutputTokens?: number;
  freeAccess?: boolean;
  supportsVision?: boolean;
  toolCalling?: boolean;
}

interface PoolMaxima {
  maxCost: number;
  maxStdDev: number;
}

/** Computed once per pool, not per-candidate — with thousands of models, an
 *  O(n^2) rescan per candidate is the same perf trap already hit and fixed
 *  once in this app's model-picker/settings virtualization work. */
function computePoolMaxima(candidates: RoutingCandidate[]): PoolMaxima {
  let maxCost = 0.001;
  let maxStdDev = 0.001;
  for (const c of candidates) {
    const cost = estimateCost(c.modelId);
    if (cost > maxCost) maxCost = cost;
    const s = getStats(modelStore, c.key);
    const sd = stddev(s.recentLatencies);
    if (sd > maxStdDev) maxStdDev = sd;
  }
  return { maxCost, maxStdDev };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function scoreCandidate(
  c: RoutingCandidate,
  profile: RequestProfile,
  maxima: PoolMaxima,
  previousKey: string | undefined,
  excludedConnections: Set<string> | undefined
): number {
  const s = getStats(modelStore, c.key);
  const avgLatencyMs = recentLatency(modelStore, c.key);

  const health = clamp01(blendedHealth(c.key));
  const costInv = c.freeAccess ? 1 : clamp01(1 - estimateCost(c.modelId) / maxima.maxCost);
  const latencyInv = 2000 / (2000 + avgLatencyMs);
  const taskFit = clamp01(getTaskFitness(c.modelId, profile.taskType));
  const stability = clamp01(1 - stddev(s.recentLatencies) / maxima.maxStdDev);
  const affinity = clamp01(tierAffinity(c.modelId, profile.recommendedMinTier));
  const context = c.key === previousKey ? 1.0 : 0.5;
  // Nudge (not force) "auto" toward a provider it hasn't already tried this
  // turn — spreads load across every configured free connection instead of
  // repeatedly retrying different models on the one that just failed.
  const connectionDiversity = excludedConnections?.has(connectionKeyOf(c.key)) ? 0.5 : 1.0;

  return clamp01(
    WEIGHTS.health * health +
      WEIGHTS.costInv * costInv +
      WEIGHTS.latencyInv * latencyInv +
      WEIGHTS.taskFit * taskFit +
      WEIGHTS.stability * stability +
      WEIGHTS.tierAffinity * affinity +
      WEIGHTS.contextAffinity * context +
      WEIGHTS.connectionDiversity * connectionDiversity
  );
}

export interface ScoreAndPickOptions {
  maxOutputTokens?: number;
  /** Keys already tried this turn (hard-excluded, immediate failover). */
  excluded?: Set<string>;
  /** The model key used earlier in this conversation, for the stickiness bonus. */
  previousKey?: string;
  /** Connection aliases already tried (and failed) this turn — nudges the
   *  next pick toward a different provider instead of another model on one
   *  that just failed. Not a hard filter (all its models could still be
   *  hard-excluded elsewhere); see connectionDiversity in scoreCandidate. */
  excludedConnections?: Set<string>;
  /**
   * Skip classification and treat this turn as needing a capable model
   * regardless of how simple the prompt text looks - for a caller that knows
   * it wants the strongest available model (e.g. a swarm's synthesis step),
   * not one whose need is inferable from the request alone.
   */
  forceCapable?: boolean;
}

/**
 * Score every candidate against the classified request and return the best
 * one. Known capability/context incompatibilities and active cooldowns are
 * hard exclusions. Missing metadata remains eligible with lower confidence.
 */
export function scoreAndPick(
  candidates: RoutingCandidate[],
  profile: RequestProfile,
  options: ScoreAndPickOptions = {}
): RoutingCandidate | null {
  const excluded = options.excluded ?? new Set<string>();
  const outputBudget = options.maxOutputTokens ?? 1024;
  const requiredContext = Math.ceil((profile.inputTokens ?? 0) * 1.15) + outputBudget;
  const retryFiltered = candidates.filter((c) => !excluded.has(c.key) &&
    (!c.contextLength || c.contextLength >= requiredContext) &&
    (!options.maxOutputTokens || !c.maxOutputTokens || c.maxOutputTokens >= options.maxOutputTokens) &&
    (!profile.needsVision || c.supportsVision !== false) &&
    (!profile.needsTools || c.toolCalling !== false));
  const healthy = retryFiltered.filter(
    (c) => !isCoolingDown(modelStore, c.key) && !isCoolingDown(connectionStore, connectionKeyOf(c.key))
  );
  // Retry-After is a constraint, not a score that can be ignored when all
  // models are unavailable. Never hammer a cooling provider.
  const pool = healthy;
  if (pool.length === 0) return null;

  // classifyRequest already scores task difficulty, but until now that only
  // fed a soft 0.07-weighted tierAffinity nudge in scoreCandidate - a tiny
  // free local model could still out-score a genuinely capable one on an
  // expert-level coding/document turn purely on health/cost/latency. Hard-
  // exclude small models (same "too small" line promptScale.ts draws for the
  // artifact contract) once the task actually needs more, with the same
  // fails-open shape as the exclusion filtering above: never leave the pool
  // empty just because everything configured happens to be small.
  // (recommendedMinTier === "premium" and level === "expert" are the same
  // condition today per getRecommendedMinTier - kept as an OR so a future
  // change to either bucketing function doesn't silently stop this working.)
  const needsCapableModel = options.forceCapable || profile.recommendedMinTier === "premium" || profile.level === "expert";
  const capable = needsCapableModel ? pool.filter((c) => !isSmallModel(c.modelId, c.contextLength)) : pool;
  const finalPool = capable.length > 0 ? capable : pool;

  const maxima = computePoolMaxima(finalPool);
  let best: { candidate: RoutingCandidate; score: number } | null = null;
  for (const candidate of finalPool) {
    const confidence = (profile.needsVision && candidate.supportsVision !== true ? 0.12 : 0) +
      (profile.needsTools && candidate.toolCalling !== true ? 0.05 : 0) +
      ((profile.inputTokens ?? 0) > 8000 && !candidate.contextLength ? 0.08 : 0);
    const loadPenalty = Math.min(0.3, (modelLoad.get(candidate.key) ?? 0) * 0.08 +
      (connectionLoad.get(connectionKeyOf(candidate.key)) ?? 0) * 0.04);
    const score = scoreCandidate(candidate, profile, maxima, options.previousKey, options.excludedConnections) - confidence - loadPenalty;
    if (!best || score > best.score) best = { candidate, score };
  }
  return best!.candidate;
}
