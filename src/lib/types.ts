export interface OmniModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ProviderPluginModel {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  supportsVideo?: boolean;
  /** Excluded from "auto" routing and the chat model picker when false. Undefined = enabled. */
  enabled?: boolean;
  /**
   * True when this specific model is known to work with no API key at all,
   * independent of whether the connection itself has one configured — some
   * providers (e.g. OpenCode Zen) mix genuinely-anonymous free-tier models
   * with key-required ones under a single endpoint/connection. "auto" uses
   * this to avoid picking a model doomed to fail with an auth error when the
   * connection has no key; manual selection is never restricted by it.
   */
  freeAccess?: boolean;
}

/**
 * Provider/model catalog shape served by a real OmniRoute gateway's
 * `/api/v1/provider-plugin-manifest` endpoint (OmniRoute connection mode
 * only — see ConnectionMode in src/lib/onniroute.ts).
 */
export interface ProviderPluginManifestEntry {
  id: string;
  alias?: string;
  format?: string;
  executor?: string;
  defaultContextLength?: number;
  models: ProviderPluginModel[];
}

export interface ProviderPluginManifest {
  schemaVersion?: number;
  providers: ProviderPluginManifestEntry[];
}

/**
 * Wire format a provider connection speaks. "local" is not a wire format at
 * all - it marks a model that runs inside this browser (see
 * gateway/adapters/local.ts), addressed by a `local://<runtime>` base URL.
 */
export type ProviderFormat = "openai" | "anthropic" | "gemini" | "local";

/**
 * A user-configured connection to an LLM provider (or any OpenAI-compatible
 * endpoint). Routed as `${alias}/${modelId}`. Held entirely client-side
 * (localStorage) and sent with each request — the app has no server-side
 * credential storage. See src/lib/onniroute.ts.
 */
export interface ProviderConnection {
  id: string;
  /** Routing prefix, e.g. "oa" routes as "oa/gpt-4o". Must be unique. */
  alias: string;
  label?: string;
  format: ProviderFormat;
  baseUrl: string;
  apiKey: string;
  models: ProviderPluginModel[];
  /** When true, the client fetches this provider's own model list on demand. */
  autoDiscover?: boolean;
  enabled: boolean;
}

/**
 * A user-owned forward proxy: a real TCP endpoint speaking a proxy protocol,
 * dialled on the user's behalf by the relay (see gateway/proxy/relayFetch.ts,
 * `server/`, and the Cloudflare Worker it tunnels through). A browser cannot
 * speak CONNECT or SOCKS itself, so
 * this is the one path in the app that is not a direct browser->provider fetch.
 *
 * Global pool, not tied to any one connection - see gateway/proxyRouting.ts.
 * Held client-side like a ProviderConnection; `password` is the one secret and
 * is never included in backup exports.
 *
 * Replaced an earlier `urlTemplate` shape (a public CORS-forwarding URL). The
 * two are not convertible - see migrateProxies() in lib/gatewaySettings.ts.
 */
export interface CustomProxy {
  id: string;
  label: string;
  protocol: ProxyProtocol;
  /** Hostname or literal IP of the proxy itself. Never a URL. */
  host: string;
  port: number;
  username?: string;
  /** Omitted from full backups; explicit proxy list exports include it. SOCKS4 has no password field. */
  password?: string;
  enabled: boolean;
  /** Where this entry came from when imported from a public list. Display only. */
  source?: string;
  /** Egress IP observed by the last successful Test. Display only. */
  exitIp?: string;
  /** Catalog observations seed routing until this browser records real outcomes. */
  catalog?: {
    id: string;
    score: number;
    latencyMs: number;
    successes: number;
    checks: number;
    lastCheckedAt: number;
    lastSuccessAt: number;
    country?: string;
  };
  /** Individual opt-in, off by default. The separate saved global preference
   *  can allow all proxies without rewriting this field. When true, this
   *  proxy's TLS session to the real provider is
   *  not certificate-verified: its operator could potentially read API keys
   *  and message content in transit. */
  allowInsecureTls?: boolean;
}

/**
 * Proxy wire protocols the relay can speak.
 *  - "http":   plaintext hop to the proxy, HTTP CONNECT to open the tunnel.
 *  - "https":  same CONNECT bytes, but the hop to the proxy is itself TLS, so
 *              credentials are not sent in the clear. The relay's Worker does
 *              this outer TLS and the VPS does the inner one - neither runtime
 *              is ever asked for TLS-in-TLS.
 *  - "socks5": binary handshake, optional username/password sub-negotiation.
 *  - "socks4": legacy, SOCKS4 and 4a. Has a userid field but no password.
 */
export type ProxyProtocol = "http" | "https" | "socks5" | "socks4";

export const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5", "socks4"];

/** Proxy protocols that carry no password field on the wire. */
export function proxySupportsPassword(protocol: ProxyProtocol): boolean {
  return protocol !== "socks4";
}

export type ProxyRoutingMode = "auto" | "manual" | "order";

