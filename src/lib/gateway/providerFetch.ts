import type { CustomProxy } from "../types";
import { STREAM_IDLE_TIMEOUT_MS } from "../appConfig";
import { providerPresetForUrl } from "./providerPresets";
import { GatewayError } from "./types";

/**
 * The one place this app touches the network for a provider.
 *
 * The default path is direct: the request leaves the user's own browser and hits
 * the provider, with no hop of ours in between. That is deliberate, and it is
 * not only about hosting. The free providers this app ships rate-limit *per IP*.
 * Routing traffic through any shared hop - our own relay, a public CORS proxy, a
 * serverless function - would put every user behind a single IP, so a handful of
 * requests would exhaust the quota and block everyone at once. Going direct
 * makes every rate limit per-client: one user hitting a limit cannot affect
 * anybody else.
 *
 * Direct providers must send CORS headers. Presets without CORS explicitly
 * require a configured proxy; providerFetch reports that requirement before
 * attempting a direct request. `scripts/verify-providers.ts` checks both paths.
 *
 * ---
 *
 * The optional `proxy` argument is the one exception, and it does not weaken any
 * of the above - it is the same argument pointing the other way. A proxy is
 * opt-in, configured by one user, and the address the provider sees is that
 * user's own proxy. Far from putting everyone behind one IP, it moves that user
 * off the shared pool entirely.
 *
 * It cannot be done in the browser, though: a page cannot speak HTTP CONNECT or
 * SOCKS. So when a proxy is given the request goes to the relay instead, which
 * is the same origin that served this page -
 *
 *   browser -> the app's own server (`server/`) -> Cloudflare Worker -> proxy -> provider
 *
 * - and the relay mirrors the provider's status and headers back, so the
 * Response returned here is a real one and `iterateSSEEvents` below works on it
 * unchanged. The Worker exists so the address the proxy operator sees is
 * Cloudflare's anycast edge and never the relay's: a user can point the app at a
 * proxy they control, and would otherwise learn the relay's address just by
 * reading their own logs. The Worker cannot read the traffic (the dial is sealed
 * and the tunnel carries the relay's TLS session with the provider); the VPS
 * relay can, since it terminates that TLS, and PrivacyPolicyContent.tsx says so
 * plainly rather than implying end-to-end secrecy.
 *
 * The proxied path is a dynamic import, so with no proxy configured none of it
 * is loaded and behaviour here is exactly what it always was.
 */
export async function providerFetch(
  targetUrl: string,
  init?: RequestInit,
  proxy?: CustomProxy,
  /**
   * Relay override. Only the Settings "Test" button passes this, so an unsaved
   * draft relay URL can be tried before it is committed; everything else omits
   * it and `getRelayUrl()` resolves the saved setting or the app default.
   */
  relayUrl?: string,
  /** Unsaved global TLS preference for Settings tests; otherwise use the saved choice. */
  allowInsecureProxyTls?: boolean
): Promise<Response> {
  const preset = providerPresetForUrl(targetUrl);
  if (preset?.requiresProxy && !proxy) {
    throw new GatewayError(400, `${preset.label} requires a configured proxy. Select one in Settings > Proxies.`, false, undefined, "proxy_required");
  }
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (proxy) {
    const [{ relayFetch }, { getRelayUrl }] = await Promise.all([
      import("./proxy/relayFetch"),
      import("./proxy/relay"),
    ]);
    return relayFetch(targetUrl, { ...init, headers }, proxy, getRelayUrl(relayUrl), allowInsecureProxyTls);
  }
  return fetch(targetUrl, { ...init, headers });
}

/*
 * A dropped connection (wifi lost, laptop sleeps) doesn't reject `reader.read()` -
 * it just never resolves, since nothing tells the browser the socket is dead. That
 * left the chat stuck on "Thinking…" forever with no error and no way to recover
 * short of reloading. Racing every read against STREAM_IDLE_TIMEOUT_MS (config.json,
 * `client.streamIdleTimeoutMs`) turns a silent hang into a normal stream error,
 * which the existing catch/finally in `runAssistant` already turns into a
 * retryable error bubble.
 */

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("Connection lost - no response from the model. Check your internet connection and try again."));
    }, STREAM_IDLE_TIMEOUT_MS);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Splits a response body into raw SSE event blocks (text between blank lines). */
export async function* iterateSSEEvents(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  /**
   * True when the previous read ended on a CR that has already been turned
   * into a newline. If the next read opens with the LF that completed that
   * CRLF, it has to be dropped or the pair becomes two line breaks - which
   * would look like an event separator and split an event in half.
   */
  let carriedCr = false;
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) break;
      let text = decoder.decode(value, { stream: true });
      if (text) {
        // SSE permits CR, LF or CRLF as a line break, and providers do use
        // all three - proxy/hordeSSE.ts exists because at least one sends
        // CRLF. Searching for a blank line below without normalising first means a
        // CRLF-framed stream never matches a separator at all, so the whole
        // response buffers to EOF and then arrives as one unparseable block.
        if (carriedCr && text.startsWith("\n")) text = text.slice(1);
        carriedCr = text.endsWith("\r");
        buffer += text.replace(/\r\n?/g, "\n");
      }
      for (;;) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const raw = buffer.slice(0, sep).replace(/\r/g, "");
        buffer = buffer.slice(sep + 2);
        yield raw;
      }
    }
    // Flush any incomplete multi-byte sequence the decoder is still holding,
    // rather than dropping it silently at EOF.
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.replace(/\r/g, "");
  } finally {
    reader.releaseLock();
  }
}

export interface ParsedSSEEvent {
  event?: string;
  data: string;
}

/** Extracts the `event:`/`data:` lines from one raw SSE block (data lines joined by \n). */
export function parseSSEBlock(raw: string): ParsedSSEEvent {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join("\n") };
}
