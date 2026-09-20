/**
 * The app's single entry point for talking to LLM/media/search providers.
 * Two connection modes, picked in Settings → Providers (see `ConnectionMode`
 * below):
 *  - "direct": browser-native — every provider connection is held
 *    client-side (`ProviderConnection` in ./types), requests are translated
 *    via the matching format adapter (./gateway/adapters) and auto-routed
 *    by ./gateway/autoRoute.ts.
 *  - "gateway": talks to a real, externally-running server implementing the
 *    OmniRoute protocol (./gateway/selfHostedGateway.ts), the way InBrowser
 *    worked before Direct mode existed — single baseUrl/apiKey, server-side
 *    auto-routing.
 * Both modes call providers directly from the browser
 * (./gateway/providerFetch.ts). The default path ships no server of its own, so
 * a provider must send CORS headers to be usable - and, more importantly, every
 * request leaves the user's own IP, keeping the free providers' per-IP rate
 * limits per-user instead of shared across everyone. The exception is a user's
 * own proxy, which cannot be dialled from a page and goes through the relay;
 * see the header of ./gateway/providerFetch.ts.
 *
 * Kept as `onniroute.ts` (rather than renaming) so every existing import
 * across the app (App.tsx, SettingsModal.tsx, attachments.ts,
 * tokenOptimization.ts) needed no path changes — only this file's internals
 * changed.
 */
import type {
  ChatMessage,
  CustomProxy,
  GeneratedMedia,
  MessageSearch,
  OmniModel,
  ProviderConnection,
  ResponseProxy,
  SearchResult,
} from "./types";
import { DOC_TEXT_BUDGET_CHARS, selectRelevantExcerpt } from "./tokenOptimization";
import type {
  AdapterChatArgs,
  ChatAdapter,
  ChatMessageInput,
  ResolvedTarget,
  ToolCallWire,
  ToolDef,
} from "./gateway/types";
import { GatewayError } from "./gateway/types";
import { openaiAdapter } from "./gateway/adapters/openai";
import { anthropicAdapter } from "./gateway/adapters/anthropic";
import { geminiAdapter } from "./gateway/adapters/gemini";
import { localAdapter } from "./gateway/adapters/local";
import { excludeKeyFor, recordOutcome, resolve, resolveDirect } from "./gateway/autoRoute";
import { selectUsableModels, beginModelAttempt } from "./gateway/routingEngine";
import { recordProxyOutcome, beginProxyAttempt } from "./gateway/proxyRouting";
import { activeProxyOrUndefined, pickProxyForSettings } from "./gateway/activeProxy";
import { providerFetch } from "./gateway/providerFetch";
import { responseProxy } from "./gateway/responseProxy";
import { looksLikePaymentRequired } from "./gateway/util";
import * as openaiMedia from "./gateway/media/openai";
import * as geminiMedia from "./gateway/media/gemini";
import { search as duckduckgoSearch } from "./gateway/search/duckduckgo";
import { search as serperSearch } from "./gateway/search/serper";
import { search as jinaSearch } from "./gateway/search/jina";
import * as gateway from "./gateway/selfHostedGateway";
import { routingFailure } from "./gateway/routingFailure";
import { createProtocolOutputGuard, cleanProtocolOutput } from "./gateway/protocolOutput";
import { validateToolCalls } from "./gateway/toolValidation";
import { responsePolicyFor } from "./responsePolicy";
import { PROVIDER_PRESETS, providerPresetForUrl } from "./gateway/providerPresets";
import {
  buildCapabilityIndexFromManifest,
  buildCapabilityIndexFromProviders,
  classifyModelCapabilities,
  isChatCapableModelId,
  type CapabilityIndex,
} from "./capabilities";

export type { ChatContentPart, ChatMessageInput, ToolCallWire, ToolDef } from "./gateway/types";
export { GatewayError } from "./gateway/types";
export type {
  ProviderConnection,
  ProviderFormat,
  SearchBackend,
  SearchSettings,
  CustomProxy,
  ProxyRoutingMode,
} from "./types";
export type { GatewayTestResult } from "./gateway/selfHostedGateway";

// ---------------------------------------------------------------- settings

/**
 * Settings live in ./gatewaySettings.ts and are re-exported here.
 *
 * They moved to break an import cycle: proxying now reaches media, search and
 * the page reader, and those modules need to ask which proxy is active, but
 * this file imports them. Re-exporting means every existing import of
 * `getSettings`/`GatewaySettings`/... from "./onniroute" kept working unchanged.
 */
import { getSettings } from "./gatewaySettings";
import { MAX_ROUTING_ATTEMPTS } from "./appConfig";

export {
  GATEWAY_URL_PLACEHOLDER,
  defaultSettings,
  dismissLegacyProxyNotice,
  getSettings,
  legacyProxyCount,
  legacyProxyExport,
  migrateProxies,
  saveSettings,
} from "./gatewaySettings";
export type {
  ConnectionMode,
  GatewayConnectionSettings,
  GatewaySettings,
} from "./gatewaySettings";

/** Model list derived purely from configured connections — no network call.
 *  A connection with no API key configured only contributes its known-free
 *  models (see selectUsableModels) — this is what keeps them from ever
 *  appearing as a selectable/routable option in the first place. */
