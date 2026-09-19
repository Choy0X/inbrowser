/**
 * Forwarding one request through the tunnel to the provider.
 *
 * This is the part the architecture exists to make boring. Because the tunnel is
 * a Duplex, Node's own TLS and HTTP implementations do the work:
 *
 *     tunnel (Duplex over WebSocket)
 *       -> tls.connect({ socket: tunnel })      inner TLS, to the provider
 *       -> http.request({ createConnection })   HTTP/1.1 over that
 *
 * Note it is `http.request`, not `https.request`, even for an https:// target:
 * the socket handed to `createConnection` already speaks TLS, so asking the
 * https module to negotiate again would start a second handshake inside the
 * first. `http` over an already-encrypted socket is exactly right.
 *
 * Nothing here parses a status line, decodes a chunked body, or handles
 * trailers. That was the single biggest saving of terminating TLS in Node
 * rather than at the edge, and it is why there is no hand-written HTTP parser
 * anywhere in this project.
 */
import http from "node:http";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { RelayMeta } from "./envelope.ts";

export interface ForwardResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: NodeJS.ReadableStream;
  /**
   * Whether this response leaves the connection reusable. False whenever the
   * upstream said otherwise or framed the body by EOF - in which case "the
   * response ended" and "the socket ended" are the same event and there is
   * nothing left to reuse.
   */
  reusable: boolean;
}

const TLS_ERROR_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ENOTFOUND",
]);

/**
 * Buckets a forwarding failure into a fixed, non-identifying category, for
 * diagnostic logging. Deliberately reads only `err.code` - a short Node
 * symbolic string (e.g. `ECONNREFUSED`) - and never `err.message`: a TLS
 * hostname-mismatch error's message embeds the actual target hostname in
 * plain text (e.g. "Hostname/IP does not match certificate's altnames..."),
 * which the code alone never does.
 */
export function categorizeForwardError(
  err: unknown
): { category: "timeout" | "connect" | "tls" | "other"; code?: string } {
  if (err instanceof Error && err.message === "The provider did not respond in time.") {
    return { category: "timeout" };
  }
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined;
  if (code === "ETIMEDOUT") return { category: "timeout", code };
  if (code && (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_"))) return { category: "tls", code };
  if (code && CONNECT_ERROR_CODES.has(code)) return { category: "connect", code };
  return { category: "other", code };
}

/** Fixed, non-identifying `code`/`error` pair for the client, keyed by category. */
export const FORWARD_ERROR_CODES = {
  timeout: "provider_timeout",
  connect: "provider_unreachable",
  tls: "provider_tls_unverified",
  other: "provider_request_failed",
} as const;

export const FORWARD_ERROR_MESSAGES: Record<keyof typeof FORWARD_ERROR_CODES, string> = {
  timeout: "The provider did not respond in time.",
  connect: "Could not reach the provider.",
  tls: "The connection to the provider could not be verified as secure. This proxy may be intercepting traffic.",
  other: "The request to the provider failed.",
};

/** Hop-by-hop headers, which describe one connection and must not be relayed. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ForwardOptions {
  meta: RelayMeta;
  tunnel: Duplex;
  body: NodeJS.ReadableStream | null;
  timeoutMs?: number;
  /**
   * Per-request opt-in from the browser's individual or all-proxies setting
   * (see `envelope.ts`'s `RelayProxy`) - never a
   * default, never process-wide. See `wrapTls()` below for how this is guarded.
   */
  allowInsecureTls?: boolean;
  /**
   * A socket that already speaks TLS to this exact target, with the agent
   * holding it. Present only on the pooled path; without it this opens its own,
   * which is the unpooled behaviour and the default.
   */
  reuse?: { socket: Duplex; agent: http.Agent };
}

export async function forward(options: ForwardOptions): Promise<ForwardResult> {
  const { meta, tunnel, body, timeoutMs = 120_000, allowInsecureTls, reuse } = options;
  const url = new URL(meta.target);
  const isTls = url.protocol === "https:";
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;

  // A reused connection brings its own already-negotiated socket. Wrapping it
  // again would start a second TLS session inside the first.
  const socket: Duplex = reuse
    ? reuse.socket
    : isTls
      ? await wrapTls(tunnel, url.hostname, allowInsecureTls)
      : tunnel;

  const requestOptions: http.RequestOptions = {
    method: meta.method,
    // `path` must carry the query string; `url.pathname` alone silently
    // drops it, which for Gemini's `?alt=sse` means a non-streaming reply.
    path: `${url.pathname}${url.search}`,
    host: url.hostname,
    port,
    headers: {
      ...meta.headers,
      Host: url.host,
      // We stream the response straight through, so asking for identity
      // removes any question of who decompresses it. Costs bandwidth,
      // removes a class of bug.
      "Accept-Encoding": "identity",
      // Only asked for when there is a pool to put it back into. The unpooled
      // path still closes, which is what makes one tunnel serving one request
      // the default rather than something to remember.
      Connection: reuse ? "keep-alive" : "close",
    },
    timeout: timeoutMs,
  };

  // Exactly one of these, assigned rather than spread.
  //
  // Do NOT set agent:false in either case. Node then creates a default Agent
  // and ignores createConnection, bypassing the tunnel (and sending plaintext
  // to 443 for HTTPS targets).
  //
  // The unpooled branch is written to be the same thing this function did
  // before pooling existed, because a streaming regression was bisected to the
  // commit that introduced pooling and this was one of the few lines on the
  // live path it touched. Keeping the two cases visibly separate means the
  // no-pool path cannot be changed by accident while editing the pooled one.
  if (reuse) {
    requestOptions.agent = reuse.agent;
  } else {
    (requestOptions as { createConnection?: () => never }).createConnection = () => socket as never;
  }

  return new Promise<ForwardResult>((resolve, reject) => {
    const request = http.request(requestOptions, (response) => {
      resolve({
        status: response.statusCode ?? 502,
        headers: response.headers,
        body: response,
        // Only asked when there is somewhere to put the connection back.
        reusable: reuse ? isReusable(response) : false,
      });
    });

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("The provider did not respond in time."));
    });

    if (body) body.pipe(request);
    else request.end();
  });
}

