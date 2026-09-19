/**
 * The VPS relay <-> Cloudflare Worker wire protocol.
 *
 * THIS FILE IS A TWIN. An identical copy lives at `server/src/protocol.ts`, and
 * `npm run verify:relay` asserts the two are byte-for-byte identical. Edit one,
 * copy it to the other, in the same commit. Silent drift here produces a relay
 * that closes every connection with an unhelpful code, which is close to the
 * least debuggable failure this system can have.
 *
 * It is deliberately runtime-agnostic: no `node:` imports, no Workers globals,
 * nothing but TextEncoder/TextDecoder and typed arrays, so the same bytes are
 * produced by Node and by workerd.
 *
 * Shape of a session:
 *
 *   1. VPS opens a WebSocket to the Worker. The URL is bare - no query params,
 *      no subprotocol. Both of those get written to request logs by Cloudflare
 *      and by anything in between, and frame 0 carries proxy credentials.
 *   2. VPS sends frame 0: the AES-256-GCM sealed DialRequest.
 *   3. Worker replies READY (one byte) or ERROR (code + message), the latter
 *      followed immediately by a close with the matching 4xxx code.
 *   4. After READY, every frame in both directions is raw tunnel bytes with no
 *      tag at all - a binary message simply IS a chunk of the TCP stream. The
 *      Worker never sends a control frame again, so there is no ambiguity about
 *      whether a post-READY frame is data. Failures from here on are signalled
 *      by close code alone.
 */

export const PROTOCOL_VERSION = 0x01;

/** Control frame tags. Only ever sent before READY (READY itself being the last). */
export const FRAME_READY = 0x01;
export const FRAME_ERROR = 0x02;

/** AES-GCM nonce length, in bytes. */
export const IV_BYTES = 12;

/** Max sealed dial frame, including version byte and IV. */
export const MAX_DIAL_FRAME_BYTES = 4096;

/** A dial older than this is refused, which bounds replay without shared state. */
export const DIAL_MAX_AGE_MS = 60_000;

export type DialProtocol = "http" | "https" | "socks5" | "socks4";

export interface DialRequest {
  /** Server-owned background probes; authenticated inside the sealed dial. */
  purpose?: "catalog";
  /** Date.now() at seal time. See DIAL_MAX_AGE_MS. */
  ts: number;
  /** Random hex, 16 bytes. Distinguishes two dials sealed in the same millisecond. */
  nonce: string;
  protocol: DialProtocol;
  /** The proxy's own host and port. */
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Where the proxy should be asked to connect. */
  target: { host: string; port: number };
  /**
   * Opaque per-user rate-limit bucket. Optional, and the Worker falls back to
   * the connecting address when it is absent - which is what makes adding it a
   * compatible change rather than a flag day: an older relay simply does not
   * send it, and an older Worker simply ignores it.
   *
   * It is NOT an identifier the Worker can resolve to a person from anything it
   * observes; see deriveBucket in crypto.ts for exactly what that is and is not
   * worth.
   */
  bucket?: string;
}

/**
 * WebSocket close codes. 4000-4999 is the range reserved for application use.
 * The Worker uses these exclusively after READY; before READY it sends an ERROR
 * frame carrying the same code AND then closes with it, because a close reason
 * is capped at 123 bytes and a useful proxy error routinely exceeds that.
 */
export const RelayClose = {
  DIAL_REJECTED: 4000,
  PROXY_UNREACHABLE: 4001,
  HANDSHAKE_FAILED: 4002,
  RATE_LIMITED: 4003,
  TARGET_NOT_ALLOWED: 4004,
  UPSTREAM_CLOSED: 4005,
  IDLE_TIMEOUT: 4006,
  CAP_EXCEEDED: 4007,
  DIAL_DECRYPT_FAILED: 4008,
} as const;

export type RelayCloseCode = (typeof RelayClose)[keyof typeof RelayClose];