export function modelsFromProviders(providers: ProviderConnection[]): OmniModel[] {
  const seen = new Set<string>();
  const out: OmniModel[] = [];
  for (const connection of providers) {
    if (!connection.enabled) continue;
    const hasKey = Boolean(connection.apiKey);
    const usable = connection.models.filter((m) => m.enabled !== false && isChatCapableModelId(m.id));
    for (const model of selectUsableModels(connection.alias, hasKey, usable)) {
      const id = `${connection.alias}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, object: "model", owned_by: connection.format });
    }
  }
  // "auto" only makes sense once there's at least one real model to route
  // between — otherwise it's a selectable option with nothing behind it.
  if (out.length > 0) out.unshift({ id: "auto", object: "model", owned_by: "auto" });
  return out.sort((a, b) => (a.id === "auto" ? -1 : b.id === "auto" ? 1 : a.id.localeCompare(b.id)));
}

/** Fallback model list derived from the gateway's manifest (reachable keyless),
 *  used when /v1/models requires a key the client hasn't set. */
function modelsFromManifest(manifest: Awaited<ReturnType<typeof gateway.fetchManifest>>): OmniModel[] {
  if (!manifest) return [];
  const seen = new Set<string>();
  const out: OmniModel[] = [];
  for (const provider of manifest.providers) {
    if (!provider.alias) continue;
    for (const model of provider.models) {
      const id = `${provider.alias}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, object: "model", owned_by: provider.id });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Mode-aware model list + capability index. Direct mode builds synchronously
 * from configured connections; gateway mode fetches the connected gateway's
 * manifest and model list over the network. Always async so callers have one
 * code path regardless of mode.
 */
export async function loadModelsAndCapabilities(): Promise<{ models: OmniModel[]; index: CapabilityIndex; ok: boolean }> {
  const settings = getSettings();
  if (settings.mode === "direct") {
    return {
      models: modelsFromProviders(settings.providers),
      index: buildCapabilityIndexFromProviders(settings.providers),
      ok: settings.providers.some((p) => p.enabled),
    };
  }
  const { baseUrl, apiKey } = settings.gateway;
  try {
    const manifest = await gateway.fetchManifest(baseUrl);
    let models: OmniModel[] = [];
    try {
      models = await gateway.listModels(baseUrl, apiKey);
    } catch {
      // /v1/models can 401 keyless; the manifest (reachable keyless) covers it.
    }
    if (models.length === 0) models = modelsFromManifest(manifest);
    return { models, index: buildCapabilityIndexFromManifest(manifest), ok: Boolean(manifest) || models.length > 0 };
  } catch {
    return { models: [], index: buildCapabilityIndexFromManifest(null), ok: false };
  }
}

/** Concatenated text of every system message, for the auto-router's context-size signal. */
function systemPromptOf(messages: ChatMessageInput[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

function adapterFor(format: ProviderConnection["format"]): ChatAdapter {
  switch (format) {
    case "anthropic":
      return anthropicAdapter;
    case "gemini":
      return geminiAdapter;
    case "local":
      return localAdapter;
    default:
      return openaiAdapter;
  }
}

/** Matches the "-free" suffix convention used by providers whose catalog
 *  mixes genuinely-anonymous models with key-required ones under one
 *  endpoint — e.g. OpenCode Zen's "mimo-v2.5-free" works with zero auth
 *  while "claude-opus-5" 401s "Missing API key." on the exact same
 *  endpoint. Incomplete on its own (OpenCode's "big-pickle" is free too but
 *  doesn't match) — see the `assumeFree` check below and the runtime-learned
 *  free-access tracking in gateway/routingEngine.ts for the rest. */
const FREE_ACCESS_ID_PATTERN = /(?:^|[-_:])free$/i;

/** True when this base URL matches a preset InBrowser has verified live works
 *  with no API key at all, for EVERY model in its catalog (not just some —
 *  see `keylessUniform` in gateway/providerPresets.ts). OpenCode Free and
 *  Kilo Gateway are `keyless` (the connection itself needs no key) but have
 *  mixed free/paid catalogs, so they deliberately don't match here — only
 *  their "-free"-suffixed/self-reported models default to freeAccess, not
 *  the whole connection. */
function isKnownKeylessBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return PROVIDER_PRESETS.some(
    (p) => p.keyless && p.keylessUniform && p.baseUrl.trim().replace(/\/+$/, "").toLowerCase() === normalized
  );
}

/** Starter model ids of the preset matching this base URL, if any — see
 *  `starterModels` in gateway/providerPresets.ts. These are curated to
 *  actually work, which matters for providers like Api.Airforce whose real
 *  catalog mixes free-tier models with ones needing a subscription/PAYG
 *  balance: `GET /models` gives no per-model signal either way, so after
 *  discovery replaces the catalog there's otherwise nothing distinguishing
 *  a free starter model from the hundreds of paid ones sharing its endpoint. */
function starterModelIdsForBaseUrl(baseUrl: string): Set<string> {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const preset = PROVIDER_PRESETS.find((p) => p.baseUrl.trim().replace(/\/+$/, "").toLowerCase() === normalized);
  return new Set(preset?.starterModels ?? []);
}

/**
 * Real auto-discovery (direct mode): fetches a connection's current model
 * catalog straight from the provider (not a bundled/preset list — see
 * gateway/providerPresets.ts for that). Backfills vision/video/reasoning
 * flags via the same regex classifier used elsewhere for models the source
 * API doesn't report capability metadata for, and `freeAccess` for models
 * known or reasonably assumed to work with no API key.
 */
export async function discoverModels(connection: ProviderConnection): Promise<ProviderConnection["models"]> {
  // Not filtered to chat-capable ids here: connection.models is the complete
  // raw catalog (also shown as-is in Settings' ModelMultiSelect), and other
  // features scan it for specific non-chat models — audioModelFor() below
  // needs whisper entries to still be present. Chat-selection surfaces
  // (modelsFromProviders, autoRoute.ts's pickAuto) filter separately.
  const models = await adapterFor(connection.format).listModels(connection, activeProxyOrUndefined());
  // A connection matching a verified-keyless preset with no key configured
  // is assumed free for every model by default — that's the common case
  // (e.g. OVHcloud, where the *entire* catalog is optionally-authed, not
  // just suffix-tagged models). A model that turns out to actually need a
  // key just fails once per turn like any other bad candidate; the existing
  // self-healing exclusion suppresses it after a few real failures.
  const assumeFree = !connection.apiKey && isKnownKeylessBaseUrl(connection.baseUrl);
  const starterIds = starterModelIdsForBaseUrl(connection.baseUrl);
  const mapped = models.map((m) => {
    const freeAccess = m.freeAccess ?? (assumeFree || FREE_ACCESS_ID_PATTERN.test(m.id));
    if (m.supportsVision !== undefined || m.supportsVideo !== undefined || m.supportsReasoning !== undefined) {
      return { ...m, freeAccess };
    }
    const guessed = classifyModelCapabilities(m.id);
    return {
      ...m,
      supportsVision: guessed.vision,
      supportsVideo: guessed.video,
      supportsReasoning: guessed.reasoning,
      freeAccess,
    };
  });
  if (starterIds.size === 0) return mapped;
  // Stable sort: curated starter models first, so a discovered catalog that
  // mixes free and paid/subscription-gated models under one endpoint still
  // puts a known-good model at index 0 — testConnection() and the adapters'
  // own test calls default to `connection.models[0]` for exactly that reason.
  return [...mapped].sort((a, b) => Number(starterIds.has(b.id)) - Number(starterIds.has(a.id)));
}

// ------------------------------------------------------------------- chat

export interface ChatStreamOptions {
  /** Enables artifact output where the resolved model capacity supports it. */
  allowArtifacts?: boolean;
  model: string;
  messages: ChatMessageInput[];
  signal?: AbortSignal;
  /** Function/tool definitions the model may call (enables the tool loop). */
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required" | string;
  /** Optional safety cap on completion length (token optimization). */
  maxTokens?: number;
  /** Fully-qualified "alias/modelId" used earlier in this conversation, for the auto-router's stickiness bonus. */
  previousModel?: string;
  /**
   * Skip classification and route "auto" to the strongest available model
   * regardless of how simple this turn's prompt looks - for a caller that
   * already knows it wants the best model (a swarm's synthesis step), not
   * one whose need is inferable from the request. No-op in gateway mode:
   * that mode delegates routing entirely to an external gateway this app
   * has no control over.
   */
  forceCapableModel?: boolean;
  /** Emitted when an attempt actually starts producing a response, not on failed retries. */
  onProxyUsed?: (proxy: ResponseProxy | null) => void;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: ToolCallWire[]) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface ChatStreamResult {
  /** Fully-qualified "alias/modelId" actually used (already known client-side, not parsed from a header). */
  resolvedModel: string | null;
  resolvedProvider: string | null;
  resolvedProxy?: ResponseProxy | null;
  toolCalls: ToolCallWire[];
}

// Each failed attempt now deprioritizes a whole connection's worth of
// candidates (routingEngine.ts's connection-level circuit breaking) and
// nudges the next pick toward a connection not yet tried this turn
// (excludedConnections/connectionDiversity) — with several free presets
// typically configured at once, this gives "auto" a real shot at reaching
// every one of them before giving up, not just one or two. Also shared with
// proxy retries now (see pickProxy in gateway/proxyRouting.ts): a failed
// attempt may retry the same connection/model through a proxy before this
// budget moves on to a different candidate, so it's bumped slightly (was 8)
// to give both mechanisms room without starving connection diversity.
/** From config.json, `client.maxRoutingAttempts`. */
const MAX_AUTO_ATTEMPTS = MAX_ROUTING_ATTEMPTS;

/** One attempted (connection, model) pair that failed, with everything known
 *  about why — used to build a debuggable error instead of a bare message
 *  that doesn't say which model was even involved. */
interface AttemptFailure {
  connection: ProviderConnection;
  modelId: string;
  message: string;
  status?: number;
  code?: string;
}

/** "[OpenCode Free] oc/ling-3.0-flash-fin-free — HTTP 503: Endpoint is unavailable." —
 *  connection label, the exact routable model id, and the status code when
 *  known, so a failure is fully identifiable instead of a bare message with
 *  no indication of which of several configured providers/models it came from. */
function describeFailure(f: AttemptFailure): string {
  const label = f.connection.label || f.connection.alias;
  const modelRef = `${f.connection.alias}/${f.modelId}`;
  const statusPart = f.status ? `HTTP ${f.status}: ` : "";
  return `[${label}] ${modelRef} — ${statusPart}${f.message}`;
}

/** "auto" mode can silently try up to MAX_AUTO_ATTEMPTS different candidates
 *  in one turn — surfacing only the last one's failure hides why every other
 *  candidate was also skipped. When more than one was actually tried, list
 *  every attempt so the real cause (a specific model needing a key, another
 *  being rate-limited, a third genuinely down, ...) is visible instead of
 *  losing all but the final line. */
function summarizeFailures(attempts: AttemptFailure[], fallback: string): string {
  if (attempts.length === 0) return fallback;
  if (attempts.length === 1) return describeFailure(attempts[0]);
  const lines = attempts.map((f, i) => `${i + 1}. ${describeFailure(f)}`);
  return `All ${attempts.length} attempted models failed:\n${lines.join("\n")}`;
}

/** Shared by chatStream, runCompletion and testProviderConnection so the two
 *  learned-exclusion signals are classified identically everywhere a request
 *  can fail. `keyRequired` keeps its original meaning (the connection has no
 *  key at all) so the freeAccess bootstrap in selectUsableModels is
 *  unaffected. `paymentRequired` is new and independent of whether a key is
 *  configured - it is what actually distinguishes "your key is missing/bad"
 *  from "your key is valid but this model needs a subscription/balance you
 *  don't have" (e.g. Api.Airforce's mixed free/paid catalog under one keyed
 *  endpoint - see providerPresets.ts's "airforce" entry). */
function classifyChatFailure(
  connection: ProviderConnection,
  status: number | undefined,
  message: string
): { keyRequired: boolean; paymentRequired: boolean } {
  const paymentRequired = status === 402 || looksLikePaymentRequired(message);
  const keyRequired = !connection.apiKey && (status === 401 || status === 403 && /api.?key|authentication|credentials/i.test(message) || paymentRequired);
  return { keyRequired, paymentRequired };
}

/** Stream a chat completion. Resolves "auto" via the auto-router and fails over across candidates. */
export async function chatStream(options: ChatStreamOptions): Promise<ChatStreamResult> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    // forceCapableModel is a no-op here: routing is entirely the external
    // gateway's decision in this mode, not something resolve()/scoreAndPick()
    // below ever gets a say in.
    const { baseUrl, apiKey } = settings.gateway;
    // Gateway mode sends directly to the gateway. Its own upstream
    // proxy configuration is not visible to this client.
    const resolvedProxy = null;
    const policy = responsePolicyFor(options.model, options.messages, options.allowArtifacts);
    const output = createProtocolOutputGuard(options.onDelta, policy.allowArtifacts);
    let reportedProxy = false;
    const reportProxy = () => {
      if (!reportedProxy) {
        reportedProxy = true;
        options.onProxyUsed?.(resolvedProxy);
      }
    };
    const result = await gateway.chatStream({
      baseUrl,
      apiKey,
      model: options.model,
      messages: policy.messages,
      tools: options.tools,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      signal: options.signal,
      onDelta: text => { reportProxy(); output.push(text); },
      onReasoning: text => { reportProxy(); options.onReasoning?.(text); },
      onToolCalls: calls => { validateToolCalls(calls, options.tools, options.toolChoice); reportProxy(); options.onToolCalls?.(calls); },
      onError: options.onError,
      onDone: options.onDone,
    });
    output.flush();
    validateToolCalls(result.toolCalls, options.tools, options.toolChoice);
    reportProxy();
    return { ...result, resolvedProxy };
  }
  const isAuto = options.model === "auto" || options.model.startsWith("auto/");
  const excluded = new Set<string>();
  const excludedConnections = new Set<string>();
  // Each model gets a fresh set of route attempts; health is tracked separately.
  const excludedProxies = new Set<string>();
  // Once the pool is exhausted, fall back to a direct attempt rather than
  // failing outright. A user whose proxies have all gone dead being unable to
  // chat at all would be strictly worse than before this feature existed.
  let triedDirect = false;
  const maxAttempts = MAX_AUTO_ATTEMPTS;
  // Every candidate actually tried and failed, in order — surfaced together
  // if every one (or the lack of any) ultimately fails, so the real cause is
  // visible per-model instead of only the last attempt's message surviving.
  const attempts: AttemptFailure[] = [];
  const noProviderFallback =
    settings.providers.length === 0
      ? "No providers configured. Add one in Settings → Providers."
      : "No compatible model route is ready. Check model capabilities, context limits, and proxy availability, or retry after the current cooldown.";

  let target: ResolvedTarget | null = null;
  let activeProxy: CustomProxy | null = null;
  let protocolRepairAttempted = false;
  // A relay/proxy-transport failure (e.g. the tunnel closing mid-request) is
  // inherently transient — the identical target often succeeds on a bare
  // retry, since nothing about the request itself was wrong. Bounded to one
  // extra attempt per (connection, model, proxy) so it can't by itself
  // consume the budget connection-diversity/proxy-rotation rely on.
  const sameTargetRetries = new Map<string, number>();
  // Tracks a run of consecutive attempts that all failed with the same
  // relay/proxy-level failure code, possibly across different providers —
  // that pattern means the shared relay/proxy hop itself is unhealthy, not
  // any individual model, and rotating through the rest of the attempt
  // budget cannot fix it.
  let consecutiveRelayFailureCode: string | null = null;
  let consecutiveRelayFailureCount = 0;
  const RELAY_SHORT_CIRCUIT_THRESHOLD = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!target) {
      excludedProxies.clear();
      triedDirect = false;
      target = resolve(
        options.model,
        settings.providers.filter(c => !providerPresetForUrl(c.baseUrl)?.requiresProxy ||
          pickProxyForSettings(settings, new Set(), c.baseUrl)),
        excluded,
        options.messages,
        options.tools,
        systemPromptOf(options.messages),
        options.previousModel,
        excludedConnections,
        options.forceCapableModel,
        options.maxTokens
      );
      // Seeded rather than cleared: a configured proxy is a deliberate choice,
      // so it applies from the first attempt. An empty pool yields null, which
      // is exactly the old behaviour.
      activeProxy = pickProxyForSettings(settings, excludedProxies, target?.connection.baseUrl);
      if (target?.connection.format === "local") activeProxy = null;
      if (activeProxy) excludedProxies.add(activeProxy.id);
      if (!target) {
        options.onError?.(summarizeFailures(attempts, noProviderFallback));
        return { resolvedModel: null, resolvedProvider: null, toolCalls: [] };
      }
    }
    // Captured non-null once per iteration — `target` itself gets reassigned
    // (to trigger a fresh resolve() next iteration) inside this same try
    // block below, which stops TS narrowing it as non-null inside catch.
    const currentTarget: ResolvedTarget = target;
    // Local runtimes never send a network request, even with a proxy pool enabled.
    if (currentTarget.connection.format === "local") activeProxy = null;
    const resolvedProxy = responseProxy(activeProxy);
    let reportedProxy = false;
    const reportProxy = () => {
      if (!reportedProxy) {
        reportedProxy = true;
        options.onProxyUsed?.(resolvedProxy);
      }
    };
    const key = excludeKeyFor(currentTarget);
    const adapter = adapterFor(currentTarget.connection.format);
    let streamedAny = false;
    let streamError: string | null = null;
    let firstResponseMs: number | undefined;
    const started = performance.now();
    const policy = responsePolicyFor(currentTarget.modelId, options.messages, options.allowArtifacts,
      currentTarget.connection.models.find(m => m.id === currentTarget.modelId)?.contextLength);
    let visibleContent = false;
    const output = createProtocolOutputGuard(t => {
      visibleContent ||= Boolean(t.trim());
      firstResponseMs ??= Math.round(performance.now() - started);
      reportProxy(); streamedAny = true; options.onDelta(t);
    }, policy.allowArtifacts);
    const chatArgs: AdapterChatArgs = {
      connection: currentTarget.connection,
      modelId: currentTarget.modelId,
      messages: policy.messages,
      tools: options.tools,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      signal: options.signal,
      proxy: activeProxy ?? undefined,
      onDelta: t => output.push(t),
      onReasoning: (t) => {
        firstResponseMs ??= Math.round(performance.now() - started);
        reportProxy();
        streamedAny = true;
        options.onReasoning?.(t);
      },
      onToolCalls: (calls) => {
        validateToolCalls(calls, options.tools, options.toolChoice);
        firstResponseMs ??= Math.round(performance.now() - started);
        reportProxy();
        streamedAny = true;
        options.onToolCalls?.(calls);
      },
      onError: (msg) => {
        streamError = msg;
      },
      onDone: options.onDone,
    };
    const releaseModel = beginModelAttempt(key);
    const releaseProxy = beginProxyAttempt(activeProxy?.id);
    try {
      const { toolCalls } = await adapter.streamChat(chatArgs);
      output.flush();
      validateToolCalls(toolCalls, options.tools, options.toolChoice);
      if (!visibleContent && !toolCalls.length) {
        throw new GatewayError(502, "The model returned malformed tool or artifact markup instead of an answer.", false, undefined, "invalid_model_output");
      }
      const latencyMs = Math.round(performance.now() - started);
      if (streamError) throw new GatewayError(502, streamError, false, undefined, "stream_error");
      recordOutcome(currentTarget.connection.alias, currentTarget.modelId, !output.violations, firstResponseMs ?? latencyMs, {
        noKeyUsed: !currentTarget.connection.apiKey,
      });
      if (activeProxy) recordProxyOutcome(activeProxy.id, true, firstResponseMs ?? latencyMs, { targetUrl: currentTarget.connection.baseUrl });
      reportProxy();
      return {
        resolvedModel: `${currentTarget.connection.alias}/${currentTarget.modelId}`,
        resolvedProvider: currentTarget.connection.label || currentTarget.connection.alias,
        resolvedProxy,
        toolCalls,
      };
    } catch (err) {
      if (options.signal?.aborted || err instanceof Error && err.name === "AbortError") throw err;
      const failure = routingFailure(err, Boolean(activeProxy));
      const hardFailure = err instanceof GatewayError && (err.malformed || err.status === 401 || err.status === 404 || err.code === "invalid_tool_call" || err.code === "invalid_model_output");
      const status = err instanceof GatewayError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const retryAfterMs = err instanceof GatewayError ? err.retryAfterMs : undefined;
      const { keyRequired, paymentRequired } = classifyChatFailure(currentTarget.connection, status, message);
      const latencyMs = Math.round(performance.now() - started);
      if (failure.modelFailure || failure.connectionFailure) recordOutcome(currentTarget.connection.alias, currentTarget.modelId, false, latencyMs, {
        hardFailure,
        keyRequired,
        paymentRequired,
        rateLimited: status === 429 || status === 503 && retryAfterMs !== undefined,
        retryAfterMs,
        connectionFailure: failure.connectionFailure,
      });
      if (activeProxy && failure.proxyFailure) {
        recordProxyOutcome(activeProxy.id, false, latencyMs, { hardFailure: true,
          targetUrl: currentTarget.connection.baseUrl, targetOnly: failure.targetOnly });
      }
      const failureCode = err instanceof GatewayError ? err.code : undefined;
      attempts.push({ connection: currentTarget.connection, modelId: currentTarget.modelId, message, status, code: failureCode });

      // A relay/proxy failure code repeating across consecutive attempts —
      // possibly across entirely different providers — means the shared
      // relay/proxy hop itself is unhealthy, not any individual model.
      // Continuing to rotate models cannot fix that, and it only buries the
      // real cause under a wall of near-identical bullet points. Only counts
      // failures actually attributed to the proxy/relay layer, so a run of
      // ordinary per-model 4xx/429s never trips this.
      if (failure.proxyFailure && failureCode) {
        consecutiveRelayFailureCount =
          failureCode === consecutiveRelayFailureCode ? consecutiveRelayFailureCount + 1 : 1;
        consecutiveRelayFailureCode = failureCode;
      } else {
        consecutiveRelayFailureCount = 0;
        consecutiveRelayFailureCode = null;
      }
      if (consecutiveRelayFailureCount >= RELAY_SHORT_CIRCUIT_THRESHOLD) {
        // Several proxies (or retries of the same one) all failing with the
        // identical relay-level code means the shared relay hop itself is
        // the problem, not any specific downstream proxy — rotating to yet
        // another one can't help. A connection with real CORS support can
        // skip the relay entirely, which is the one thing actually likely to
        // succeed, so try that once before giving up outright.
        if (attempt < maxAttempts - 1 && !triedDirect && activeProxy &&
          !providerPresetForUrl(currentTarget.connection.baseUrl)?.requiresProxy) {
          triedDirect = true;
          activeProxy = null;
          continue;
        }
        options.onError?.(
          `Your configured proxy/relay failed ${consecutiveRelayFailureCount} times in a row across ` +
          `different providers (last error: "${message}") — check your proxy/relay settings in Settings → Proxies.\n\n` +
          summarizeFailures(attempts, "Request failed.")
        );
        return { resolvedModel: null, resolvedProvider: null, toolCalls: [] };
      }

      // One bounded correction can recover a formatting failure. Never replay
      // after visible output or execute any part of a rejected tool batch.
      if (!streamedAny && !protocolRepairAttempted && attempt < maxAttempts - 1 &&
        err instanceof GatewayError && (err.code === "invalid_tool_call" || err.code === "invalid_model_output")) {
        protocolRepairAttempted = true;
        options = { ...options, messages: [...options.messages, { role: "system",
          content: "Your previous response could not be used. Answer the latest user request directly. Use only the supplied tools through native function calls with valid JSON object arguments. If no tool is supplied, answer in plain text. Do not emit internal tool markup or invent extra tasks." }] };
        continue;
      }
      // A relay/proxy-transport-level failure is inherently transient (a
      // dropped tunnel, a momentary block) — retry the identical target once
      // before paying the cost of rotating to a worse-fit candidate. Never
      // retries a model-specific/hard failure, which a retry cannot fix.
      if (attempt < maxAttempts - 1 && !streamedAny && !failure.stop &&
        (failure.proxyFailure || failure.connectionFailure) && !hardFailure) {
        const retryKey = `${currentTarget.connection.id}:${currentTarget.modelId}:${activeProxy?.id ?? "direct"}`;
        const priorRetries = sameTargetRetries.get(retryKey) ?? 0;
        if (priorRetries < 1) {
          sameTargetRetries.set(retryKey, priorRetries + 1);
          continue; // target/activeProxy are unchanged — retries the identical attempt
        }
      }
      if (attempt < maxAttempts - 1 && !streamedAny && !failure.stop) {
        // Retry another proxy only when the failure belongs to the route.
        const nextProxy = failure.rotateProxy && (!isAuto || excludedProxies.size < 3)
          ? pickProxyForSettings(settings, excludedProxies, currentTarget.connection.baseUrl) : null;
        if (nextProxy) {
          excludedProxies.add(nextProxy.id);
          activeProxy = nextProxy;
          continue;
        }
        if (failure.rotateProxy && activeProxy && !triedDirect && !providerPresetForUrl(currentTarget.connection.baseUrl)?.requiresProxy) {
          triedDirect = true;
          activeProxy = null;
          continue;
        }
        if (isAuto) {
          excluded.add(key);
          excludedConnections.add(currentTarget.connection.alias);
          target = null;
          continue;
        }
      }
      options.onError?.(summarizeFailures(attempts, "Request failed."));
      return { resolvedModel: null, resolvedProvider: null, toolCalls: [] };
    } finally {
      releaseModel();
      releaseProxy();
    }
  }
  options.onError?.(summarizeFailures(attempts, "All configured providers failed for this request."));
  return { resolvedModel: null, resolvedProvider: null, toolCalls: [] };
}

