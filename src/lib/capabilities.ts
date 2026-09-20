import type { OmniModel, ProviderConnection, ProviderPluginManifest, ProviderPluginModel } from "./types";
import { selectUsableModels } from "./gateway/routingEngine";
import { isSmallModel } from "./modelSize";

export interface ModelCapabilities {
  vision: boolean;
  video: boolean;
  reasoning: boolean;
  toolCalling: boolean;
  contextLength?: number;
  label?: string;
}

export interface CapabilityIndex {
  /** public alias ("oa") -> modelId -> entry */
  byAlias: Map<string, Map<string, ProviderPluginModel>>;
  /** provider id ("openai") -> modelId -> entry */
  byProvider: Map<string, Map<string, ProviderPluginModel>>;
  /**
   * alias -> friendly display name, for group labels in the model picker.
   * NOT alias -> connection.id: every connection (presets included) gets a
   * random newId() for its `id` (see SettingsModal.tsx's newConnection /
   * newConnectionFromPreset), so that was never a display-worthy string -
   * showing it verbatim is what put raw UUIDs in the picker's provider
   * headers for e.g. "pol"/"ovh" instead of their names.
   */
  aliasToLabel: Map<string, string>;
}

/** Direct-mode: build the index from the client's own provider registry. */
export function buildCapabilityIndexFromProviders(connections: ProviderConnection[]): CapabilityIndex {
  const index: CapabilityIndex = {
    byAlias: new Map(),
    byProvider: new Map(),
    aliasToLabel: new Map(),
  };
  for (const connection of connections) {
    if (!connection.enabled) continue;
    const hasKey = Boolean(connection.apiKey);
    const usable = connection.models.filter((m) => isChatCapableModelId(m.id));
    const modelsById = new Map<string, ProviderPluginModel>();
    for (const model of selectUsableModels(connection.alias, hasKey, usable)) {
      modelsById.set(model.id, model);
    }
    index.byProvider.set(connection.id, modelsById);
    index.byAlias.set(connection.alias, modelsById);
    index.aliasToLabel.set(connection.alias, connection.label?.trim() || connection.alias);
  }
  return index;
}

/** Gateway mode: build the index from the connected gateway's own provider-plugin-manifest. */
export function buildCapabilityIndexFromManifest(manifest: ProviderPluginManifest | null): CapabilityIndex {
  const index: CapabilityIndex = {
    byAlias: new Map(),
    byProvider: new Map(),
    aliasToLabel: new Map(),
  };
  if (!manifest) return index;
  for (const entry of manifest.providers) {
    const modelsById = new Map<string, ProviderPluginModel>();
    for (const model of entry.models) modelsById.set(model.id, model);
    index.byProvider.set(entry.id, modelsById);
    if (entry.alias) {
      index.byAlias.set(entry.alias, modelsById);
      // The manifest carries no separate display name (see
      // ProviderPluginManifestEntry) - the alias itself is the only
      // friendly string available here.
      index.aliasToLabel.set(entry.alias, entry.alias);
    }
  }
  return index;
}

// ---------------------------------------------------------------- classifier

const VISION_PATTERNS: RegExp[] = [
  /\b(4o|4\.1|4\.5|4\.6|5\.1|5\.2)\b/,
  /\bomni\b/,
  /(^|[^a-z])gemini/,
  /(^|[^a-z])claude/,
  /\bllava\b/,
  /\bpixtral\b/,
  /\bphi-4-multimodal\b/,
  /\bminicpm-v\b/,
  /\bidefics\b/,
  /\bfuyu\b/,
  /\binternvl\b/,
  /\bcogvlm\b/,
  /\bglm-4v\b/,
  /\bglm-4\.5v\b/,
  /(^|[^a-z])qwen[^ ]*-vl\b/,
  /(^|[^a-z])kimi[^ ]*vision/,
  /(^|[^a-z])o[34](-[a-z0-9]+)?$/, // o3 / o4 family
  /(^|[^a-z])gpt-5/,
  /\bvision\b/,
];

