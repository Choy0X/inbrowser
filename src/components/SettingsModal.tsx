import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  Download,
  GripVertical,
  ListOrdered,
  Loader2,
  MousePointerClick,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import type {
  ConnectionMode,
  CustomProxy,
  GatewaySettings,
  OmniRouteConnectionSettings,
  OmniRouteTestResult,
  ProviderConnection,
  ProviderFormat,
  ProxyRoutingMode,
  ProxyTestResult,
  SearchBackend,
  TestResult,
} from "../lib/onniroute";
import { DEFAULT_OMNIROUTE_URL, discoverModels } from "../lib/onniroute";
import { dismissLegacyProxyNotice, legacyProxyCount, legacyProxyExport } from "../lib/gatewaySettings";
import { listModels } from "../lib/gateway/omniroute";
import type { OmniModel, ProxyProtocol } from "../lib/types";
import { PROXY_PROTOCOLS, proxySupportsPassword } from "../lib/types";
import { classifyModelCapabilities } from "../lib/capabilities";
import { PROVIDER_PRESETS, type PresetCategory, type ProviderPreset } from "../lib/gateway/providerPresets";
import { newId, type ThemeMode } from "../lib/store";
import { allTools } from "../lib/tools/registry";
import type { Preferences, MemoryItem } from "../lib/preferences";
import { MAX_MEMORIES, newMemoryItem } from "../lib/preferences";
import { Toggle } from "./Toggle";
import { Tooltip } from "./Tooltip";
import { ModelMultiSelect } from "./ModelMultiSelect";
import { Dialog, ConfirmDialog, useModalFocus } from "./Dialog";
import { FreeProxyFinderModal } from "./FreeProxyFinderModal";
import { Button, Input, Select, Textarea, SearchInput } from "./ui";
import { APP_NAME } from "../lib/appConfig";
import { ProxyListDialog } from "./ProxyListDialog";
import { mergeCatalogProxies } from "../lib/gateway/freeProxyCatalog";

export type SettingsTab = "general" | "providers" | "proxies" | "personalization" | "memory";

interface SettingsModalProps {
  open: boolean;
  initialTab: SettingsTab;
  onClose: () => void;
  settings: GatewaySettings;
  onSave: (settings: GatewaySettings) => void;
  onTestConnection: (connection: ProviderConnection) => Promise<TestResult>;
  onTestOmniRoute: (baseUrl: string, apiKey: string) => Promise<OmniRouteTestResult>;
  onTestProxy: (proxy: CustomProxy, relayUrl?: string, allowInsecureProxyTls?: boolean) => Promise<ProxyTestResult>;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  preferences: Preferences;
  onSavePreferences: (preferences: Preferences) => void;
  /** Writes a backup archive to disk. App owns the data, so it does the work. */
  onExportBackup: () => Promise<void>;
  /** Restores a backup archive, returning a human-readable summary of what changed. */
  onImportBackup: (file: File) => Promise<string>;
}

type TestState<R> =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; result: R }
  | { status: "fail"; message: string; code?: string };

const MODE_OPTIONS: { value: ConnectionMode; label: string; description: string }[] = [
  {
    value: "direct",
    label: "Browser-Hosted OmniRoute",
    description: "Browser-native — talk to each provider (OpenAI, Anthropic, Gemini, ...) directly, no external gateway needed.",
  },
  {
    value: "omniroute",
    label: "OmniRoute Gateway",
    description: "Point at a real OmniRoute gateway instance for chat, models, search, and media.",
  },
];

const PROXY_PROTOCOL_LABELS: Record<ProxyProtocol, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks5: "SOCKS5",
  socks4: "SOCKS4",
};

/** Editing any of these makes a previous Test result meaningless. */
const PROXY_TEST_INVALIDATING_FIELDS: (keyof CustomProxy)[] = [
  "protocol",
  "host",
  "port",
  "username",
  "password",
  "allowInsecureTls",
];

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

const PROXY_MODE_OPTIONS: {
  value: ProxyRoutingMode;
  label: string;
  description: string;
  icon: typeof Wand2;
}[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Balance recent reliability, response speed, and active requests, learning which proxies work for each provider.",
    icon: Wand2,
  },
  {
    value: "manual",
    label: "Manual",
    description: "Use your selected proxies in list order. Open a proxy to change its selection.",
    icon: MousePointerClick,
  },
  {
    value: "order",
    label: "Priority order",
    description: "Try proxies top to bottom in the order you drag them into below.",
    icon: ListOrdered,
  },
];