export interface CompletionOptions {
  model?: string;
  messages: ChatMessageInput[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Non-streaming completion used for background work (auto-memory extraction, scheduled tasks). */
export async function runCompletion(options: CompletionOptions): Promise<string> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    const { baseUrl, apiKey } = settings.gateway;
    return gateway.runCompletion({
      baseUrl,
      apiKey,
      model: options.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
  }
  const model = options.model ?? "auto";
  const isAuto = model === "auto" || model.startsWith("auto/");
  const excluded = new Set<string>();
  const excludedConnections = new Set<string>();
  const excludedProxies = new Set<string>();
  // Once the pool is exhausted, fall back to a direct attempt rather than
  // failing outright. A user whose proxies have all gone dead being unable to
  // chat at all would be strictly worse than before this feature existed.
  let triedDirect = false;
  const maxAttempts = MAX_AUTO_ATTEMPTS;
  const attempts: AttemptFailure[] = [];
  const noProviderFallback =
    settings.providers.length === 0
      ? "No providers configured. Add one in Settings → Providers."
      : "No compatible model route is ready. Check model capabilities, context limits, and proxy availability, or retry after the current cooldown.";

  let target: ResolvedTarget | null = null;
  let activeProxy: CustomProxy | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!target) {
      excludedProxies.clear();
      triedDirect = false;
      target = resolve(
        model,
        settings.providers.filter(c => !providerPresetForUrl(c.baseUrl)?.requiresProxy ||
          pickProxyForSettings(settings, new Set(), c.baseUrl)),
        excluded,
        options.messages,
        undefined,
        systemPromptOf(options.messages),
        undefined,
        excludedConnections,
        false,
        options.maxTokens ?? 256
      );
      // Seeded rather than cleared: a configured proxy is a deliberate choice,
      // so it applies from the first attempt. An empty pool yields null, which
      // is exactly the old behaviour.
      activeProxy = pickProxyForSettings(settings, excludedProxies, target?.connection.baseUrl);
      if (target?.connection.format === "local") activeProxy = null;
      if (activeProxy) excludedProxies.add(activeProxy.id);
      if (!target) {
        throw new GatewayError(0, summarizeFailures(attempts, noProviderFallback));
      }
    }
    // See chatStream's identical comment: `target` is reassigned inside this
    // same try block, which stops TS narrowing it as non-null inside catch.
    const currentTarget: ResolvedTarget = target;
    const adapter = adapterFor(currentTarget.connection.format);
    const started = performance.now();
    const releaseModel = beginModelAttempt(excludeKeyFor(currentTarget));
    const releaseProxy = beginProxyAttempt(activeProxy?.id);
    try {
      const text = await adapter.completeChat({
        connection: currentTarget.connection,
        modelId: currentTarget.modelId,
        messages: options.messages,
        maxTokens: options.maxTokens ?? 256,
        signal: options.signal,
        proxy: activeProxy ?? undefined,
      });
      const latencyMs = Math.round(performance.now() - started);
      recordOutcome(currentTarget.connection.alias, currentTarget.modelId, true, latencyMs, {
        noKeyUsed: !currentTarget.connection.apiKey,
      });
      if (activeProxy) recordProxyOutcome(activeProxy.id, true, latencyMs, { targetUrl: currentTarget.connection.baseUrl });
      return text;
    } catch (err) {
      if (options.signal?.aborted || err instanceof Error && err.name === "AbortError") throw err;
      const failure = routingFailure(err, Boolean(activeProxy));
      const hardFailure = err instanceof GatewayError && (err.malformed || err.status === 401 || err.status === 404);
      const status = err instanceof GatewayError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const retryAfterMs = err instanceof GatewayError ? err.retryAfterMs : undefined;
      const { keyRequired, paymentRequired } = classifyChatFailure(currentTarget.connection, status, message);
      const latencyMs = Math.round(performance.now() - started);
      if (failure.modelFailure || failure.connectionFailure) recordOutcome(currentTarget.connection.alias, currentTarget.modelId, false, latencyMs, {
        hardFailure,
        keyRequired,
        paymentRequired,
        rateLimited: status === 429 || status === 503 && retryAfterMs !== undefined,
        retryAfterMs,
        connectionFailure: failure.connectionFailure,
      });
      if (activeProxy && failure.proxyFailure) {
        recordProxyOutcome(activeProxy.id, false, latencyMs, { hardFailure: true,
          targetUrl: currentTarget.connection.baseUrl, targetOnly: failure.targetOnly });
      }
      attempts.push({ connection: currentTarget.connection, modelId: currentTarget.modelId, message, status });
      if (attempt < maxAttempts - 1 && !failure.stop) {
        // Provider failures move to another model; route failures can change proxy.
        const nextProxy = failure.rotateProxy && (!isAuto || excludedProxies.size < 3)
          ? pickProxyForSettings(settings, excludedProxies, currentTarget.connection.baseUrl) : null;
        if (nextProxy) {
          excludedProxies.add(nextProxy.id);
          activeProxy = nextProxy;
          continue;
        }
        if (failure.rotateProxy && activeProxy && !triedDirect && !providerPresetForUrl(currentTarget.connection.baseUrl)?.requiresProxy) {
          triedDirect = true;
          activeProxy = null;
          continue;
        }
        if (isAuto) {
          excluded.add(excludeKeyFor(currentTarget));
          excludedConnections.add(currentTarget.connection.alias);
          target = null;
          continue;
        }
      }
      throw new GatewayError(status ?? 0, summarizeFailures(attempts, "Request failed."));
    } finally {
      releaseModel();
      releaseProxy();
    }
  }
  throw new GatewayError(0, summarizeFailures(attempts, "All configured providers failed"));
}