const VIDEO_PATTERNS: RegExp[] = [
  /(^|[^a-z])gemini/,
  /\bveo\b/,
  /\bvideo\b/,
  /(^|[^a-z])qwen[^ ]*-vl\b/,
];

const REASONING_PATTERNS: RegExp[] = [
  /(^|[^a-z])(o1|o1-mini|o1-pro|o3|o3-mini|o4|o4-mini)(\b|-)/,
  /\bthinking\b|\bthink\b/,
  /\breasoner\b|\breasoning\b/,
  /\bdeepseek-r1\b/,
  /\bdeepseek-v3\.1\b/,
  /(^|[^a-z])grok-3\b|\bgrok-4\b/,
  /\bkimi-k3\b/,
  /\bkimi-k2-thinking\b/,
  /\bglm-4\.5-thinking\b/,
  /(^|[^a-z])gpt-5/,
  /(^|[^a-z])claude[^ ]*-thinking/,
  /(^|[^a-z])qwen3(\b|-)/,
];

// Some providers' /v1/models list mixes real chat models in with
// embedding/rerank/audio/image/guard models that share the same endpoint
// but either 404 ("model does not exist") or silently answer with their own
// non-chat output format instead of a real reply when called via
// /chat/completions — e.g. OVHcloud AI Endpoints lists "Qwen3-Embedding-8B"
// (embedding) and "Qwen3Guard-Gen-8B" (a safety classifier that replies with
// "Safety: Safe / Categories: None" instead of an actual answer) right
// alongside its real chat models. These aren't chat models at all, so
// discovery excludes them outright rather than just misclassifying a
// capability flag. Guard/shield/safety-classifier names are intentionally
// matched as bare substrings (no \b) since they're often fused into the
// rest of the id with no separator (e.g. "Qwen3Guard", "ShieldGemma").
const NON_CHAT_PATTERNS: RegExp[] = [
  /\bembed(ding)?\b/,
  /\brerank(er|ing)?\b/,
  /\bwhisper\b/,
  /\btts\b|text-to-speech/,
  /\bdall-?e\b/,
  /\bmoderation\b/,
  /\bstable-diffusion\b|\bsdxl\b/,
  /guard/,
  /shield/,
  /\bsafety\b/,
  /\bnsfw\b/,
  // Embedding-model families whose id doesn't literally contain "embed"
  // (e.g. OVHcloud's "bge-m3", "bge-multilingual-gemma2").
  /\bbge\b/,
  /\bgte\b/,
  /\be5\b/,
  /\bminilm\b/,
];

function matchesAny(id: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(id));
}

/** True unless the model id looks like an embedding/rerank/audio/image model rather than a chat model. */
export function isChatCapableModelId(id: string): boolean {
  return !matchesAny(id.toLowerCase(), NON_CHAT_PATTERNS);
}

function classifyVision(id: string): boolean {
  return matchesAny(id, VISION_PATTERNS);
}

function classifyVideo(id: string): boolean {
  return matchesAny(id, VIDEO_PATTERNS);
}

function classifyReasoning(id: string): boolean {
  return matchesAny(id, REASONING_PATTERNS);
}

/**
 * Guesses vision/video/reasoning support from a bare model id via the same
 * regex heuristics `modelCapabilities` falls back to for models with no
 * manifest/connection entry. Used to backfill capability flags for
 * auto-discovered or preset-catalog models, whose source APIs mostly don't
 * report this metadata themselves (see gateway/providerPresets.ts and
 * onniroute.ts's discoverModels).
 */
export function classifyModelCapabilities(id: string): { vision: boolean; video: boolean; reasoning: boolean } {
  const key = id.toLowerCase();
  return { vision: classifyVision(key), video: classifyVideo(key), reasoning: classifyReasoning(key) };
}

// ---------------------------------------------------------------- resolution

function splitModelId(fullId: string): { prefix: string; rest: string } {
  const slash = fullId.indexOf("/");
  if (slash === -1) return { prefix: "", rest: fullId };
  return { prefix: fullId.slice(0, slash), rest: fullId.slice(slash + 1) };
}