const FORMAT_OPTIONS: { value: ProviderFormat; label: string; placeholderBaseUrl: string }[] = [
  { value: "local", label: "Local (runs in this browser)", placeholderBaseUrl: "local://webllm" },
  { value: "openai", label: "OpenAI-compatible", placeholderBaseUrl: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", placeholderBaseUrl: "https://api.anthropic.com/v1" },
  { value: "gemini", label: "Google Gemini", placeholderBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
];

const SEARCH_BACKENDS: { value: SearchBackend; label: string; needsKey: boolean }[] = [
  { value: "duckduckgo", label: "DuckDuckGo (no key needed)", needsKey: false },
  { value: "serper", label: "Serper (Google, free key)", needsKey: true },
  { value: "jina", label: "Jina Search (free key)", needsKey: true },
];

function newConnection(): ProviderConnection {
  return {
    id: newId(),
    alias: "",
    label: "",
    format: "openai",
    baseUrl: "",
    apiKey: "",
    models: [],
    enabled: true,
  };
}

function newProxy(): CustomProxy {
  return { id: newId(), label: "", protocol: "socks5", host: "", port: 1080, username: "", password: "", enabled: true };
}

/** Capability-backfilled starter models for a freshly-added preset connection (see providerPresets.ts). */
function starterModels(ids: string[]): ProviderConnection["models"] {
  return ids.map((id) => {
    const guessed = classifyModelCapabilities(id);
    return { id, supportsVision: guessed.vision, supportsVideo: guessed.video, supportsReasoning: guessed.reasoning };
  });
}

/** True when a connection already points at this preset's base URL — i.e. the user has already added this provider. */
function isPresetAlreadyAdded(preset: ProviderPreset, existing: ProviderConnection[]): boolean {
  const target = preset.baseUrl.trim().toLowerCase();
  return existing.some((c) => c.baseUrl.trim().toLowerCase() === target);
}

/** The catalog preset a connection's base URL matches, if any — connections aren't tagged with
 *  their origin preset, so this is inferred the same way isPresetAlreadyAdded checks the reverse. */
function presetForConnection(connection: ProviderConnection): ProviderPreset | undefined {
  const target = connection.baseUrl.trim().toLowerCase();
  return PROVIDER_PRESETS.find((p) => p.baseUrl.trim().toLowerCase() === target);
}

/** Keyless presets leave the key optional (it only raises rate limits). An "inference-keyed"
 *  preset has no real access without one, so unlike every other provider here, it must not be
 *  enabled until its key is filled in AND a Test against the real endpoint has succeeded. */
function requiresVerifiedKey(connection: ProviderConnection): boolean {
  return presetForConnection(connection)?.category === "inference-keyed";
}

/** Picks a unique alias for a new preset connection, avoiding collisions with already-configured ones. */
function uniqueAlias(suggestion: string, existing: ProviderConnection[]): string {
  const used = new Set(existing.map((c) => c.alias));
  if (!used.has(suggestion)) return suggestion;
  let n = 2;
  while (used.has(`${suggestion}${n}`)) n += 1;
  return `${suggestion}${n}`;
}

function newConnectionFromPreset(preset: ProviderPreset, existing: ProviderConnection[]): ProviderConnection {
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

// Stable "idle" fallback so cards whose test/discovery hasn't run don't get a
// fresh {status:"idle"} object literal (and therefore a React.memo-breaking
// new prop identity) on every parent re-render.
const IDLE_STATE = { status: "idle" as const };

interface ProviderConnectionCardProps {
  connection: ProviderConnection;
  testState: TestState<TestResult>;
  discoveryState: TestState<number>;
  autoDiscoveredRef: React.MutableRefObject<Set<string>>;
  onUpdate: (id: string, patch: Partial<ProviderConnection>) => void;
  onRemove: (id: string) => void;
  onTest: (connection: ProviderConnection) => void;
  onDiscover: (connection: ProviderConnection) => void;
}

/**
 * One provider connection's editable card. Memoized so editing one
 * connection (or its own unrelated fields) doesn't force every other card —
 * some of which may hold thousands of auto-discovered models — to re-render.
 */
const ProviderConnectionCard = memo(function ProviderConnectionCard({
  connection,
  testState,
  discoveryState,
  autoDiscoveredRef,
  onUpdate,
  onRemove,
  onTest,
  onDiscover,
}: ProviderConnectionCardProps) {
  const format = FORMAT_OPTIONS.find((f) => f.value === connection.format) ?? FORMAT_OPTIONS[0];
  const needsKeyVerification = requiresVerifiedKey(connection);
  const presetRequirement = presetForConnection(connection)?.requirement;
  const keyVerified = testState.status === "ok" && connection.apiKey.trim().length > 0;
  const lockedOff = needsKeyVerification && !keyVerified;

  return (
    <div className="space-y-2.5 rounded-xl border border-border-subtle bg-canvas p-3">
      {presetRequirement && <p className="text-xs leading-5 text-fg-dim">{presetRequirement}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Tooltip
            label={lockedOff ? "Add an API key and pass Test to enable this provider" : "Enable this provider"}
          >
            <span>
              <Toggle
                checked={connection.enabled && !lockedOff}
                disabled={lockedOff}
                onChange={(next) => onUpdate(connection.id, { enabled: next })}
              />
            </span>
          </Tooltip>
          <input
            value={connection.label ?? ""}
            onChange={(e) => onUpdate(connection.id, { label: e.target.value })}
            placeholder="Label (optional)"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-fg-faint placeholder:font-normal"
          />
        </div>
        <Tooltip label="Remove provider">
          <button
            type="button"
            onClick={() => onRemove(connection.id)}
            className="shrink-0 rounded p-1 text-fg-faint hover:text-error"
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-xs text-fg-dim">Alias (routing prefix)</label>
          <Input
            value={connection.alias}
            onChange={(e) => onUpdate(connection.id, { alias: e.target.value.trim() })}
            placeholder="oa"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-fg-dim">Format</label>
          <Select
            value={connection.format}
            onChange={(e) => onUpdate(connection.id, { format: e.target.value as ProviderFormat })}
          >
            {FORMAT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-fg-dim">Base URL</label>
        <Input
          value={connection.baseUrl}
          onChange={(e) => onUpdate(connection.id, { baseUrl: e.target.value.trim() })}
          placeholder={format.placeholderBaseUrl}
          spellCheck={false}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-fg-dim">API key</label>
        <Input
          type="password"
          value={connection.apiKey}
          onChange={(e) => onUpdate(connection.id, { apiKey: e.target.value })}
          onBlur={() => {
            if (connection.baseUrl && connection.apiKey && !autoDiscoveredRef.current.has(connection.id)) {
              autoDiscoveredRef.current.add(connection.id);
              onDiscover(connection);
            }
          }}
          placeholder={
            needsKeyVerification
              ? "Required — this provider has no free access without a key"
              : "Sent directly to the provider, never stored server-side"
          }
          spellCheck={false}
        />
        {needsKeyVerification && !keyVerified && (
          <p className="mt-1 text-xs text-warning">
            {connection.apiKey.trim()
              ? "Click Test below to verify this key before the provider can be enabled."
              : "This provider requires a valid API key — it stays disabled until one is added and Test passes."}
          </p>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-fg-dim">Models</label>
          <button
            type="button"
            onClick={() => onDiscover(connection)}
            disabled={discoveryState.status === "testing" || !connection.baseUrl}
            className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg disabled:opacity-40"
          >
            {discoveryState.status === "testing" ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Sparkles size={11} />
            )}
            Discover models
          </button>
        </div>
        <ModelMultiSelect models={connection.models} onChange={(models) => onUpdate(connection.id, { models })} />
        {discoveryState.status === "ok" && (
          <p className="mt-1 text-xs text-success">Discovered {discoveryState.result} models.</p>
        )}
        {discoveryState.status === "fail" && (
          <p className="mt-1 text-xs text-error">Discovery failed: {discoveryState.message}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => onTest(connection)}
          disabled={testState.status === "testing" || !connection.baseUrl}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-xs font-medium hover:bg-bg-hover disabled:opacity-50"
        >
          {testState.status === "testing" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          Test
        </button>
      </div>

      {testState.status === "ok" && (
        <div className="flex items-center gap-1 text-xs text-success">
          <Check size={13} /> Replied “{testState.result.reply || "(empty)"}” · {testState.result.latencyMs} ms
        </div>
      )}
      {testState.status === "fail" && <div className="text-xs text-error">Failed: {testState.message}</div>}
    </div>
  );
});

const CustomProxyRow = memo(function CustomProxyRow({ proxy, mode, onOpen }: {
  proxy: CustomProxy; mode: ProxyRoutingMode; onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: proxy.id, disabled: mode !== "order" });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
    className={`flex items-center rounded-xl border bg-canvas ${isDragging ? "border-accent shadow-lift" : "border-border-subtle"}`}>
    {mode === "order" && <button type="button" {...attributes} {...listeners} aria-label={`Reorder ${proxy.label || "proxy"}`} className="flex h-11 w-10 shrink-0 touch-none items-center justify-center text-fg-faint hover:text-fg"><GripVertical size={16} /></button>}
    <button type="button" onClick={() => onOpen(proxy.id)} className="min-w-0 flex-1 rounded-xl px-4 py-3 text-left text-sm font-medium hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <span className="block truncate">{proxy.label || "Unnamed proxy"}</span>
    </button>
  </div>;
});

export function SettingsModal({
  open,
  initialTab,
  onClose,
  settings,
  onSave,
  onTestConnection,
  onTestOmniRoute,
  onTestProxy,
  theme,
  onThemeChange,
  preferences,
  onSavePreferences,
  onExportBackup,
  onImportBackup,
}: SettingsModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, open, onClose);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [draftTheme, setDraftTheme] = useState<ThemeMode>(theme);
  const [draftMode, setDraftMode] = useState<ConnectionMode>(settings.mode);
  const [draftOmniRoute, setDraftOmniRoute] = useState<OmniRouteConnectionSettings>(settings.omniroute);
  const [draftProviders, setDraftProviders] = useState<ProviderConnection[]>(settings.providers);
  const [draftProxies, setDraftProxies] = useState<CustomProxy[]>(settings.proxies);
  const [draftProxyMode, setDraftProxyMode] = useState<ProxyRoutingMode>(settings.proxyRoutingMode);
  const [draftManualProxyIds, setDraftManualProxyIds] = useState<string[]>(settings.manualProxyIds);
  const [draftAllowInsecureProxyTls, setDraftAllowInsecureProxyTls] = useState(settings.allowInsecureProxyTls);
  const proxyTestGeneration = useRef(0);
  const [legacyProxies, setLegacyProxies] = useState(0);
  const [draftSearch, setDraftSearch] = useState(settings.search);
  const [testByConnectionId, setTestByConnectionId] = useState<Record<string, TestState<TestResult>>>({});
  const [testByProxyId, setTestByProxyId] = useState<Record<string, TestState<ProxyTestResult>>>({});
  const [omniRouteTest, setOmniRouteTest] = useState<TestState<OmniRouteTestResult>>({ status: "idle" });
  const [omniRouteModels, setOmniRouteModels] = useState<TestState<OmniModel[]>>({ status: "idle" });
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [presetSearch, setPresetSearch] = useState("");
  const [duplicatePreset, setDuplicatePreset] = useState<ProviderPreset | null>(null);
  const [discoveryByConnectionId, setDiscoveryByConnectionId] = useState<Record<string, TestState<number>>>({});
  const autoDiscoveredRef = useRef<Set<string>>(new Set());
  const [draftPrefs, setDraftPrefs] = useState<Preferences>(preferences);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [backupMessage, setBackupMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [freeProxyFinderOpen, setFreeProxyFinderOpen] = useState(false);
  const [proxyIoMessage, setProxyIoMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [proxyIoMode, setProxyIoMode] = useState<"import" | "export" | null>(null);
  const [proxyExportSelection, setProxyExportSelection] = useState<CustomProxy[] | null>(null);
  const [selectedProxyId, setSelectedProxyId] = useState<string | null>(null);
  const closeProxyDetails = useCallback(() => setSelectedProxyId(null), []);
  const proxyTestVersions = useRef<Record<string, number>>({});
  const selectedProxy = draftProxies.find(p => p.id === selectedProxyId);
  const [newMemory, setNewMemory] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryText, setEditingMemoryText] = useState("");
  const [memoryFilter, setMemoryFilter] = useState("");

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setDraftTheme(theme);
      setDraftMode(settings.mode);
      setDraftOmniRoute(settings.omniroute);
      setDraftProviders(settings.providers);
      setDraftProxies(settings.proxies);
      setDraftProxyMode(settings.proxyRoutingMode);
      setDraftManualProxyIds(settings.manualProxyIds);
      setDraftAllowInsecureProxyTls(settings.allowInsecureProxyTls);
      proxyTestGeneration.current++;
      setLegacyProxies(legacyProxyCount());
      setDraftSearch(settings.search);
      setTestByConnectionId({});
      setTestByProxyId({});
      setSelectedProxyId(null);
      setFreeProxyFinderOpen(false);
      setProxyIoMode(null);
      setOmniRouteTest({ status: "idle" });
      setOmniRouteModels({ status: "idle" });
      setPresetPickerOpen(false);
      setPresetSearch("");
      setDuplicatePreset(null);
      setDiscoveryByConnectionId({});
      autoDiscoveredRef.current = new Set(settings.providers.map((c) => c.id));
      setDraftPrefs(preferences);
      setNewMemory("");
      setEditingMemoryId(null);
      setEditingMemoryText("");
      setMemoryFilter("");
    }
  }, [open, initialTab, theme, settings, preferences]);

  const updateConnection = useCallback((id: string, patch: Partial<ProviderConnection>) => {
    setDraftProviders((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    // Editing the key or endpoint invalidates whatever a previous Test proved —
    // a passing test for the old key says nothing about the new one.
    if ("apiKey" in patch || "baseUrl" in patch) {
      setTestByConnectionId((t) => ({ ...t, [id]: { status: "idle" } }));
    }
  }, []);

  const removeConnection = useCallback((id: string) => {
    setDraftProviders((list) => list.filter((c) => c.id !== id));
    setTestByConnectionId((t) => {
      const { [id]: _removed, ...rest } = t;
      return rest;
    });
    setDiscoveryByConnectionId((s) => {
      const { [id]: _removed, ...rest } = s;
      return rest;
    });
  }, []);

  const addConnectionFromPreset = (preset: ProviderPreset) => {
    const connection = newConnectionFromPreset(preset, draftProviders);
    setDraftProviders((list) => [connection, ...list]);
    setPresetPickerOpen(false);
    setPresetSearch("");
    // Keyless presets (local runners, OpenCode Free) are already usable —
    // no key to wait for, so discover their real model list right away.
    if (preset.keyless) {
      autoDiscoveredRef.current.add(connection.id);
      void runDiscovery(connection);
    }
  };

  /** You can add the same provider multiple times (e.g. a second API key) —
   *  just confirm first, since clicking the same tile twice is more often a
   *  mis-click than an intentional second connection. */
  const handlePresetClick = (preset: ProviderPreset) => {
    if (isPresetAlreadyAdded(preset, draftProviders)) {
      setDuplicatePreset(preset);
      return;
    }
    addConnectionFromPreset(preset);
  };

  const addCustomConnection = () => {
    setDraftProviders((list) => [newConnection(), ...list]);
    setPresetPickerOpen(false);
  };

  const updateProxy = useCallback((id: string, patch: Partial<CustomProxy>) => {
    const invalidatesObservation = PROXY_TEST_INVALIDATING_FIELDS.some(field => field in patch);
    setDraftProxies((list) => list.map((p) => (p.id === id ? { ...p, ...(invalidatesObservation ? { catalog: undefined } : {}), ...patch } : p)));
    // Any field that changes where or how we dial invalidates a previous Test
    // result. A stale green tick next to an edited host is worse than no tick.
    if (PROXY_TEST_INVALIDATING_FIELDS.some((field) => field in patch)) {
      proxyTestVersions.current[id] = (proxyTestVersions.current[id] ?? 0) + 1;
      setTestByProxyId((t) => ({ ...t, [id]: { status: "idle" } }));
    }
  }, []);

  const removeProxy = useCallback((id: string) => {
    proxyTestVersions.current[id] = (proxyTestVersions.current[id] ?? 0) + 1;
    setSelectedProxyId(null);
    setDraftProxies((list) => list.filter((p) => p.id !== id));
    setTestByProxyId((t) => {
      const { [id]: _removed, ...rest } = t;
      return rest;
    });
    setDraftManualProxyIds((current) => current.filter((pid) => pid !== id));
  }, []);

  const addProxy = () => {
    const proxy = newProxy();
    setDraftProxies((list) => [proxy, ...list]);
    setSelectedProxyId(proxy.id);
  };

  const runProxyTest = useCallback(
    async (proxy: CustomProxy) => {
      const generation = proxyTestGeneration.current;
      const version = (proxyTestVersions.current[proxy.id] ?? 0) + 1;
      proxyTestVersions.current[proxy.id] = version;
      setTestByProxyId((t) => ({ ...t, [proxy.id]: { status: "testing" } }));
      try {
        const result = await onTestProxy(proxy, undefined, draftAllowInsecureProxyTls);
        if (generation !== proxyTestGeneration.current || version !== proxyTestVersions.current[proxy.id]) return;
        setTestByProxyId((t) => ({
          ...t,
          [proxy.id]: result.ok
            ? { status: "ok", result }
            : { status: "fail", message: result.error ?? `HTTP ${result.status}`, code: result.code },
        }));
      } catch (err) {
        if (generation !== proxyTestGeneration.current || version !== proxyTestVersions.current[proxy.id]) return;
        setTestByProxyId((t) => ({
          ...t,
          [proxy.id]: { status: "fail", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [onTestProxy, draftAllowInsecureProxyTls]
  );

  const proxySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleProxyDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraftProxies((list) => {
      const oldIndex = list.findIndex((p) => p.id === active.id);
      const newIndex = list.findIndex((p) => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return list;
      return arrayMove(list, oldIndex, newIndex);
    });
  }, []);

  const toggleManualProxy = useCallback(
    (id: string) => {
      setDraftManualProxyIds((current) => {
        if (current.includes(id)) return current.filter((pid) => pid !== id);
        // Checking a proxy for manual use is its enable signal in this mode
        // (there's no separate enable checkbox for it while manual is active).
        updateProxy(id, { enabled: true });
        return [...current, id];
      });
    },
    [updateProxy]
  );

  const handleAddFreeProxies = useCallback((proxies: CustomProxy[]) => {
    setDraftProxies((list) => mergeCatalogProxies(list, proxies));
  }, []);

  /** The archived pre-rework CORS proxies, for the one-time migration notice. */
  const downloadLegacyProxies = () => {
    const blob = new Blob([legacyProxyExport()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inbrowser-legacy-cors-proxies.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const runDiscovery = useCallback(
    async (connection: ProviderConnection) => {
      setDiscoveryByConnectionId((s) => ({ ...s, [connection.id]: { status: "testing" } }));
      try {
        const discovered = await discoverModels(connection);
        // Merge by id rather than replacing wholesale — a re-discover should
        // keep each still-present model's enabled/disabled choice (from the
        // Models select field) and only default genuinely new ids to enabled.
        const existingById = new Map(connection.models.map((m) => [m.id, m]));
        const models = discovered.map((m) => {
          const existing = existingById.get(m.id);
          return existing ? { ...m, enabled: existing.enabled } : { ...m, enabled: true };
        });
        updateConnection(connection.id, { models });
        setDiscoveryByConnectionId((s) => ({ ...s, [connection.id]: { status: "ok", result: models.length } }));
      } catch (err) {
        setDiscoveryByConnectionId((s) => ({
          ...s,
          [connection.id]: { status: "fail", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [updateConnection]
  );

  const runConnectionTest = useCallback(
    async (connection: ProviderConnection) => {
      setTestByConnectionId((t) => ({ ...t, [connection.id]: { status: "testing" } }));
      try {
        const result = await onTestConnection(connection);
        setTestByConnectionId((t) => ({ ...t, [connection.id]: { status: "ok", result } }));
      } catch (err) {
        setTestByConnectionId((t) => ({
          ...t,
          [connection.id]: { status: "fail", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [onTestConnection]
  );

  const runOmniRouteTest = async () => {
    setOmniRouteTest({ status: "testing" });
    try {
      const result = await onTestOmniRoute(draftOmniRoute.baseUrl, draftOmniRoute.apiKey);
      setOmniRouteTest({ status: "ok", result });
    } catch (err) {
      setOmniRouteTest({ status: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Live, read-only mirror of the connected gateway's own /v1/models — not a
  // picker (the real OmniRoute server owns provider/model routing
  // server-side), just confirms what it actually reports. Debounced so
  // typing a base URL/key doesn't fire a request per keystroke.
  useEffect(() => {
    if (!open || draftMode !== "omniroute") {
      setOmniRouteModels({ status: "idle" });
      return;
    }
    const baseUrl = draftOmniRoute.baseUrl.trim();
    if (!baseUrl) {
      setOmniRouteModels({ status: "idle" });
      return;
    }
    let cancelled = false;
    setOmniRouteModels({ status: "testing" });
    const timer = setTimeout(async () => {
      try {
        const models = await listModels(baseUrl, draftOmniRoute.apiKey);
        if (!cancelled) setOmniRouteModels({ status: "ok", result: models });
      } catch (err) {
        if (!cancelled) {
          setOmniRouteModels({ status: "fail", message: err instanceof Error ? err.message : String(err) });
        }
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, draftMode, draftOmniRoute.baseUrl, draftOmniRoute.apiKey]);

  const filteredMemories = useMemo(() => {
    const q = memoryFilter.trim().toLowerCase();
    return q ? draftPrefs.memories.filter((m) => m.text.toLowerCase().includes(q)) : draftPrefs.memories;
  }, [draftPrefs.memories, memoryFilter]);

  // Group the gateway's /v1/models response by its alias prefix (?prefix=alias
  // means every id already comes back as "<alias>/<modelId>").
  const omniRouteModelGroups = useMemo(() => {
    if (omniRouteModels.status !== "ok") return [];
    const groups = new Map<string, string[]>();
    for (const model of omniRouteModels.result) {
      const slash = model.id.indexOf("/");
      const alias = slash === -1 ? model.id : model.id.slice(0, slash);
      const rest = slash === -1 ? model.id : model.id.slice(slash + 1);
      const list = groups.get(alias);
      if (list) list.push(rest);
      else groups.set(alias, [rest]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [omniRouteModels]);

  if (!open) return null;

  const runExport = async () => {
    setBackupBusy("export");
    setBackupMessage(null);
    try {
      await onExportBackup();
      setBackupMessage({ tone: "ok", text: "Backup downloaded." });
    } catch (err) {
      setBackupMessage({ tone: "error", text: err instanceof Error ? err.message : "Export failed." });
    } finally {
      setBackupBusy(null);
    }
  };

  const runImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBackupBusy("import");
    setBackupMessage(null);
    void (async () => {
      try {
        setBackupMessage({ tone: "ok", text: await onImportBackup(file) });
      } catch (err) {
        setBackupMessage({ tone: "error", text: err instanceof Error ? err.message : "Import failed." });
      } finally {
        setBackupBusy(null);
      }
    })();
  };

  const save = () => {
    // Authoritative gate: an inference-keyed connection can only be saved enabled if this
    // exact session's Test call against its current key actually passed. The Toggle already
    // blocks turning one on in the UI, but this is what actually can't be bypassed - e.g. a
    // connection that was verified, then had its key edited afterward without re-testing.
    const providers = draftProviders.map((c) => {
      if (!requiresVerifiedKey(c)) return c;
      const verified = testByConnectionId[c.id]?.status === "ok" && c.apiKey.trim().length > 0;
      return verified ? c : { ...c, enabled: false };
    });
    onSave({
      mode: draftMode,
      omniroute: draftOmniRoute,
      providers,
      proxies: draftProxies,
      proxyRoutingMode: draftProxyMode,
      manualProxyIds: draftManualProxyIds,
      relayUrl: "",
      allowInsecureProxyTls: draftAllowInsecureProxyTls,
      search: draftSearch,
    });
    onThemeChange(draftTheme);
    onSavePreferences(draftPrefs);
    onClose();
  };

  const addMemory = () => {
    const text = newMemory.trim();
    if (!text) return;
    const item = newMemoryItem(text);
    setDraftPrefs((p) => ({
      ...p,
      memories: [item, ...p.memories].slice(0, MAX_MEMORIES),
    }));
    setNewMemory("");
  };

  const removeMemory = (id: string) => {
    setDraftPrefs((p) => ({ ...p, memories: p.memories.filter((m) => m.id !== id) }));
  };

  const updateMemoryText = (id: string, text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      setDraftPrefs((p) => ({
        ...p,
        memories: p.memories.map((m) => (m.id === id ? { ...m, text: trimmed } : m)),
      }));
    }
    setEditingMemoryId(null);
  };

  const acceptPending = (id: string) => {
    setDraftPrefs((p) => {
      const item = p.pendingMemories.find((m) => m.id === id);
      if (!item) return p;
      return {
        ...p,
        pendingMemories: p.pendingMemories.filter((m) => m.id !== id),
        memories: [item, ...p.memories].slice(0, MAX_MEMORIES),
      };
    });
  };

  const rejectPending = (id: string) => {
    setDraftPrefs((p) => ({ ...p, pendingMemories: p.pendingMemories.filter((m) => m.id !== id) }));
  };

  const acceptAllPending = () => {
    setDraftPrefs((p) => ({
      ...p,
      memories: [...p.pendingMemories, ...p.memories].slice(0, MAX_MEMORIES),
      pendingMemories: [],
    }));
  };

  const rejectAllPending = () => setDraftPrefs((p) => ({ ...p, pendingMemories: [] }));

  const tabOptions: { value: SettingsTab; label: string; badge?: ReactNode }[] = [
    { value: "general", label: "General" },
    { value: "providers", label: "Providers" },
    { value: "proxies", label: "Proxies" },
    { value: "personalization", label: "Personalization" },
    {
      value: "memory",
      label: "Memory",
      badge:
        draftPrefs.pendingMemories.length > 0 ? (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-on-accent">
            {draftPrefs.pendingMemories.length}
          </span>
        ) : undefined,
    },
  ];

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center md:p-6">
      <div className="fixed inset-0 bg-overlay/60" aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="relative z-10 flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-bg-elevated outline-none max-md:[&_button]:min-h-11 md:h-[min(52rem,calc(100dvh-3rem))] md:max-w-4xl md:rounded-lg md:border md:border-border md:shadow-lift">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <h2 id="settings-title" className="text-base font-medium">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-canvas p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <X size={18} />
          </button>
        </div>

        <label className="shrink-0 border-b border-border-subtle px-4 py-2 text-xs text-fg-dim md:hidden">Section
          <Select className="mt-1 min-h-11" value={tab} onChange={event => setTab(event.target.value as SettingsTab)}>
            {tabOptions.map(option => <option key={option.value} value={option.value}>{option.label}{option.value === "memory" && draftPrefs.pendingMemories.length ? ` (${draftPrefs.pendingMemories.length} pending)` : ""}</option>)}
          </Select>
        </label>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Settings sections" className="hidden w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border-subtle p-2 md:block">
            {tabOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTab(opt.value)}
                data-ui="nav-item"
                aria-current={tab === opt.value ? "page" : undefined}
                data-active={tab === opt.value ? "" : undefined}
                className={`flex w-full items-center justify-between gap-2 px-2.5 text-sm transition-colors ${
                  tab === opt.value
                    ? "border-accent bg-bg-hover text-fg"
                    : "border-transparent text-fg-dim hover:bg-bg-hover/60 hover:text-fg"
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {opt.badge}
              </button>
            ))}
          </nav>

          <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5 sm:py-5">
          {tab === "general" && (
            <div>
              <div className="mb-1.5 text-sm font-medium">Appearance</div>
              <div className="rounded-xl border border-border-subtle bg-canvas p-4">
                <div className="text-sm font-medium">Theme</div>
                <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                  Match your operating system or pick a fixed appearance.
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {(
                    [
                      ["system", "System", Monitor],
                      ["light", "Light", Sun],
                      ["dark", "Dark", Moon],
                    ] as [ThemeMode, string, typeof Monitor][]
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDraftTheme(value)}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors ${
                        draftTheme === value
                          ? "border-accent bg-accent/10 text-fg"
                          : "border-border bg-canvas text-fg-dim hover:bg-bg-hover hover:text-fg"
                      }`}
                    >
                      <Icon size={18} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-canvas p-4">
                <div>
                  <div className="text-sm font-medium">Token optimization</div>
                  <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                    Reduce tokens sent and received on long conversations: older messages are
                    retrieved by relevance instead of resent in full, replies are kept concise,
                    and large files/search results are trimmed to what's relevant. Recent
                    messages and conversation context are preserved.
                  </div>
                </div>
                <Toggle
                  checked={draftPrefs.tokenOptimization}
                  onChange={(next) => setDraftPrefs((p) => ({ ...p, tokenOptimization: next }))}
                />
              </div>

              <div className="mt-5 rounded-xl border border-border-subtle bg-canvas p-4">
                <div className="text-sm font-medium">Tools</div>
                <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                  Actions the assistant may take on its own during a reply. Off by default: these
                  let it fetch pages and run code, which is worth opting into deliberately. Skill
                  files are always readable while a skill is active. Only models that support tool
                  calling can use these.
                </div>
                <div className="mt-3 space-y-2">
                  {(
                    [
                      ["browser", "Browse the web", "Open pages, search, follow links and read them. Pages are fetched as text, so this works on any site."],
                      ["code", "Run code", "Execute snippets in the language runtimes you installed, sandboxed in a worker with no file system. Python can reach CORS-enabled sites over the network; other languages cannot."],
                      ["plugin", "Plugin tools", "Tools contributed by plugins you installed."],
                    ] as [string, string, string][]
                  ).map(([group, label, blurb]) => {
                    const groupTools = allTools().filter((t) => t.group === group);
                    if (groupTools.length === 0) return null;
                    const ids = groupTools.map((t) => t.id);
                    const on = ids.every((id) => draftPrefs.enabledTools.includes(id));
                    return (
                      <div
                        key={group}
                        className="flex items-start justify-between gap-4 rounded-lg border border-border-subtle bg-bg-elevated p-3"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium">{label}</div>
                          <div className="mt-0.5 text-[11px] leading-4 text-fg-faint">{blurb}</div>
                          <div className="mt-1 text-[11px] text-fg-faint">
                            {groupTools.map((t) => t.id).join(", ")}
                          </div>
                        </div>
                        <Toggle
                          checked={on}
                          onChange={(next) =>
                            setDraftPrefs((p) => ({
                              ...p,
                              enabledTools: next
                                ? [...new Set([...p.enabledTools, ...ids])]
                                : p.enabledTools.filter((id) => !ids.includes(id)),
                            }))
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-border-subtle bg-canvas p-4">
                <div className="text-sm font-medium">Your data</div>
                <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                  {APP_NAME} keeps everything in this browser and nothing on a server, so clearing site
                  data or switching browser loses it. Export a copy of your chats, skills, memories
                  and tasks. Provider API keys are never included in a backup.
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runExport()}
                    disabled={backupBusy !== null}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-60"
                  >
                    {backupBusy === "export" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    Export backup
                  </button>
                  <button
                    type="button"
                    onClick={() => backupInputRef.current?.click()}
                    disabled={backupBusy !== null}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-60"
                  >
                    {backupBusy === "import" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    Import backup
                  </button>
                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".zip,.json,application/zip,application/json"
                    onChange={runImport}
                    className="hidden"
                  />
                </div>
                {backupMessage && (
                  <p className={`mt-2 text-xs ${backupMessage.tone === "error" ? "text-error" : "text-success"}`}>
                    {backupMessage.text}
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-5 text-fg-faint">
                  Importing merges into what you already have; nothing is overwritten.
                </p>
              </div>
            </div>
          )}

          {tab === "providers" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDraftMode(opt.value)}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                      draftMode === opt.value
                        ? "border-accent bg-accent/10"
                        : "border-border bg-canvas hover:bg-bg-hover"
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="mt-0.5 text-xs leading-5 text-fg-dim">{opt.description}</div>
                  </button>
                ))}
              </div>

              {draftMode === "omniroute" && (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium" htmlFor="omniroute-base-url">
                      OmniRoute base URL
                    </label>
                    <Input
                      id="omniroute-base-url"
                      value={draftOmniRoute.baseUrl}
                      onChange={(e) => setDraftOmniRoute((s) => ({ ...s, baseUrl: e.target.value }))}
                      placeholder={DEFAULT_OMNIROUTE_URL}
                      spellCheck={false}
                    />
                    <p className="mt-1.5 text-xs text-fg-faint">
                      Requests are relayed through this app's local server to reach OmniRoute, so the
                      default works as-is from any device on the network — no need to change it just
                      because you're not on localhost. Only change this if OmniRoute itself runs
                      somewhere other than this server's own machine.
                    </p>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium" htmlFor="omniroute-api-key">
                      API key (optional)
                    </label>
                    <Input
                      id="omniroute-api-key"
                      type="password"
                      value={draftOmniRoute.apiKey}
                      onChange={(e) => setDraftOmniRoute((s) => ({ ...s, apiKey: e.target.value }))}
                      placeholder="Leave blank for keyless local access"
                      spellCheck={false}
                    />
                    <p className="mt-1.5 text-xs text-fg-faint">
                      Sent as <code className="text-fg-dim">Authorization: Bearer …</code>
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                      Available on this gateway
                      {omniRouteModels.status === "testing" && (
                        <Loader2 size={13} className="animate-spin text-fg-faint" />
                      )}
                    </div>
                    {omniRouteModels.status === "idle" && (
                      <p className="text-xs text-fg-faint">Enter a base URL above to fetch its live model list.</p>
                    )}
                    {omniRouteModels.status === "fail" && (
                      <p className="text-xs text-error">
                        Couldn't reach /v1/models — check the base URL/key. ({omniRouteModels.message})
                      </p>
                    )}
                    {omniRouteModels.status === "ok" && omniRouteModelGroups.length === 0 && (
                      <p className="text-xs text-fg-faint">No models reported by this gateway.</p>
                    )}
                    {omniRouteModels.status === "ok" && omniRouteModelGroups.length > 0 && (
                      <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-border-subtle bg-canvas p-2">
                        {omniRouteModelGroups.map(([alias, models]) => (
                          <details key={alias} className="text-xs">
                            <summary className="cursor-pointer select-none py-0.5 font-medium text-fg-dim">
                              {alias} <span className="font-normal text-fg-faint">({models.length})</span>
                            </summary>
                            <ul className="mt-0.5 space-y-0.5 pl-3 text-fg-faint">
                              {models.map((id) => (
                                <li key={id} className="truncate">
                                  {id}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void runOmniRouteTest()}
                        disabled={omniRouteTest.status === "testing"}
                        className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2 text-sm hover:bg-bg-hover disabled:opacity-50"
                      >
                        {omniRouteTest.status === "testing" ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <RefreshCw size={15} />
                        )}
                        Test connection
                      </button>
                    </div>
                    {omniRouteTest.status === "ok" && (
                      <div className="space-y-0.5">
                        <span className="flex items-center gap-1 text-sm text-success">
                          <Check size={15} /> Connected
                        </span>
                        <div className="text-xs leading-5 text-fg-dim">
                          Replied “{omniRouteTest.result.reply || "(empty)"}” via {omniRouteTest.result.model}
                          {omniRouteTest.result.provider && ` (${omniRouteTest.result.provider})`} ·{" "}
                          {omniRouteTest.result.latencyMs} ms
                        </div>
                      </div>
                    )}
                    {omniRouteTest.status === "fail" && (
                      <div className="text-sm text-error">Failed: {omniRouteTest.message}</div>
                    )}
                  </div>
                </>
              )}

              {draftMode === "direct" && (
                <>
              <div>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    Model providers
                    {draftProviders.length > 0 && (
                      <span className="ml-1.5 text-xs font-normal text-fg-faint">
                        ({draftProviders.filter((c) => c.enabled).length}/{draftProviders.length})
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPresetPickerOpen((v) => !v)}
                    className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs font-medium hover:bg-bg-hover"
                  >
                    <Plus size={13} /> Add provider
                  </button>
                </div>
                <p className="mb-3 text-xs leading-5 text-fg-faint">
                  Every provider below is free. Most need no API key at all; a few need a free
                  account key and stay disabled until that key is added and Test passes. Pick one
                  to add it; its model list syncs from the provider's own catalog. Requests go
                  straight from your browser to the provider, with no server in between, so rate
                  limits count against you alone rather than being shared with everyone else using
                  {APP_NAME}. Local models go further and never leave this device. Models route as{" "}
                  <code className="text-fg-dim">alias/modelId</code>. Need a different keyed
                  provider entirely? Use "Custom / OpenAI-compatible" below.
                </p>

                {presetPickerOpen && (
                  <div className="mb-3 rounded-xl border border-border-subtle bg-canvas p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search
                          size={13}
                          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint"
                        />
                        <input
                          autoFocus
                          value={presetSearch}
                          onChange={(e) => setPresetSearch(e.target.value)}
                          placeholder="Search providers…"
                          className="w-full rounded-lg border border-border bg-bg-elevated py-1.5 pl-8 pr-2 text-xs outline-none focus:border-accent"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setPresetPickerOpen(false)}
                        className="shrink-0 rounded p-0.5 text-fg-faint hover:text-fg"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className="max-h-64 space-y-3 overflow-y-auto">
                      {(
                        [
                          ["local", "Runs on this device"],
                          ["inference", "Hosted, no key needed"],
                          ["inference-keyed", "Hosted, needs a free account"],
                        ] as [PresetCategory, string][]
                      ).map(([category, heading]) => {
                        const presets = PROVIDER_PRESETS.filter(
                          (p) =>
                            p.category === category &&
                            p.label.toLowerCase().includes(presetSearch.trim().toLowerCase())
                        );
                        if (presets.length === 0) return null;
                        return (
                          <div key={category}>
                            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
                              {heading}
                            </div>
                            <div className="space-y-1.5">
                              {presets.map((preset) => (
                                <button
                                  key={preset.id}
                                  type="button"
                                  onClick={() => handlePresetClick(preset)}
                                  className="flex w-full flex-col gap-0.5 rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-left hover:border-accent hover:bg-bg-hover"
                                >
                                  <span className="flex items-center justify-between gap-1.5">
                                    <span className="truncate text-xs font-medium">{preset.label}</span>
                                    <span className="flex shrink-0 items-center gap-1">
                                      {preset.local && (
                                        <span className="rounded-full bg-teal/15 px-1.5 py-0.5 text-[10px] font-normal text-teal">
                                          Offline
                                        </span>
                                      )}
                                      {preset.hasFree && (
                                        <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-normal text-success">
                                          Free
                                        </span>
                                      )}
                                    </span>
                                  </span>
                                  {preset.requirement && (
                                    <span className="text-[11px] leading-4 text-fg-faint">
                                      {preset.requirement}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={addCustomConnection}
                        className="w-full rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-xs font-medium text-fg-dim hover:border-accent hover:text-fg"
                      >
                        Custom / OpenAI-compatible
                      </button>
                    </div>
                  </div>
                )}

                {draftProviders.length === 0 && (
                  <p className="rounded-xl border border-dashed border-border-subtle bg-canvas p-4 text-center text-xs text-fg-faint">
                    No providers yet. Add one to start chatting.
                  </p>
                )}

                <div className="space-y-3">
                  {draftProviders.map((connection) => (
                    <ProviderConnectionCard
                      key={connection.id}
                      connection={connection}
                      testState={testByConnectionId[connection.id] ?? IDLE_STATE}
                      discoveryState={discoveryByConnectionId[connection.id] ?? IDLE_STATE}
                      autoDiscoveredRef={autoDiscoveredRef}
                      onUpdate={updateConnection}
                      onRemove={removeConnection}
                      onTest={runConnectionTest}
                      onDiscover={runDiscovery}
                    />
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-canvas p-4">
                <div className="text-sm font-medium">Web search</div>
                <div className="mt-0.5 mb-3 text-xs leading-5 text-fg-dim">
                  Backend used for the composer's search toggle.
                </div>
                <Select
                  value={draftSearch.provider}
                  onChange={(e) =>
                    setDraftSearch((s) => ({ ...s, provider: e.target.value as SearchBackend }))
                  }
                >
                  {SEARCH_BACKENDS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </Select>
                {SEARCH_BACKENDS.find((b) => b.value === draftSearch.provider)?.needsKey && (
                  <Input
                    type="password"
                    value={draftSearch.apiKey ?? ""}
                    onChange={(e) => setDraftSearch((s) => ({ ...s, apiKey: e.target.value }))}
                    placeholder="API key"
                    spellCheck={false}
                    className="mt-2"
                  />
                )}
              </div>
                </>
              )}
            </>
          )}

          {tab === "proxies" && (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  Custom proxy servers
                  {draftProxies.length > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-fg-faint">
                      ({draftProxies.filter((p) => p.enabled).length}/{draftProxies.length})
                    </span>
                  )}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFreeProxyFinderOpen(true)}
                    className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs font-medium hover:bg-bg-hover"
                  >
                    <Sparkles size={13} /> Get Free available proxies
                  </button>
                  <Tooltip label="Export your proxies">
                    <button
                      type="button"
                      onClick={() => { setProxyExportSelection(null); setProxyIoMode("export"); }}
                      aria-label="Export proxies"
                      disabled={draftProxies.length === 0}
                      className="flex items-center rounded-lg border border-border bg-canvas p-1.5 hover:bg-bg-hover disabled:opacity-40"
                    >
                      <Download size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Import proxies">
                    <button
                      type="button"
                      onClick={() => setProxyIoMode("import")}
                      aria-label="Import proxies"
                      className="flex items-center rounded-lg border border-border bg-canvas p-1.5 hover:bg-bg-hover disabled:opacity-40"
                    >
                      <Upload size={13} />
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={addProxy}
                    className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs font-medium hover:bg-bg-hover"
                  >
                    <Plus size={13} /> Add proxy
                  </button>
                </div>
              </div>
              {proxyIoMessage && (
                <p className={`mb-2 text-xs ${proxyIoMessage.tone === "error" ? "text-error" : "text-success"}`}>
                  {proxyIoMessage.text}
                </p>
              )}
              <p className="mb-3 text-xs leading-5 text-fg-faint">
                Your own forward proxy, configured by you. Chat requests use the routing mode below.
                Connection failures can try another proxy. In Auto model mode, provider limits and
                authentication errors move to another available provider instead. Cooling routes are
                skipped, and each response shows the proxy actually used.
              </p>

              {draftMode !== "direct" && (
                <p className="mb-3 rounded-xl border border-border-subtle bg-canvas p-3 text-xs leading-5 text-fg-dim">
                  These only apply in Browser-Hosted OmniRoute (direct) mode — you're currently on
                  OmniRoute Gateway mode, which routes and connects entirely through your own
                  gateway instead. Configuration here is kept, but unused until you switch modes in
                  the Providers tab.
                </p>
              )}

              {legacyProxies > 0 && (
                <div className="mb-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
                  <p>
                    {legacyProxies} older {legacyProxies === 1 ? "proxy was" : "proxies were"} removed.
                    They were CORS-forwarding URLs, which real proxy support cannot use - a proxy is
                    now a host and a port.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="ghost" onClick={downloadLegacyProxies}>
                      Download the old list
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        dismissLegacyProxyNotice();
                        setLegacyProxies(0);
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}

              <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
                <div>
                  <div className="text-sm font-medium">Allow unverified connections for all proxies</div>
                  <p className="mt-1 text-xs leading-5 text-fg-dim">
                    Applies to every proxy, including new proxies and individual connection tests. When off,
                    each proxy uses its individual setting.
                  </p>
                  <p className="mt-1 text-xs leading-5 text-warning">
                    Proxy operators could read your API keys and messages. Enable only if you trust all proxies you use.
                  </p>
                </div>
                <Toggle
                  label="Allow unverified connections for all proxies"
                  checked={draftAllowInsecureProxyTls}
                  onChange={(next) => {
                    setDraftAllowInsecureProxyTls(next);
                    proxyTestGeneration.current++;
                    setTestByProxyId({});
                  }}
                />
              </div>

              <div className="mb-4 grid grid-cols-3 gap-2">
                {PROXY_MODE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = draftProxyMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setDraftProxyMode(opt.value);
                        if (opt.value === "manual" && draftManualProxyIds.length === 0 && draftProxies[0]) {
                          setDraftManualProxyIds([draftProxies[0].id]);
                        }
                      }}
                      className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                        active ? "border-accent bg-accent/10" : "border-border bg-canvas hover:bg-bg-hover"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon size={14} className={active ? "text-accent" : "text-fg-faint"} />
                        {opt.label}
                      </div>
                      <div className="mt-0.5 text-xs leading-5 text-fg-dim">{opt.description}</div>
                    </button>
                  );
                })}
              </div>

              {draftProxyMode === "manual" && draftProxies.length > 0 && draftManualProxyIds.length === 0 && (
                <p className="mb-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
                  Open a proxy below and turn on Use in manual selection. Selected proxies are tried in list order.
                </p>
              )}

              {draftProxies.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border-subtle bg-canvas p-4 text-center text-xs text-fg-faint">
                  No proxies configured — requests go straight to each provider, as they do by default.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-fg-faint">Select a label to edit, test or manage that proxy.</p>
                  <DndContext sensors={proxySensors} onDragEnd={handleProxyDragEnd}>
                    <SortableContext
                      items={draftProxies.map((p) => p.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
                        {draftProxies.map((proxy) => (
                          <CustomProxyRow
                            key={proxy.id}
                            proxy={proxy}
                            mode={draftProxyMode}
                            onOpen={setSelectedProxyId}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </>
              )}
            </div>
          )}

          {tab === "personalization" && (
            <>
              <div>
                <label className="mb-1.5 block text-sm font-medium" htmlFor="custom-instructions">
                  Custom instructions
                </label>
                <Textarea
                  id="custom-instructions"
                  value={draftPrefs.customInstructions}
                  onChange={(e) =>
                    setDraftPrefs((p) => ({ ...p, customInstructions: e.target.value }))
                  }
                  rows={4}
                  placeholder="e.g. Always address me as 'boss', write replies in a friendly tone…"
                />
                <p className="mt-1.5 text-xs text-fg-faint">
                  Information you’d like {APP_NAME} to always keep in mind across all chats.
                </p>
              </div>
            </>
          )}

          {tab === "memory" && (
            <>
              <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-canvas p-4">
                <div>
                  <div className="text-sm font-medium">Memory</div>
                  <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                    Let {APP_NAME} remember what it learns about you to personalize your experience
                    based on your chats and files.
                  </div>
                </div>
                <Toggle
                  checked={draftPrefs.memoryEnabled}
                  onChange={(next) => setDraftPrefs((p) => ({ ...p, memoryEnabled: next }))}
                />
              </div>

              {draftPrefs.memoryEnabled && (
                <>
                  <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-canvas p-4">
                    <div>
                      <div className="text-sm font-medium">Auto-learn from chats</div>
                      <div className="mt-0.5 text-xs leading-5 text-fg-dim">
                        After each reply, {APP_NAME} may extract durable facts about you in the
                        background and save them as memories.
                      </div>
                    </div>
                    <Toggle
                      checked={draftPrefs.autoMemory}
                      onChange={(next) => setDraftPrefs((p) => ({ ...p, autoMemory: next }))}
                    />
                  </div>

                  {draftPrefs.pendingMemories.length > 0 && (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-sm font-medium">
                          Pending review · {draftPrefs.pendingMemories.length}
                        </span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={acceptAllPending}
                            className="text-xs text-fg-faint hover:text-fg"
                          >
                            Accept all
                          </button>
                          <button
                            type="button"
                            onClick={rejectAllPending}
                            className="text-xs text-fg-faint hover:text-error"
                          >
                            Reject all
                          </button>
                        </div>
                      </div>
                      <div className="rounded-xl border border-border-subtle bg-canvas p-3">
                        <ul className="space-y-2">
                          {draftPrefs.pendingMemories.map((m: MemoryItem) => (
                            <li
                              key={m.id}
                              className="flex items-start justify-between gap-3 text-sm leading-6"
                            >
                              <span className="min-w-0 flex-1 text-fg-dim">{m.text}</span>
                              <div className="flex shrink-0 items-center gap-1">
                                <Tooltip label="Accept">
                                  <button
                                    type="button"
                                    onClick={() => acceptPending(m.id)}
                                    className="rounded p-1 text-fg-faint hover:text-success"
                                  >
                                    <Check size={13} />
                                  </button>
                                </Tooltip>
                                <Tooltip label="Reject">
                                  <button
                                    type="button"
                                    onClick={() => rejectPending(m.id)}
                                    className="rounded p-1 text-fg-faint hover:text-error"
                                  >
                                    <X size={13} />
                                  </button>
                                </Tooltip>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium">Memory summary</span>
                      <span className="text-xs text-fg-faint">
                        {draftPrefs.memories.length} item{draftPrefs.memories.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <SearchInput
                      icon={<Search size={14} />}
                      value={memoryFilter}
                      onChange={(e) => setMemoryFilter(e.target.value)}
                      placeholder="Search memories…"
                      className="mb-2"
                    />
                    <div className="rounded-xl border border-border-subtle bg-canvas p-3">
                      {draftPrefs.memories.length === 0 ? (
                        <p className="py-3 text-center text-xs text-fg-faint">
                          Nothing learned yet. Memories will appear here.
                        </p>
                      ) : filteredMemories.length === 0 ? (
                        <p className="py-3 text-center text-xs text-fg-faint">
                          No memories match &ldquo;{memoryFilter}&rdquo;.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {filteredMemories.map((m: MemoryItem) => (
                            <li
                              key={m.id}
                              className="group flex items-start justify-between gap-3 text-sm leading-6"
                            >
                              {editingMemoryId === m.id ? (
                                <input
                                  autoFocus
                                  value={editingMemoryText}
                                  onChange={(e) => setEditingMemoryText(e.target.value)}
                                  onBlur={() => updateMemoryText(m.id, editingMemoryText)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") updateMemoryText(m.id, editingMemoryText);
                                    if (e.key === "Escape") setEditingMemoryId(null);
                                  }}
                                  className="min-w-0 flex-1 rounded border border-accent bg-canvas px-1 -mx-1 text-sm text-fg-dim outline-none"
                                />
                              ) : (
                                <span
                                  onClick={() => {
                                    setEditingMemoryId(m.id);
                                    setEditingMemoryText(m.text);
                                  }}
                                  className="min-w-0 flex-1 cursor-text rounded px-1 -mx-1 text-fg-dim hover:bg-bg-hover"
                                >
                                  {m.text}
                                </span>
                              )}
                              <Tooltip label="Forget this">
                                <button
                                  type="button"
                                  onClick={() => removeMemory(m.id)}
                                  className="shrink-0 rounded p-1 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-error"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </Tooltip>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium" htmlFor="add-memory">
                      Add a memory
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="add-memory"
                        value={newMemory}
                        onChange={(e) => setNewMemory(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addMemory();
                        }}
                        placeholder="e.g. The user prefers concise, bullet-point answers"
                        className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <button
                        type="button"
                        onClick={addMemory}
                        disabled={!newMemory.trim()}
                        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  {draftPrefs.memories.length > 0 && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setDraftPrefs((p) => ({ ...p, memories: [] }))}
                        className="text-xs text-fg-faint hover:text-error"
                      >
                        Clear all memories
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 font-mono text-sm uppercase tracking-[0.06em] text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-accent px-4 py-2 font-mono text-sm font-medium uppercase tracking-[0.06em] text-on-accent transition-colors hover:bg-accent-hover"
          >
            Save
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      open={!!duplicatePreset}
      onClose={() => setDuplicatePreset(null)}
      onConfirm={() => {
        if (duplicatePreset) addConnectionFromPreset(duplicatePreset);
      }}
      title="Provider already added"
      message={`You already have a "${duplicatePreset?.label}" connection. Add another one with a different alias and API key?`}
      confirmLabel="Add another"
      tone="default"
    />

    {selectedProxy && <Dialog open onClose={closeProxyDetails} title="Proxy details" size="xl">
      <div className="space-y-4">
        <p className="text-xs text-fg-faint">Edit this proxy, then save Settings to keep your changes.</p>
        <label className="block text-xs text-fg-dim">Label
          <Input className="mt-1" value={selectedProxy.label} onChange={e => updateProxy(selectedProxy.id, { label: e.target.value })} placeholder="e.g. Office proxy" />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-xs text-fg-dim">Protocol
            <Select className="mt-1" value={selectedProxy.protocol} onChange={e => updateProxy(selectedProxy.id, { protocol: e.target.value as ProxyProtocol, ...(e.target.value === "socks4" ? { password: undefined } : {}) })}>
              {PROXY_PROTOCOLS.map(p => <option key={p} value={p}>{PROXY_PROTOCOL_LABELS[p]}</option>)}
            </Select>
          </label>
          <label className="text-xs text-fg-dim">IP address or hostname
            <Input className="mt-1" value={selectedProxy.host} spellCheck={false} onChange={e => updateProxy(selectedProxy.id, { host: e.target.value.trim() })} placeholder="198.51.100.7" />
          </label>
          <label className="text-xs text-fg-dim">Port
            <Input className="mt-1" value={selectedProxy.port || ""} inputMode="numeric" onChange={e => updateProxy(selectedProxy.id, { port: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })} placeholder="1080" />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs text-fg-dim">Username
            <Input className="mt-1" value={selectedProxy.username ?? ""} autoComplete="off" spellCheck={false} onChange={e => updateProxy(selectedProxy.id, { username: e.target.value })} placeholder="Optional" />
          </label>
          <label className="text-xs text-fg-dim">Password
            <Input className="mt-1" type="password" autoComplete="new-password" value={selectedProxy.password ?? ""} disabled={!proxySupportsPassword(selectedProxy.protocol)} onChange={e => updateProxy(selectedProxy.id, { password: e.target.value })} placeholder={proxySupportsPassword(selectedProxy.protocol) ? "Optional" : "Not supported by SOCKS4"} />
          </label>
        </div>
        {selectedProxy.protocol === "socks4" && <p className="text-xs text-fg-faint">SOCKS4 supports a user ID, but no password. Use SOCKS5 for password authentication.</p>}
        <div className="flex flex-wrap gap-5 rounded-lg border border-border-subtle p-3">
          {draftProxyMode !== "manual" && <label className="flex items-center gap-2 text-sm"><Toggle label="Enable proxy" checked={selectedProxy.enabled} onChange={enabled => updateProxy(selectedProxy.id, { enabled })} />Enabled</label>}
          {draftProxyMode === "manual" && <label className="flex items-center gap-2 text-sm"><Toggle label="Include in manual selection" checked={draftManualProxyIds.includes(selectedProxy.id)} onChange={() => toggleManualProxy(selectedProxy.id)} />Use in manual selection</label>}
        </div>
        {!draftAllowInsecureProxyTls && <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <label className="flex items-center gap-2 text-sm"><Toggle label="Allow unverified connections for this proxy" checked={selectedProxy.allowInsecureTls ?? false} onChange={allowInsecureTls => updateProxy(selectedProxy.id, { allowInsecureTls })} />Allow unverified connections</label>
          <p className="mt-2 text-xs leading-5 text-warning">If enabled, this proxy's operator could potentially read your API keys and messages. Only enable this for a proxy you trust.</p>
        </div>}
        <div className="rounded-lg border border-border-subtle bg-canvas p-3" aria-live="polite">
          {(() => {
            const test = testByProxyId[selectedProxy.id] ?? IDLE_STATE;
            return <>
              <Button size="sm" loading={test.status === "testing"} disabled={!selectedProxy.host || !isValidPort(selectedProxy.port)} onClick={() => void runProxyTest(selectedProxy)} icon={<RefreshCw size={14} />}>Test proxy</Button>
              <p className={`mt-2 break-words text-xs ${test.status === "fail" ? "text-error" : test.status === "ok" ? "text-success" : "text-fg-faint"}`}>
                {test.status === "ok" ? `Reachable. Exit IP: ${test.result.exitIp ?? "unknown"}. ${test.result.latencyMs} ms.` : test.status === "fail" ? `Failed: ${test.message}` : test.status === "testing" ? "Testing connection..." : "Test this proxy's connection."}
              </p>
            </>;
          })()}
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t border-border-subtle pt-4">
          <Button variant="ghost" className="text-error" onClick={() => removeProxy(selectedProxy.id)} icon={<Trash2 size={14} />}>Remove proxy</Button>
          <div className="flex gap-2"><Button onClick={() => { setProxyExportSelection([selectedProxy]); setSelectedProxyId(null); setProxyIoMode("export"); }}>Export</Button><Button variant="primary" onClick={() => setSelectedProxyId(null)}>Done</Button></div>
        </div>
      </div>
    </Dialog>}
    {proxyIoMode && <ProxyListDialog mode={proxyIoMode} proxies={proxyIoMode === "export" ? proxyExportSelection ?? draftProxies : draftProxies} onClose={() => setProxyIoMode(null)} onImport={incoming => {
      setDraftProxies(list => [...list, ...incoming]);
      setProxyIoMessage({ tone: "ok", text: `${incoming.length} proxies imported. Save Settings to keep them.` });
    }} />}
    <FreeProxyFinderModal
      open={freeProxyFinderOpen}
      onClose={() => setFreeProxyFinderOpen(false)}
      draftProxies={draftProxies}
      onAddProxies={handleAddFreeProxies}
    />
    </>
  );
}