export interface TestResult {
  reply: string;
  latencyMs: number;
}

/**
 * Exercises a real chat completion against one connection (Settings → Providers
 * "Test" button, direct mode). Walks the connection's enabled models (already
 * curated-first by discoverModels' starter-model sort) and retries the next
 * one ONLY when a candidate fails because it specifically needs a
 * subscription/balance this key doesn't have - a mixed free/paid catalog
 * under one keyed endpoint (Api.Airforce is the case this was built for)
 * otherwise makes Test fail on whichever model happens to be tried first,
 * even though the key itself is fine. Any other failure (bad/missing key,
 * network error, rate limit) is identical for every model on the same
 * connection, so it's surfaced immediately rather than retried. Every
 * attempt's outcome is recorded the same way a real chat turn's is, so a
 * model Test proves is payment-gated is excluded from "auto" routing from
 * then on without needing to fail there too.
 */
export async function testProviderConnection(connection: ProviderConnection): Promise<TestResult> {
  const adapter = adapterFor(connection.format);
  const proxy = activeProxyOrUndefined();
  const candidateIds = connection.models
    .filter((m) => m.enabled !== false)
    .map((m) => m.id)
    .slice(0, 5);
  const modelIds: (string | undefined)[] = candidateIds.length > 0 ? candidateIds : [undefined];
  let lastErr: unknown;
  for (let i = 0; i < modelIds.length; i++) {
    const modelId = modelIds[i];
    const started = performance.now();
    try {
      const result = await adapter.testConnection(connection, proxy, modelId);
      if (modelId) {
        recordOutcome(connection.alias, modelId, true, result.latencyMs, { noKeyUsed: !connection.apiKey });
      }
      return result;
    } catch (err) {
      lastErr = err;
      const status = err instanceof GatewayError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const { keyRequired, paymentRequired } = classifyChatFailure(connection, status, message);
      if (modelId) {
        recordOutcome(connection.alias, modelId, false, Math.round(performance.now() - started), {
          hardFailure: err instanceof GatewayError && err.malformed,
          keyRequired,
          paymentRequired,
          rateLimited: status === 429,
        });
      }
      if (!paymentRequired || i === modelIds.length - 1) throw err;
    }
  }
  throw lastErr;
}

