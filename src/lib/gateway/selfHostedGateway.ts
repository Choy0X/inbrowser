/**
 * Self-hosted gateway connection mode: talks to a real, externally-running
 * server implementing the OmniRoute protocol (baseUrl/apiKey configured in
 * Settings), the way InBrowser worked before the browser-native Direct
 * Connection system was built. The gateway may live at any address the user
 * hosts it on. Requests go straight from the browser
 * (gateway/providerFetch.ts), so a hosted instance must send CORS headers
 * for this app's origin to be usable.
 *
 * Its /v1/images/* and /v1/audio/transcriptions are themselves
 * OpenAI-compatible, so image/audio generation here just wraps the gateway
 * as a synthetic "openai" format ProviderConnection and reuses
 * gateway/media/openai.ts rather than re-implementing it.
 */
import type { OmniModel, ProviderConnection, ProviderPluginManifest, SearchResult } from "../types";
import type { ChatMessageInput, ToolCallWire, ToolDef } from "./types";
import { GatewayError } from "./types";
import { providerFetch } from "./providerFetch";
import { assertSSEResponse, consumeOpenAIStream, extractCompletionText } from "./openaiChunks";
import { extractError, stripLeakedSpecialTokens } from "./util";
import * as openaiMedia from "./media/openai";

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey: string, json = true): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Wraps baseUrl/apiKey as a ProviderConnection so gateway/media/openai.ts can be reused as-is. */
function asConnection(baseUrl: string, apiKey: string): ProviderConnection {
  return {
    id: "gateway",
    alias: "",
    label: "Self-Hosted Gateway",
    format: "openai",
    baseUrl: `${baseUrl.trim().replace(/\/+$/, "")}/v1`,
    apiKey,
    models: [],
    enabled: true,
  };
}

// ------------------------------------------------------------------- chat

export interface GatewayChatArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageInput[];
  tools?: ToolDef[];
  toolChoice?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: ToolCallWire[]) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface GatewayChatResult {
  /** Resolved model reported via X-OmniRoute-Model — may be a bare id, reconcile against the model list. */
  resolvedModel: string | null;
  resolvedProvider: string | null;
  toolCalls: ToolCallWire[];
}

/** Extracts the routed provider name from the X-OmniRoute-Decision header. */
function decisionProvider(header: string | null): string | null {
  if (!header) return null;
  const parts: Record<string, string> = {};
  for (const segment of header.split(";")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }
  if (parts.provider) return parts.provider;
  const match = header.match(/^([^(]+)\s*\(([^)]+)\)/);
  if (match) return match[2].trim();
  return header;
}

export async function chatStream(args: GatewayChatArgs): Promise<GatewayChatResult> {
  const body: Record<string, unknown> = { model: args.model, messages: args.messages, stream: true };
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    if (args.toolChoice) body.tool_choice = args.toolChoice;
  }
  if (args.maxTokens) body.max_tokens = args.maxTokens;
  const res = await providerFetch(endpoint(args.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: authHeaders(args.apiKey),
    body: JSON.stringify(body),
    signal: args.signal,
  });
  const decisionHeader = res.headers.get("X-OmniRoute-Decision");
  const modelHeader = res.headers.get("X-OmniRoute-Model");
  await assertSSEResponse(res);
  const toolCalls = await consumeOpenAIStream(res, args);
  return { resolvedModel: modelHeader, resolvedProvider: decisionProvider(decisionHeader), toolCalls };
}

export interface GatewayCompletionArgs {
  baseUrl: string;
  apiKey: string;
  model?: string;
  messages: ChatMessageInput[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function runCompletion(args: GatewayCompletionArgs): Promise<string> {
  const res = await providerFetch(endpoint(args.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: authHeaders(args.apiKey),
    body: JSON.stringify({
      model: args.model ?? "auto",
      messages: args.messages,
      stream: false,
      max_tokens: args.maxTokens ?? 256,
    }),
    signal: args.signal,
  });
  return extractCompletionText(res);
}

export interface GatewayTestResult {
  reply: string;
  model: string;
  provider: string;
  latencyMs: number;
}

/** Connection test that exercises a real (non-streaming) chat completion, mirroring the pre-rework implementation. */
export async function testConnection(baseUrl: string, apiKey: string): Promise<GatewayTestResult> {
  const started = performance.now();
  const res = await providerFetch(endpoint(baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Say OK." }],
      stream: false,
      max_tokens: 64,
    }),
  });
  const latencyMs = Math.round(performance.now() - started);
  const raw = await res.text().catch(() => "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  const err = extractError(parsed);
  if (!res.ok || !parsed || err) {
    throw new GatewayError(res.status, err || (raw ? raw.slice(0, 200) : `HTTP ${res.status}`));
  }
  const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
  const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== "string") {
    throw new GatewayError(res.status, err || "Unexpected response from gateway");
  }
  const decision = res.headers.get("X-OmniRoute-Decision") || "";
  return {
    reply: stripLeakedSpecialTokens(content).trim(),
    model: (parsed.model as string | undefined) || res.headers.get("x-omniroute-model") || "auto",
    provider: decision.match(/provider=([^;\s]+)/)?.[1] || "",
    latencyMs,
  };
}

// ---------------------------------------------------------------- models