/**
 * Search backends that a browser can actually reach. Brave, SerpAPI, Tavily,
 * Exa and public SearXNG instances send no CORS headers, so they were removed
 * when the app dropped its relay - see gateway/search/duckduckgo.ts.
 */
export type SearchBackend = "duckduckgo" | "serper" | "jina";

export interface SearchSettings {
  provider: SearchBackend;
  apiKey?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
  /** Optional full/extracted page text as returned by the search provider. */
  content?: string;
  position?: number;
  publishedAt?: string | null;
  faviconUrl?: string | null;
  citation?: { provider: string; retrievedAt: string; rank: number };
}

/** Web search payload attached to a user message so sources render with it. */
export interface MessageSearch {
  query: string;
  provider: string;
  results: SearchResult[];
  error?: string;
}

export type AttachmentKind = "image" | "text" | "document" | "audio";

/** A function/tool call requested by the model during streaming. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string (parsed by the caller). */
  arguments: string;
}

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  /** Extracted text for text/document files (PDF, Word, etc.) */
  text?: string;
  /** Base64 data URL for images (and scanned PDF pages) */
  dataUrl?: string;
  /** Rasterized page images for scanned PDFs */
  pages?: string[];
  /** Embedded images extracted from Word documents */
  images?: string[];
  /** Whisper transcript for audio */
  transcript?: string;
  error?: string;
}

/**
 * Media produced by generation endpoints (image generation / image edits / video
 * generation). Rendered directly in the chat bubble rather than fed back into the
 * LLM text stream.
 */
export interface GeneratedMedia {
  kind: "image" | "video";
  /** Source of the media: a base64 data URL or a remote URL returned by the gateway. */
  url: string;
  prompt: string;
  model?: string;
}

export type ArtifactType = "code" | "markdown" | "html" | "svg" | "document";
export type ArtifactFormat = "docx" | "pdf" | "both";
export type ArtifactStatus = "streaming" | "complete" | "truncated";

/**
 * A generated file artifact parsed from a <fachoy-artifact> marker in an
 * assistant message's streamed content (see src/lib/artifacts.ts). Rendered
 * as a compact card in the message, opening a side panel for preview/edit/download.
 */
export interface GeneratedArtifact {
  id: string;
  type: ArtifactType;
  /** Monaco/syntax-highlighter language id (type: "code" only). */
  language?: string;
  /** Which binary export(s) to offer (type: "document" only). */
  format?: ArtifactFormat;
  /** Display name and suggested download filename, e.g. "fibonacci.py". */
  title: string;
  /** Raw streamed/model-authored content (markdown source, for "document"). */
  content: string;
  /** User-edited override — authoritative over `content` for preview/download when set. */
  editedContent?: string;
  status: ArtifactStatus;
}

/** Historical response attribution. Deliberately excludes proxy credentials. */
export type ResponseProxy = Pick<CustomProxy, "id" | "label" | "protocol" | "host" | "port">;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  /** Generated images/videos produced by this message. */
  media?: GeneratedMedia[];
  /** Generated file artifacts (code/markdown/html/svg/document) produced by this message. */
  files?: GeneratedArtifact[];
  /**
   * User edits to the inline fenced code blocks in `content`, keyed by
   * inlineCodeKey() (see lib/inlineCodeFile.ts). Deliberately not stored as
   * entries in `files`: anything there is also rendered as an artifact card
   * under the message, so an edited snippet would appear twice.
   */
  codeEdits?: Record<string, string>;
  error?: string;
  /** model id that was requested */
  model?: string;
  /** fully-qualified "alias/modelId" the auto-router actually picked for this turn */
  resolvedModel?: string;
  /** label/alias of the provider connection actually used for this turn */
  provider?: string;
  /** Snapshot of the proxy that produced this response; null means direct. */
  proxy?: ResponseProxy | null;
  /** Web search sources fetched for this message (when web search was on). */
  search?: MessageSearch;
  /** Function/tool calls the assistant requested on this turn (tool loop). */
  toolCalls?: ToolCall[];
  /** For role:"tool" messages: the id of the tool call this is a response to. */
  toolCallId?: string;
  /** Name of the tool invoked for role:"tool" messages. */
  toolName?: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: ChatMessage[];
  /** Temporary chats are not persisted to history and are discarded on switch. */
  temporary?: boolean;
  /** Per-chat web search toggle; saved with the conversation. */
  searchEnabled?: boolean;
  /**
   * Token optimization: rolling summary of "old tier" messages that have
   * scrolled beyond the middle-tier retrieval window. Undefined until the
   * optimizer has run for this conversation.
   */
  oldTierSummary?: string;
  /**
   * Index into `messages` up to (and including) which content has been
   * folded into `oldTierSummary`. Everything after this index is eligible
   * for middle-tier retrieval or is in the recent verbatim window.
   */
  oldTierSummarizedThrough?: number;
  /** Legacy fence-promotion marker retained for stored conversation compatibility. */
  fencesMigrated?: boolean;
}