/** Connection test for gateway mode — mirrors the pre-rework testChatConnection, richer result shape. */
export async function testGatewayConnection(baseUrl: string, apiKey: string): Promise<gateway.GatewayTestResult> {
  return gateway.testConnection(baseUrl, apiKey);
}

export interface ProxyTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  /** Egress IP the target actually saw. Present on success. */
  exitIp?: string;
  /** Present on failure - the relay's own message where there is one. */
  error?: string;
  /** Present on failure when it came from the relay's structured JSON (see
   *  `GatewayError.code`), e.g. "provider_tls_unverified". */
  code?: string;
  /** Present when the relay sent a `Retry-After` - on its own rate limit, or
   *  when it is at capacity. Lets a caller wait exactly as long as it was
   *  told to rather than assuming a window. */
  retryAfterMs?: number;
}

/**
 * Reachability target for the Settings "Test" button.
 *
 * This endpoint returns a few lines of `key=value` text, one of which is the
 * client IP as the server saw it. Two things make it a better check than the
 * `https://example.com/` it replaced. It proves the *whole* path works -
 * relay, Worker, proxy handshake, TLS to a real host - rather than just that
 * something answered. And it tells the user their actual egress IP, which is
 * the entire reason for configuring a proxy in the first place.
 *
 * Note it no longer needs to send CORS headers, because the browser is not the
 * one reading it: the relay speaks raw HTTP to it and hands the body back. That
 * widened the choice of target considerably.
 */