/**
 * True if any model actually in `index` reports the given capability. Used to
 * ground the virtual "auto" router's own capabilities in reality instead of
 * claiming everything — otherwise a user with zero vision-capable models
 * configured still sees vision/video/reasoning/tools all "supported" the
 * moment they're on "auto", the app's default selection. Strict/fail-closed
 * for vision/video/reasoning (an unset flag never counts as capable); tool
 * calling mirrors the per-model resolution rule below, where it's assumed
 * supported unless a provider explicitly reports `false`.
 */
function anyModelHasCapability(index: CapabilityIndex, cap: "vision" | "video" | "reasoning" | "toolCalling"): boolean {
  for (const modelsById of index.byProvider.values()) {
    for (const entry of modelsById.values()) {
      if (cap === "vision" && entry.supportsVision === true) return true;
      if (cap === "video" && entry.supportsVideo === true) return true;
      if (cap === "reasoning" && entry.supportsReasoning === true) return true;
      if (cap === "toolCalling" && entry.toolCalling !== false) return true;
    }
  }
  return false;
}

/** Capabilities for a routable model id, e.g. "openai/gpt-4o" or "auto". */
export function modelCapabilities(fullId: string, index: CapabilityIndex): ModelCapabilities {
  const { prefix, rest } = splitModelId(fullId);

  // Virtual "auto" router — only ever reaches what's actually configured.
  if (prefix === "" && (rest === "auto" || rest === "auto/coding" || rest === "auto-coding")) {
    return {
      vision: anyModelHasCapability(index, "vision"),
      video: anyModelHasCapability(index, "video"),
      reasoning: anyModelHasCapability(index, "reasoning"),
      toolCalling: anyModelHasCapability(index, "toolCalling"),
    };
  }

  const entry =
    index.byAlias.get(prefix)?.get(rest) || index.byProvider.get(prefix)?.get(rest);

  if (entry) {
    return {
      vision: entry.supportsVision === true,
      video: entry.supportsVideo === true,
      reasoning: entry.supportsReasoning === true,
      toolCalling: entry.toolCalling !== false,
      contextLength: entry.contextLength,
      label: entry.name,
    };
  }

  const key = `${prefix}/${rest}`.toLowerCase();
  return {
    vision: classifyVision(key),
    video: classifyVideo(key),
    reasoning: classifyReasoning(key),
    // Unverified model with no catalog entry: a declared small parameter
    // count is reason enough not to hand it a live tools array, the same
    // "too small to follow a multi-clause contract" line promptScale.ts and
    // routingEngine.ts already draw for it.
    toolCalling: !isSmallModel(fullId),
  };
}

/** Friendly group label for a model prefix (public alias → connection display name). */
export function providerLabel(prefix: string, index: CapabilityIndex): string {
  return index.aliasToLabel.get(prefix) || prefix || "auto";
}

// ------------------------------------------------------------- media models

const IMAGE_MODEL_ID_HINT = /image|dall|flux|midjourney|stable|imagen|sdxl|sana|qwen-image|graphic|illustration/i;
const VIDEO_MODEL_ID_HINT = /video|veo|kling|runway|sora|pixverse|wan/i;

/**
 * How well a model fits an image/video generation request: 2 when its
 * capability flag says so, 1 when only its id hints at it (no catalog data),
 * 0 when neither. Shared by GenerationPanel's own model dropdown and the
 * Composer's "is this feature usable at all" gate so the two can't drift.
 */
export function mediaModelScore(id: string, caps: ModelCapabilities, mode: "image" | "video"): 0 | 1 | 2 {
  if (mode === "video") {
    if (caps.video) return 2;
    if (VIDEO_MODEL_ID_HINT.test(id)) return 1;
    return 0;
  }
  if (caps.vision) return 2;
  if (IMAGE_MODEL_ID_HINT.test(id)) return 1;
  return 0;
}

/** True if at least one real (non-"auto") configured model can serve the given
 *  generation mode. "edit" shares "image"'s answer — both need image capability. */
export function hasMediaCapableModel(models: OmniModel[], index: CapabilityIndex, mode: "image" | "video"): boolean {
  return models.some((m) => m.id !== "auto" && mediaModelScore(m.id, modelCapabilities(m.id, index), mode) > 0);
}