/**
 * Strict certificate verification is the default and stays the default - this
 * literal is asserted by verify-relay.ts as the guard against a silent global
 * regression. The only way `rejectUnauthorized` ever becomes `false` is the
 * ternary in `wrapTls()` below, keyed on one request's own `allowInsecureTls`,
 * sourced from the browser's explicit individual or all-proxies opt-in
 * (never a default, never process-wide). Do not replace the ternary with an
 * unconditional `false`.
 */
const DEFAULT_REJECT_UNAUTHORIZED = true;

export function wrapTls(tunnel: Duplex, servername: string, allowInsecureTls?: boolean): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        socket: tunnel,
        servername,
        // The provider is a real internet host with a real certificate. There is
        // no reason to relax this and every reason not to: a hostile proxy is
        // exactly the party a certificate check defends against, and it is on
        // the path. See DEFAULT_REJECT_UNAUTHORIZED above for why this is only
        // ever relaxed through a request's explicit opt-in, never unconditionally.
        rejectUnauthorized: allowInsecureTls ? false : DEFAULT_REJECT_UNAUTHORIZED,
        ALPNProtocols: ["http/1.1"],
      },
      () => resolve(socket)
    );
    socket.once("error", reject);
  });
}

/**
 * Whether the upstream left this connection in a reusable state.
 *
 * Three ways it has not. It said `Connection: close`. It is HTTP/1.0 and did
 * not opt in. Or it framed the body by closing the connection - no
 * Content-Length and no chunked encoding - in which case the end of the
 * response IS the end of the socket.
 */
function isReusable(response: http.IncomingMessage): boolean {
  const connection = String(response.headers.connection ?? "").toLowerCase();
  if (connection.includes("close")) return false;
  if (response.httpVersion === "1.0" && !connection.includes("keep-alive")) return false;
  const framed =
    response.headers["content-length"] !== undefined ||
    String(response.headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked");
  return framed;
}

/** Response headers safe to mirror back to the browser. */
export function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // Length and framing are re-established by our own response.
    if (lower === "content-length") continue;
    if (lower === "set-cookie" || lower === "set-cookie2") continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