const PROXY_REACHABILITY_TARGET = "https://cloudflare.com/cdn-cgi/trace";

/** Explicit connection diagnostic. Tests the chosen proxy even when normal proxy routing is off. */
export async function testProxyConnection(proxy: CustomProxy, relayUrl?: string, allowInsecureProxyTls?: boolean): Promise<ProxyTestResult> {
  const started = performance.now();
  try {
    const res = await providerFetch(
      PROXY_REACHABILITY_TARGET,
      { method: "GET", headers: { Accept: "text/plain" } },
      proxy,
      relayUrl,
      allowInsecureProxyTls,
      true
    );
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
    const body = await res.text();
    const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim();
    return { ok: true, status: res.status, latencyMs, exitIp: ip };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof GatewayError ? err.status : 0,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof GatewayError ? err.code : undefined,
      retryAfterMs: err instanceof GatewayError ? err.retryAfterMs : undefined,
    };
  }
}

// ---------------------------------------------------------------- web search

/** Run a web search through the configured backend (direct mode: Settings → Search; gateway mode: the connected gateway's own /v1/search). */
export async function webSearch(query: string, signal?: AbortSignal): Promise<MessageSearch> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    const { baseUrl, apiKey } = settings.gateway;
    return gateway.webSearch(baseUrl, apiKey, query, signal);
  }
  const backend = settings.search.provider;
  const apiKey = settings.search.apiKey;
  // duckduckgo reaches the network only through reader.ts, which picks up the
  // active proxy itself - passing one here would have nowhere to go.
  const proxy = activeProxyOrUndefined();
  const results: SearchResult[] =
    backend === "serper"
      ? await serperSearch(query, apiKey, signal, proxy)
      : backend === "jina"
        ? await jinaSearch(query, apiKey, signal, proxy)
        : await duckduckgoSearch(query, apiKey, signal);
  return { query, provider: backend, results };
}

