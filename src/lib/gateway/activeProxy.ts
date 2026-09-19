/**
 * Which proxy the paths without a retry loop should use.
 *
 * `chatStream` and `runCompletion` rotate across the pool as attempts fail, and
 * they own that logic themselves. Everything else - model discovery, media
 * generation, search, the page reader - makes one call with no failover, so it
 * just asks for the single best proxy.
 *
 * Deliberately no rotation here. Burning four proxies retrying a background
 * `listModels` would write four failures into the health store that chat depends
 * on for its own routing decisions, over a call the user can trivially retry.
 *
 * An empty or all-disabled pool returns null and the caller goes direct, which
 * is what keeps the default path unchanged for everyone who never configures a
 * proxy.
 */
import type { CustomProxy } from "../types";
import { getSettings, type GatewaySettings } from "../gatewaySettings";
import { pickProxy } from "./proxyRouting";

const NONE_EXCLUDED: ReadonlySet<string> = new Set<string>();

/** Every ordinary gateway selection uses the master switch, including passed drafts. */
export function pickProxyForSettings(
  settings: Pick<GatewaySettings, "mode" | "proxiesEnabled" | "proxies" | "proxyRoutingMode" | "manualProxyIds">,
  excluded: Set<string>,
  targetUrl?: string
): CustomProxy | null {
  if (settings.mode !== "direct" || settings.proxiesEnabled === false || settings.proxies.length === 0) return null;
  return pickProxy(settings.proxies, excluded, settings.proxyRoutingMode, settings.manualProxyIds, targetUrl);
}

export function getActiveProxy(): CustomProxy | null {
  return pickProxyForSettings(getSettings(), NONE_EXCLUDED as Set<string>);
}

/** Convenience for the many call sites that want `proxy?: CustomProxy`. */
export function activeProxyOrUndefined(): CustomProxy | undefined {
  return getActiveProxy() ?? undefined;
}
