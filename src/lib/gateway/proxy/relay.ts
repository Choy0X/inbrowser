/** Deployment-owned relay resolution shared by proxy transport and the catalog. */
import { APP_RELAY_URL } from "../../appConfig";

export interface RelayHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

/** Trailing slashes make `${base}/v1/fetch` produce a double slash on some hosts. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Deployment-owned relay. Legacy saved, imported, and explicit user overrides
 * must never redirect requests away from the configured deployment.
 */
export function getRelayUrl(_legacyOverride?: string): string {
  return normalize(APP_RELAY_URL);
}

export function relayFetchEndpoint(relayUrl: string): string {
  return `${normalize(relayUrl)}/v1/fetch`;
}

/** Deployment health probe retained for diagnostics. */
export async function testRelay(_legacyOverride: string, signal?: AbortSignal): Promise<RelayHealth> {
  const base = getRelayUrl();
  try {
    const res = await fetch(`${base}/health`, { method: "GET", signal });
    if (!res.ok) return { ok: false, error: `The relay answered ${res.status}.` };
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (!body?.ok) return { ok: false, error: "The relay answered, but not as a relay." };
    return { ok: true, version: body.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the relay." };
  }
}