// -------------------------------------------------------------- generation

const DEFAULT_MEDIA_MODELS: Partial<Record<ProviderConnection["format"], Partial<Record<"image" | "video", string>>>> = {
  openai: { image: "gpt-image-1" },
  gemini: { image: "imagen-3.0-generate-002", video: "veo-2.0-generate-001" },
};

function pickMediaConnection(
  providers: ProviderConnection[],
  model: string | undefined,
  kind: "image" | "video"
): { connection: ProviderConnection; modelId: string } {
  if (model && model !== "auto" && !model.startsWith("auto/")) {
    const target = resolveDirect(model, providers);
    if (target) return target;
  }
  const formats: ProviderConnection["format"][] = kind === "video" ? ["gemini"] : ["openai", "gemini"];
  for (const format of formats) {
    const connection = providers.find((c) => c.enabled && c.format === format);
    const modelId = DEFAULT_MEDIA_MODELS[format]?.[kind];
    if (connection && modelId) return { connection, modelId };
  }
  throw new GatewayError(
    0,
    `No provider configured for ${kind} generation. Add an OpenAI or Gemini connection in Settings → Providers.`
  );
}

function audioModelFor(connection: ProviderConnection): string {
  return connection.models.find((m) => /whisper/i.test(m.id))?.id ?? "whisper-1";
}

