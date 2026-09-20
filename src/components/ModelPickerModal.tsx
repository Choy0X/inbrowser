import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Cpu, Eye, Film, Search, Settings, Wrench, X } from "lucide-react";
import type { OmniModel } from "../lib/types";
import type { CapabilityIndex, ModelCapabilities } from "../lib/capabilities";
import { modelCapabilities, providerLabel } from "../lib/capabilities";
import { EmptyState } from "./ui";

function fmtCtx(n?: number): string | null {
  if (!n) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function Badge({ icon: Icon, label }: { icon: typeof Eye; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-canvas px-1.5 py-0.5 text-[11px] text-fg-dim">
      <Icon size={11} />
      {label}
    </span>
  );
}

/** Debounces a fast-changing value (search input) so filtering a huge model list doesn't run on every keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

type Row = { type: "header"; key: string; label: string } | { type: "model"; key: string; model: OmniModel };

const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 30;

interface ModelPickerModalProps {
  open: boolean;
  onClose: () => void;
  models: OmniModel[];
  index: CapabilityIndex;
  current: string;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
}

export function ModelPickerModal({
  open,
  onClose,
  models,
  index,
  current,
  onSelect,
  onOpenSettings,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 120);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Capability classification (a regex scan per model) is computed lazily —
  // once per model, the first time it's actually rendered — and cached here
  // for the component's lifetime. Computing it eagerly for every model up
  // front is what froze the dialog with large catalogs (thousands of ids).
  const capsCache = useRef<Map<string, ModelCapabilities>>(new Map());
  useEffect(() => {
    capsCache.current = new Map();
  }, [models, index]);
  const capsFor = (model: OmniModel): ModelCapabilities => {
    let caps = capsCache.current.get(model.id);
    if (!caps) {
      caps = modelCapabilities(model.id, index);
      capsCache.current.set(model.id, caps);
    }
    return caps;
  };

  const rows = useMemo<Row[]>(() => {
    const filtered = debouncedQuery.trim()
      ? models.filter((m) => m.id.toLowerCase().includes(debouncedQuery.trim().toLowerCase()))
      : models;

    const map = new Map<string, OmniModel[]>();
    for (const model of filtered) {
      const slash = model.id.indexOf("/");
      const prefix = slash === -1 ? "" : model.id.slice(0, slash);
      const arr = map.get(prefix) ?? [];
      if (arr.length === 0) map.set(prefix, arr);
      arr.push(model);
    }
    const pinned = (map.get("") ?? []).filter((m) => m.id === "auto" || m.id.startsWith("auto/"));
    const rest = [...map.entries()]
      .filter(([prefix]) => prefix !== "")
      .sort(([a], [b]) => providerLabel(a, index).localeCompare(providerLabel(b, index)));

    const out: Row[] = [];
    if (pinned.length > 0) {
      out.push({ type: "header", key: "header:auto", label: "Auto" });
      for (const model of pinned) out.push({ type: "model", key: model.id, model });
    }
    for (const [prefix, list] of rest) {
      out.push({ type: "header", key: `header:${prefix}`, label: providerLabel(prefix, index) });
      for (const model of list) out.push({ type: "model", key: model.id, model });
    }
    return out;
  }, [models, debouncedQuery, index]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    // Measured heights are cached by index unless keyed, so without this a row's
    // size leaks onto whatever model lands at that index after a search change.
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 12,
  });

  // Re-measure only when the row *keys* actually reshape (e.g. a new search
  // result set) — the virtualizer otherwise keeps stale offsets from the
  // previous `rows`. But `measure()` unconditionally clears the whole
  // cached-height map, and `measureElement`'s refs only repopulate it when a
  // DOM node actually (re)mounts, so calling it on a render where the keys
  // didn't change (starting with mount, where the refs just measured real
  // heights synchronously during commit) pins every already-mounted row back
  // to the estimate with no resize event left to correct it.
  const rowKeysRef = useRef<string | null>(null);
  useEffect(() => {
    const keys = rows.map((r) => r.key).join("\u0000");
    if (rowKeysRef.current !== null && rowKeysRef.current !== keys) {
      virtualizer.measure();
    }
    rowKeysRef.current = keys;
  }, [rows, virtualizer]);

  if (!open) return null;

  const renderRow = (model: OmniModel) => {
    const caps = capsFor(model);
    const shortName = model.id.includes("/") ? model.id.split("/").pop()! : model.id;
    const ctx = fmtCtx(caps.contextLength);
    // Match even when one side has a provider prefix and the other does not.
    const isSelected = current === model.id || model.id.endsWith(`/${current}`) || current.endsWith(`/${model.id}`);
    return (
      <button
        type="button"
        onClick={() => {
          onSelect(model.id);
          onClose();
        }}
        className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          isSelected ? "bg-accent/15" : "hover:bg-bg-hover"
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isSelected && <Check size={14} className="shrink-0 text-accent" />}
            <span className="truncate text-sm font-medium">{shortName}</span>
            {caps.label && <span className="truncate text-xs text-fg-faint">{caps.label}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1 pl-5">
            {ctx && <Badge icon={Cpu} label={`${ctx} context`} />}
            {caps.vision && <Badge icon={Eye} label="Vision" />}
            {caps.video && <Badge icon={Film} label="Video" />}
            {caps.reasoning && <Badge icon={Wrench} label="Reasoning" />}
            {caps.toolCalling && <Badge icon={Check} label="Tools" />}
          </div>
        </div>
        <span className="shrink-0 text-xs text-fg-faint">{model.id}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-2 sm:p-4">
      <div className="fixed inset-0 bg-overlay/60" onClick={onClose} />
      <div className="relative z-10 mt-16 mb-16 w-full max-w-2xl rounded-2xl border border-border bg-bg-elevated shadow-lift">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-medium">Select model</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border bg-canvas p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
            <Search size={16} className="text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-fg-faint"
              autoFocus
            />
          </div>
        </div>

        <div ref={scrollRef} className="max-h-[55vh] overflow-y-auto px-3 pb-3">
          {rows.length === 0 ? (
            <EmptyState
              title={
                models.length === 0
                  ? "No models available yet — add a provider in Connection settings."
                  : `No models match "${query}".`
              }
            />
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={row.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.type === "header" ? (
                      <div className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-fg-faint">
                        {row.label}
                      </div>
                    ) : (
                      <div className="pb-0.5">{renderRow(row.model)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <Settings size={15} />
            Connection settings
          </button>
          <span className="text-xs text-fg-faint">
            {models.length.toLocaleString()} model{models.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}
