/**
 * Builds a `ProviderConnection` from a catalog preset (providerPresets.ts).
 * Extracted from SettingsModal.tsx so both the Settings UI and the default-seed
 * bootstrap (gatewaySettings.ts / defaultSeeding.ts) can build the same shape
 * without duplicating alias/model logic.
 */
import type { ProviderConnection } from "../types";
import { classifyModelCapabilities } from "../capabilities";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providerPresets";
import { newId } from "../store";

/** Capability-backfilled starter models for a freshly-added preset connection (see providerPresets.ts). */
export function starterModels(ids: string[]): ProviderConnection["models"] {
  return ids.map((id) => {
    const guessed = classifyModelCapabilities(id);
    return { id, supportsVision: guessed.vision, supportsVideo: guessed.video, supportsReasoning: guessed.reasoning };
  });
}

/** True when a connection already points at this preset's base URL — i.e. the user has already added this provider. */
export function isPresetAlreadyAdded(preset: ProviderPreset, existing: ProviderConnection[]): boolean {
  const target = preset.baseUrl.trim().toLowerCase();
  return existing.some((c) => c.baseUrl.trim().toLowerCase() === target);
}

/** The catalog preset a connection's base URL matches, if any — connections aren't tagged with
 *  their origin preset, so this is inferred the same way isPresetAlreadyAdded checks the reverse. */
export function presetForConnection(connection: ProviderConnection): ProviderPreset | undefined {
  const target = connection.baseUrl.trim().toLowerCase();
  return PROVIDER_PRESETS.find((p) => p.baseUrl.trim().toLowerCase() === target);
}

/** Keyless presets leave the key optional (it only raises rate limits). An "inference-keyed"
 *  preset has no real access without one, so unlike every other provider here, it must not be
 *  enabled until its key is filled in AND a Test against the real endpoint has succeeded. */
export function requiresVerifiedKey(connection: ProviderConnection): boolean {
  return presetForConnection(connection)?.category === "inference-keyed";
}

/** Picks a unique alias for a new preset connection, avoiding collisions with already-configured ones. */
export function uniqueAlias(suggestion: string, existing: ProviderConnection[]): string {
  const used = new Set(existing.map((c) => c.alias));
  if (!used.has(suggestion)) return suggestion;
  let n = 2;
  while (used.has(`${suggestion}${n}`)) n += 1;
  return `${suggestion}${n}`;
}

export function newConnectionFromPreset(preset: ProviderPreset, existing: ProviderConnection[]): ProviderConnection {
  return {
    id: newId(),
    alias: uniqueAlias(preset.aliasSuggestion, existing),
    label: preset.label,
    format: preset.format,
    baseUrl: preset.baseUrl,
    apiKey: "",
    models: starterModels(preset.starterModels),
    // inference-keyed presets have no access without a key yet, so they start
    // off until a key is entered and Test confirms it actually works.
    enabled: preset.category !== "inference-keyed",
  };
}

/**
 * Merge by id rather than replacing wholesale — a re-discover should keep each
 * still-present model's enabled/disabled choice (from the Models select field,
 * or a prior default-seed discovery) and only default genuinely new ids to
 * enabled. Shared by SettingsModal's manual "Discover" action and the
 * default-seed bootstrap in defaultSeeding.ts.
 */
export function mergeDiscoveredModels(
  existing: ProviderConnection["models"],
  discovered: ProviderConnection["models"]
): ProviderConnection["models"] {
  const existingById = new Map(existing.map((m) => [m.id, m]));
  return discovered.map((m) => {
    const found = existingById.get(m.id);
    return found ? { ...m, enabled: found.enabled } : { ...m, enabled: true };
  });
}

/**
 * Every keyless preset, pre-added and enabled. Used to seed a brand-new (or
 * previously empty) provider list so the app is chat-ready with zero setup —
 * see withDefaultProviderSeed() in gatewaySettings.ts.
 */
export function defaultProviderConnections(): ProviderConnection[] {
  const connections: ProviderConnection[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.keyless) continue;
    connections.push(newConnectionFromPreset(preset, connections));
  }
  return connections;
}