export interface GenerateImageOptions {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
}

export async function generateImages(options: GenerateImageOptions): Promise<GeneratedMedia[]> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    const urls = await gateway.generateImages(settings.gateway.baseUrl, settings.gateway.apiKey, options);
    return urls.map((url) => ({ kind: "image", url, prompt: options.prompt, model: options.model }));
  }
  const { connection, modelId } = pickMediaConnection(settings.providers, options.model, "image");
  const urls =
    connection.format === "gemini"
      ? await geminiMedia.generateImages(connection, modelId, {
          prompt: options.prompt,
          n: options.n,
          signal: options.signal,
          proxy: activeProxyOrUndefined(),
        })
      : await openaiMedia.generateImages(connection, modelId, {
          prompt: options.prompt,
          size: options.size,
          n: options.n,
          signal: options.signal,
          proxy: activeProxyOrUndefined(),
        });
  return urls.map((url) => ({ kind: "image", url, prompt: options.prompt, model: `${connection.alias}/${modelId}` }));
}

export async function editImages(options: {
  prompt: string;
  image: string | File;
  model?: string;
  signal?: AbortSignal;
}): Promise<GeneratedMedia[]> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    const urls = await gateway.editImages(settings.gateway.baseUrl, settings.gateway.apiKey, options);
    return urls.map((url) => ({ kind: "image", url, prompt: options.prompt, model: options.model }));
  }
  const { connection, modelId } = pickMediaConnection(settings.providers, options.model, "image");
  if (connection.format !== "openai") {
    throw new GatewayError(0, "Image editing currently requires an OpenAI-format provider connection.");
  }
  const urls = await openaiMedia.editImage(connection, modelId, { ...options, proxy: activeProxyOrUndefined() });
  return urls.map((url) => ({ kind: "image", url, prompt: options.prompt, model: `${connection.alias}/${modelId}` }));
}

export interface GenerateVideoOptions {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
}

export async function generateVideo(options: GenerateVideoOptions): Promise<GeneratedMedia[]> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    const urls = await gateway.generateVideo(settings.gateway.baseUrl, settings.gateway.apiKey, options);
    return urls.map((url) => ({ kind: "video", url, prompt: options.prompt, model: options.model }));
  }
  const { connection, modelId } = pickMediaConnection(settings.providers, options.model, "video");
  if (connection.format !== "gemini") {
    throw new GatewayError(0, "Video generation currently requires a Gemini provider connection.");
  }
  // Resolved once so the long-running poll loop reuses the same egress the
  // operation was created from.
  const urls = await geminiMedia.generateVideo(connection, modelId, {
    ...options,
    proxy: activeProxyOrUndefined(),
  });
  return urls.map((url) => ({ kind: "video", url, prompt: options.prompt, model: `${connection.alias}/${modelId}` }));
}

export async function transcribeAudioFile(file: Blob, name: string): Promise<string> {
  const settings = getSettings();
  if (settings.mode === "gateway") {
    return gateway.transcribeAudioFile(settings.gateway.baseUrl, settings.gateway.apiKey, file, name);
  }
  const connection = settings.providers.find((c) => c.enabled && c.format === "openai");
  if (!connection) {
    throw new GatewayError(
      0,
      "Audio transcription requires an OpenAI-compatible provider connection (OpenAI, Groq, ...)."
    );
  }
  return openaiMedia.transcribeAudio(connection, audioModelFor(connection), file, name, activeProxyOrUndefined());
}

// ------------------------------------------------------------ payload build

/** Trim large attached-document text to what's relevant to the accompanying
 *  message when token optimization is on; otherwise inline it unchanged. */
function docText(text: string, queryText: string, optimize: boolean): string {
  if (!optimize || text.length <= DOC_TEXT_BUDGET_CHARS) return text;
  return selectRelevantExcerpt(text, queryText, DOC_TEXT_BUDGET_CHARS);
}

/**
 * Convert an assistant/user/context chat message into a wire payload
 * message (adapters translate this into each provider's native shape). When
 * `optimize` is set, large attached-document text is trimmed to the parts
 * most relevant to the message's own text (token optimization).
 */
export function messageToPayload(msg: ChatMessage, optimize = false): ChatMessageInput {
  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      tool_call_id: msg.toolCallId,
    };
  }
  if (msg.role === "system") {
    return { role: "system", content: msg.content };
  }
  if (msg.role === "assistant") {
    const prose = cleanProtocolOutput(msg.content);
    // Files are stored separately from prose. Include their authoritative content
    // as data so contextual revisions work after streaming, edits, and reloads.
    const files = msg.files?.map(file => ({ id: file.id, title: file.title, type: file.type,
      language: file.language, format: file.format, content: file.editedContent ?? file.content }));
    const content = files?.length
      ? prose + "\n\nPreviously generated files (JSON data):\n" + JSON.stringify(files)
      : prose;
    const out: ChatMessageInput = { role: "assistant", content };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return out;
  }
  const parts: import("./gateway/types").ChatContentPart[] = [];
  const texts: string[] = [];
  for (const attachment of msg.attachments ?? []) {
    if (attachment.kind === "image" && attachment.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    } else if (attachment.pages && attachment.pages.length > 0) {
      // Scanned PDF: send the rasterized page images so the model can read them.
      for (const page of attachment.pages) {
        parts.push({ type: "image_url", image_url: { url: page } });
      }
    } else if (attachment.images && attachment.images.length > 0) {
      // Embedded images inside a document: send them so the model sees them
      // along with the surrounding document text.
      for (const img of attachment.images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      if (attachment.text) texts.push(`[Document: ${attachment.name}]\n${docText(attachment.text, msg.content, optimize)}`);
    } else if (attachment.transcript) {
      texts.push(`[Audio transcription of ${attachment.name}]\n${attachment.transcript}`);
    } else if (attachment.text) {
      texts.push(`[File: ${attachment.name}]\n${docText(attachment.text, msg.content, optimize)}`);
    }
  }
  if (msg.content.trim()) texts.push(msg.content);
  if (texts.length > 0) parts.push({ type: "text", text: texts.join("\n\n") });
  return { role: "user", content: parts.length > 0 ? parts : msg.content };
}
