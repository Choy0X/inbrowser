import { useEffect, useState } from "react";

const PLUGINS_KEY = "fachoy:plugins:v1";

export interface PluginState {
  installed: boolean;
  enabled: boolean;
}

export type PluginStateMap = Record<string, PluginState>;

const DEFAULTS: PluginStateMap = {
  javascript: { installed: true, enabled: true },
  python: { installed: false, enabled: false },
  "tool-regex": { installed: true, enabled: true },
  "tool-text-stats": { installed: true, enabled: true },
  "tool-diff": { installed: true, enabled: true },
  "tool-json": { installed: true, enabled: true },
  "tool-csv": { installed: true, enabled: true },
  "tool-hash": { installed: true, enabled: true },
  "tool-uuid": { installed: true, enabled: true },
  "tool-jwt": { installed: true, enabled: true },
  "tool-color": { installed: true, enabled: true },
  "tool-datetime": { installed: true, enabled: true },
  "tool-units": { installed: true, enabled: true },
};

export function loadPluginStates(): PluginStateMap {
  try {
    const raw = localStorage.getItem(PLUGINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function savePluginStates(states: PluginStateMap): void {
  try {
    localStorage.setItem(PLUGINS_KEY, JSON.stringify(states));
  } catch {
    /* ignore */
  }
}

export function getPluginState(states: PluginStateMap, pluginId: string): PluginState {
  return states[pluginId] ?? { installed: false, enabled: false };
}

/* ---------------------------------------------------------------------------
 * usePluginStates - one shared, cached read for every component that needs to
 * know what can run.
 *
 * Installing a runtime happens on another page, so the value has to be re-read
 * when the tab regains focus or the answer stays stale and a Run button stays
 * dead. ArtifactPanel did that with its own listener pair, which was fine while
 * exactly one panel existed; a chat transcript can hold dozens of code blocks,
 * and a per-block localStorage read plus a per-block listener is the same
 * fan-out CLAUDE.md warns about. The parse happens once per refresh here and
 * every subscriber gets the same object identity.
 * ------------------------------------------------------------------------- */

let cached: PluginStateMap | null = null;
let cachedSerialized = "";
const subscribers = new Set<(states: PluginStateMap) => void>();

/** Re-reads storage, but only publishes a new object when the value actually
 *  changed. loadPluginStates() allocates a fresh map every call, so notifying
 *  unconditionally would hand every subscriber a new identity - and every code
 *  block in the transcript a re-render - each time a block mounted. */
function refreshPluginStates(): void {
  const next = loadPluginStates();
  const serialized = JSON.stringify(next);
  if (cached && serialized === cachedSerialized) return;
  cached = next;
  cachedSerialized = serialized;
  for (const notify of subscribers) notify(next);
}

export function usePluginStates(): PluginStateMap {
  const [states, setStates] = useState<PluginStateMap>(() => {
    if (!cached) {
      cached = loadPluginStates();
      cachedSerialized = JSON.stringify(cached);
    }
    return cached;
  });

  useEffect(() => {
    subscribers.add(setStates);
    // Listeners are attached once for the whole app, not once per subscriber.
    if (subscribers.size === 1) {
      window.addEventListener("focus", refreshPluginStates);
      document.addEventListener("visibilitychange", refreshPluginStates);
    }
    // A subscriber mounting after an install elsewhere in this same tab (the
    // Plugins page writes and navigates back without a focus event) would
    // otherwise show the value cached before that write.
    refreshPluginStates();
    return () => {
      subscribers.delete(setStates);
      if (subscribers.size === 0) {
        window.removeEventListener("focus", refreshPluginStates);
        document.removeEventListener("visibilitychange", refreshPluginStates);
      }
    };
  }, []);

  return states;
}