export async function listModels(baseUrl: string, apiKey: string): Promise<OmniModel[]> {
  const res = await providerFetch(endpoint(baseUrl, "/v1/models?prefix=alias"), { headers: authHeaders(apiKey, false) });
  if (!res.ok) throw new GatewayError(res.status, `HTTP ${res.status}`);
  const data = (await res.json()) as { object: string; data: OmniModel[] };
  return data.data || [];
}

/** Best-effort provider/model capability manifest. Returns null when unavailable (reachable keyless). */
export async function fetchManifest(baseUrl: string): Promise<ProviderPluginManifest | null> {
  try {
    const res = await providerFetch(endpoint(baseUrl, "/api/v1/provider-plugin-manifest"));
    if (!res.ok) return null;
    return (await res.json()) as ProviderPluginManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- search

interface RawSearchResult {
  title: string;
  url: string;
  display_url?: string;
  snippet?: string;
  position?: number;
  published_at?: string | null;
  favicon_url?: string | null;
  content?: string | null;
  citation?: { provider: string; retrieved_at: string; rank: number };
}

interface RawSearchResponse {
  id: string;
  provider: string;
  query: string;
  results?: RawSearchResult[];
}

export interface GatewaySearchResult {
  query: string;
  provider: string;
  results: SearchResult[];
}

export async function webSearch(
  baseUrl: string,
  apiKey: string,
  query: string,
  signal?: AbortSignal
): Promise<GatewaySearchResult> {
  const res = await providerFetch(endpoint(baseUrl, "/v1/search"), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ query }),
    signal,
  });
  if (!res.ok) throw new GatewayError(res.status, `HTTP ${res.status}`);
  const data = (await res.json()) as RawSearchResponse;
  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    displayUrl: r.display_url,
    snippet: r.snippet,
    content: r.content ?? undefined,
    position: r.position,
    publishedAt: r.published_at,
    faviconUrl: r.favicon_url,
    citation: r.citation
      ? { provider: r.citation.provider, retrievedAt: r.citation.retrieved_at, rank: r.citation.rank }
      : undefined,
  }));
  return { query: data.query || query, provider: data.provider || "", results };
}

// -------------------------------------------------------------- generation

export async function generateImages(
  baseUrl: string,
  apiKey: string,
  options: { prompt: string; model?: string; size?: string; n?: number; signal?: AbortSignal }
): Promise<string[]> {
  return openaiMedia.generateImages(asConnection(baseUrl, apiKey), options.model ?? "auto", options);
}

export async function editImages(
  baseUrl: string,
  apiKey: string,
  options: { prompt: string; image: string | File; model?: string; signal?: AbortSignal }
): Promise<string[]> {
  return openaiMedia.editImage(asConnection(baseUrl, apiKey), options.model ?? "auto", options);
}

export async function transcribeAudioFile(baseUrl: string, apiKey: string, file: Blob, name: string): Promise<string> {
  return openaiMedia.transcribeAudio(asConnection(baseUrl, apiKey), "whisper-1", file, name);
}

interface RawMediaItem {
  b64_json?: string;
  url?: string;
}

function tokenDataUrl(token: unknown, mime: string): string | null {
  if (typeof token !== "string" || !token) return null;
  return `data:${mime};base64,${token}`;
}

/**
 * Video generation responses vary across the providers a gateway speaking
 * this protocol might route to: some return a `video` field, some `output`/`data` containing a
 * url, some return an `id` to poll. Tolerantly handle the common shapes and
 * surface a useful message when a job id must be polled separately (no
 * generic polling support here, unlike gateway/media/gemini.ts's Veo path).
 */
export async function generateVideo(
  baseUrl: string,
  apiKey: string,
  options: { prompt: string; model?: string; signal?: AbortSignal }
): Promise<string[]> {
  const res = await providerFetch(endpoint(baseUrl, "/v1/videos/generations"), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model: options.model ?? "auto", prompt: options.prompt }),
    signal: options.signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const items = Array.isArray(data.data) ? (data.data as unknown[]) : [];
  const candidates: (string | RawMediaItem & { video?: string; content_url?: string })[] = [];
  if (typeof data.video === "string") candidates.push(data.video);
  if (typeof data.output === "string") candidates.push(data.output);
  for (const item of items) {
    if (typeof item === "string") candidates.push(item);
    else if (item && typeof item === "object") candidates.push(item as never);
  }
  const urls: string[] = [];
  for (const c of candidates) {
    let url: string | null = null;
    if (typeof c === "string") {
      url = /^https?:/.test(c) || c.startsWith("data:") ? c : tokenDataUrl(c, "video/mp4");
    } else {
      url =
        (typeof c.url === "string" && c.url ? c.url : null) ||
        (typeof c.video === "string" && c.video ? c.video : null) ||
        (typeof c.content_url === "string" && c.content_url ? c.content_url : null) ||
        (typeof c.b64_json === "string" ? tokenDataUrl(c.b64_json, "video/mp4") : null);
    }
    if (url) urls.push(url);
  }
  if (urls.length === 0) {
    if (typeof data.id === "string") {
      throw new GatewayError(
        202,
        `Video generation queued (job ${data.id}). Some providers require polling for the finished file.`
      );
    }
    throw new GatewayError(200, extractError(data) || "Video generation returned no video");
  }
  return urls;
}