const CLOSE_MESSAGES: Record<number, string> = {
  [RelayClose.DIAL_REJECTED]: "The relay rejected this proxy: check the host, port and protocol.",
  [RelayClose.PROXY_UNREACHABLE]: "Could not reach the proxy.",
  [RelayClose.HANDSHAKE_FAILED]: "The proxy refused the connection.",
  [RelayClose.RATE_LIMITED]: "Too many requests to the relay. Try again shortly.",
  [RelayClose.TARGET_NOT_ALLOWED]: "The relay does not allow connections to that address.",
  [RelayClose.UPSTREAM_CLOSED]: "The connection closed unexpectedly.",
  [RelayClose.IDLE_TIMEOUT]: "The connection went idle and was closed.",
  [RelayClose.CAP_EXCEEDED]: "The connection exceeded the relay's size or duration limit.",
  [RelayClose.DIAL_DECRYPT_FAILED]: "The relay could not authenticate this request.",
};

export function relayCloseMessage(code: number): string {
  if (code === 1000) return "The connection closed normally.";
  return CLOSE_MESSAGES[code] ?? `The relay closed the connection (code ${code}).`;
}

/** Stable, JSON-safe string form of a close code, for the client-facing `code` field. */
const RELAY_CLOSE_CODE_NAMES: Record<number, string> = {
  [RelayClose.DIAL_REJECTED]: "dial_rejected",
  [RelayClose.PROXY_UNREACHABLE]: "proxy_unreachable",
  [RelayClose.HANDSHAKE_FAILED]: "handshake_failed",
  [RelayClose.RATE_LIMITED]: "worker_rate_limited",
  [RelayClose.TARGET_NOT_ALLOWED]: "target_not_allowed",
  [RelayClose.UPSTREAM_CLOSED]: "upstream_closed",
  [RelayClose.IDLE_TIMEOUT]: "idle_timeout",
  [RelayClose.CAP_EXCEEDED]: "cap_exceeded",
  [RelayClose.DIAL_DECRYPT_FAILED]: "dial_decrypt_failed",
};

export function relayCloseCode(code: number): string {
  if (code === 1000) return "closed_normally";
  return RELAY_CLOSE_CODE_NAMES[code] ?? "relay_closed";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `[version][iv(12)][ciphertext||tag]` */
export function encodeDialFrame(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (iv.length !== IV_BYTES) throw new Error(`IV must be ${IV_BYTES} bytes`);
  const out = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  out[0] = PROTOCOL_VERSION;
  out.set(iv, 1);
  out.set(ciphertext, 1 + IV_BYTES);
  if (out.length > MAX_DIAL_FRAME_BYTES) throw new Error("Dial frame too large");
  return out;
}

export function decodeDialFrame(bytes: Uint8Array): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (bytes.length > MAX_DIAL_FRAME_BYTES) throw new Error("Dial frame too large");
  // An AES-GCM tag is 16 bytes, so anything at or below header+tag carries no payload.
  if (bytes.length <= 1 + IV_BYTES + 16) throw new Error("Dial frame too short");
  if (bytes[0] !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version ${bytes[0]}`);
  return {
    iv: bytes.subarray(1, 1 + IV_BYTES),
    ciphertext: bytes.subarray(1 + IV_BYTES),
  };
}

export function encodeReadyFrame(): Uint8Array {
  return new Uint8Array([FRAME_READY]);
}

export function encodeErrorFrame(code: number, message: string): Uint8Array {
  const body = encoder.encode(message);
  const out = new Uint8Array(3 + body.length);
  out[0] = FRAME_ERROR;
  out[1] = (code >> 8) & 0xff;
  out[2] = code & 0xff;
  out.set(body, 3);
  return out;
}

export type ControlFrame =
  | { kind: "ready" }
  | { kind: "error"; code: number; message: string };

export function decodeControlFrame(bytes: Uint8Array): ControlFrame {
  if (bytes.length === 0) throw new Error("Empty control frame");
  if (bytes[0] === FRAME_READY) return { kind: "ready" };
  if (bytes[0] === FRAME_ERROR) {
    if (bytes.length < 3) throw new Error("Truncated error frame");
    const code = (bytes[1] << 8) | bytes[2];
    return { kind: "error", code, message: decoder.decode(bytes.subarray(3)) };
  }
  throw new Error(`Unknown control frame tag 0x${bytes[0].toString(16)}`);
}
