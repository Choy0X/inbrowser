import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import type { CustomProxy } from "../lib/types";
import { PROXY_PROTOCOLS } from "../lib/types";
import { proxyKey } from "../lib/gateway/freeProxyList";
import { CatalogRequestError, catalogProxyToCustom, getCatalogPage, recommendCatalogProxies, resolveCatalogProxies,
  type CatalogPage, type CatalogProxy, type CatalogSort } from "../lib/gateway/freeProxyCatalog";
import { Dialog } from "./Dialog";
import { Button, Input, Select } from "./ui";

export function FreeProxyFinderModal({ open, onClose, draftProxies, onAddProxies }: {
  open: boolean;
  onClose: () => void;
  draftProxies: CustomProxy[];
  onAddProxies: (proxies: CustomProxy[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [protocol, setProtocol] = useState("");
  const [country, setCountry] = useState("");
  const [sort, setSort] = useState<CatalogSort>("score");
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [selected, setSelected] = useState<Map<string, CatalogProxy>>(new Map());
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const action = useRef<AbortController>();
  const existing = useMemo(() => new Set(draftProxies.map(proxyKey)), [draftProxies]);
  const filters = useMemo(() => ({ q, protocol, country }), [q, protocol, country]);
  const availableSelection = [...selected.values()].filter(proxy => !existing.has(proxyKey(proxy)));

  useEffect(() => {
    const timer = setTimeout(() => { setQ(query); setCursor(undefined); setHistory([]); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!open) { action.current?.abort(); setBusy(false); setCursor(undefined); setHistory([]); return; }
    setSelected(new Map()); setMessage(""); setCursor(undefined); setHistory([]);
    return () => action.current?.abort();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(null);
    getCatalogPage(filters, sort, cursor, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(err => {
      if (controller.signal.aborted) return;
      if (cursor && err instanceof CatalogRequestError && err.status === 400) {
        setCursor(undefined); setHistory([]);
        setMessage("This page expired. Showing the first page again.");
      } else setError(err instanceof Error ? err.message : "Could not load the catalog.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, filters, sort, cursor, refresh]);
  // A result requested under older filters must not change the new selection.
  useEffect(() => { action.current?.abort(); setBusy(false); }, [filters, sort]);

  const resetPage = () => { setCursor(undefined); setHistory([]); };
  const toggle = (proxy: CatalogProxy) => setSelected(previous => {
    const next = new Map(previous);
    if (next.has(proxy.id)) next.delete(proxy.id);
    else if (next.size < 100) next.set(proxy.id, proxy);
    return next;
  });
  const smartSelect = async () => {
    action.current?.abort();
    const controller = new AbortController(); action.current = controller;
    setBusy(true); setError(""); setMessage("");
    try {
      const excludeIds = draftProxies.flatMap(proxy => proxy.catalog ? [proxy.catalog.id] : []);
      const result = await recommendCatalogProxies(filters, count, excludeIds, controller.signal);
      if (controller.signal.aborted) return;
      const choices = result.items.filter(proxy => !existing.has(proxyKey(proxy)));
      setSelected(new Map(choices.map(proxy => [proxy.id, proxy])));
      setMessage(`${choices.length} proxies selected. Review them before adding.`);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not select proxies.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const addSelected = async () => {
    action.current?.abort();
    const controller = new AbortController(); action.current = controller;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await resolveCatalogProxies(availableSelection.map(proxy => proxy.id), controller.signal);
      if (controller.signal.aborted) return;
      const additions = result.items.filter(proxy => !existing.has(proxyKey(proxy))).map(catalogProxyToCustom);
      onAddProxies(additions); setSelected(new Map());
      setMessage(`${additions.length} proxies added to your draft. Save Settings to keep them.${result.unavailableIds.length ? ` ${result.unavailableIds.length} selected proxies are no longer available.` : ""}`);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not add proxies.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const checkedAt = (at: number | null) => at ? new Date(at).toLocaleString() : "Not checked yet";

  return <Dialog open={open} onClose={onClose} title="Free available proxies" size="xl" footer={
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-fg-dim" aria-live="polite">{availableSelection.length} selected (up to 100)</span>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setSelected(new Map())} disabled={busy || !selected.size}>Clear</Button>
        <Button onClick={onClose}>Done</Button>
        <Button variant="primary" disabled={busy || !availableSelection.length} loading={busy} onClick={() => void addSelected()}>Add selected</Button>
      </div>
    </div>
  }>
    <div className="space-y-4 max-sm:[&_button]:min-h-11">
      <p className="text-sm text-fg-dim">Browse recently checked proxies. Availability can change. Added proxies stay in your draft until you save Settings.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="col-span-2 text-xs text-fg-dim">Search
          <Input className="mt-1" value={query} onChange={event => setQuery(event.target.value)} placeholder="IP, host, port, or country" />
        </label>
        <label className="text-xs text-fg-dim">Protocol
          <Select className="mt-1" value={protocol} onChange={event => { setProtocol(event.target.value); resetPage(); }}>
            <option value="">All protocols</option>{PROXY_PROTOCOLS.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
          </Select>
        </label>
        <label className="text-xs text-fg-dim">Country code
          <Input className="mt-1" value={country} maxLength={2} placeholder="Any" onChange={event => { setCountry(event.target.value.toUpperCase()); resetPage(); }} />
        </label>
        <label className="text-xs text-fg-dim">Sort by
          <Select className="mt-1" value={sort} onChange={event => { setSort(event.target.value as CatalogSort); resetPage(); }}>
            <option value="score">Recommended</option><option value="latency">Lowest latency</option><option value="freshness">Recently checked</option>
          </Select>
        </label>
        <label className="text-xs text-fg-dim">Smart selection count
          <Input className="mt-1" type="number" min={1} max={100} value={count} onChange={event => setCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} />
        </label>
        <div className="col-span-2 flex flex-wrap items-end gap-2">
          <Button disabled={busy || loading} onClick={() => void smartSelect()} icon={<Sparkles size={14} />}>Smart selection</Button>
          <Button disabled={loading} onClick={() => { resetPage(); setRefresh(value => value + 1); }} icon={<RefreshCw size={14} />}>Refresh</Button>
        </div>
      </div>
      <div className="space-y-1 text-xs text-fg-dim" aria-live="polite">
        {page && <><p>{page.total} available. Last completed check: {checkedAt(page.status.lastCompletedAt)}.</p><p>{page.status.running ? "Catalog update in progress." : `Next update: ${checkedAt(page.status.nextRunAt)}.`}</p>{page.status.lastError && <p className="text-warning">The last update failed. Previously checked results are shown.</p>}</>}
        {loading && <p role="status">Loading proxies...</p>}
        {error && <p role="alert" className="text-error">{error}</p>}
        {message && <p role="status">{message}</p>}
      </div>
      {availableSelection.length > 0 && <details className="rounded-lg border border-border-subtle p-3">
        <summary className="cursor-pointer text-sm">Review {availableSelection.length} selected proxies</summary>
        <ul className="mt-2 max-h-48 overflow-y-auto divide-y divide-border-subtle">
          {availableSelection.map(proxy => <li key={proxy.id} className="flex items-center justify-between gap-2 py-2 text-xs">
            <span className="min-w-0 break-all">{proxy.protocol.toUpperCase()} {proxy.host}:{proxy.port} / {proxy.latencyMs} ms</span>
            <Button size="sm" disabled={busy} aria-label={`Deselect ${proxy.host}:${proxy.port}`} onClick={() => toggle(proxy)}>Remove</Button>
          </li>)}
        </ul>
      </details>}
      {!loading && page?.items.length === 0 && <p className="rounded-lg border border-border-subtle p-5 text-sm text-fg-dim">{page.status.lastCompletedAt ? "No proxies match these filters. Try another search or protocol." : "The catalog is being prepared. Refresh after the first check completes."}</p>}
      {!!page?.items.length && <>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-fg-dim">Page {history.length + 1}</span>
          <Button size="sm" disabled={busy} onClick={() => setSelected(previous => {
            const next = new Map(previous);
            for (const proxy of page.items) if (next.size < 100 && !existing.has(proxyKey(proxy))) next.set(proxy.id, proxy);
            return next;
          })}>Select page</Button>
        </div>
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {page.items.map(proxy => {
            const added = existing.has(proxyKey(proxy));
            return <li key={proxy.id}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 p-3 hover:bg-bg-hover">
                <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={added || selected.has(proxy.id)} disabled={added || busy || (selected.size >= 100 && !selected.has(proxy.id))} onChange={() => toggle(proxy)} aria-label={`Select ${proxy.protocol} ${proxy.host}:${proxy.port}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"><span className="break-all font-mono">{proxy.host}:{proxy.port}</span><span className="text-xs text-fg-dim">{added ? "Already added" : `${proxy.latencyMs} ms`}</span></span>
                  <span className="mt-1 block text-xs text-fg-dim">{proxy.protocol.toUpperCase()} / {proxy.country || "Unknown country"} / {proxy.checks ? Math.round(proxy.successes / proxy.checks * 100) : 0}% successful</span>
                  <span className="mt-1 block break-words text-xs text-fg-faint">Checked {checkedAt(proxy.lastCheckedAt)}{proxy.exitIp ? ` / Exit IP ${proxy.exitIp}` : ""}</span>
                </span>
              </label>
              <details className="mr-3 mb-2 ml-10 min-w-0 text-xs text-fg-dim">
                <summary tabIndex={0} aria-label={`Sources for ${proxy.host}:${proxy.port}`} className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">Sources ({proxy.sources.length})</summary>
                {proxy.sources.length ? <ul className="max-h-32 space-y-1 overflow-y-auto overscroll-contain pb-2">
                  {proxy.sources.map((source, index) => <li key={index} className="break-words [overflow-wrap:anywhere]">{source}</li>)}
                </ul> : <p className="pb-2">Source information is unavailable.</p>}
              </details>
            </li>;
          })}
        </ul>
        <div className="flex justify-between gap-2">
          <Button disabled={loading || history.length === 0} onClick={() => { setCursor(history[history.length - 1]); setHistory(previous => previous.slice(0, -1)); }}>Previous</Button>
          <Button disabled={loading || !page.nextCursor} onClick={() => { setHistory(previous => [...previous, cursor]); setCursor(page.nextCursor ?? undefined); }}>Next</Button>
        </div>
      </>}
    </div>
  </Dialog>;
}
