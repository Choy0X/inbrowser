/**
 * Shared OpenAI-chat-completions-shaped response handling — used by both
 * adapters/openai.ts (any "openai" format ProviderConnection) and
 * gateway/selfHostedGateway.ts (a self-hosted gateway speaking the OmniRoute
 * protocol's /v1/chat/completions, which uses the same OpenAI chunk/response
 * shape). Kept here once rather
 * than duplicated across both call sites.
 */
import type { ToolCallWire } from "./types";
import { GatewayError } from "./types";
import { iterateSSEEvents, parseSSEBlock } from "./providerFetch";
import { extractError, parseErrorMessage, parseRetryAfterMs, stripLeakedSpecialTokens } from "./util";
import { createThinkTagSplitter, stripThinkTags } from "./thinkTags";
import { createNarrativeReasoningSplitter, stripNarrativeReasoning } from "./narrativeReasoning";

export interface OpenAIStreamCallbacks {
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: ToolCallWire[]) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}

/** Some gateways return a JSON rate-limit error with HTTP 200 (KouziAI). */
function throwIfRateLimited(res: Response, data: unknown): void {
  const error = (data as { error?: { code?: string; type?: string; retry_after?: number } } | null)?.error;
  if (error?.code !== "rate_limit_exceeded" && error?.type !== "rate_limit_error") return;
  const seconds = error.retry_after;
  const retryAfterMs = parseRetryAfterMs(res) ??
    (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined);
  throw new GatewayError(429, extractError(data) || "Rate limit exceeded", false, retryAfterMs, "rate_limit_exceeded");
}

/** Throws a GatewayError with the upstream's real error text if `res` isn't a usable SSE stream. */
export async function assertSSEResponse(res: Response): Promise<void> {
  const contentType = res.headers.get("content-type") || "";
  if (res.ok && contentType.includes("text/event-stream")) return;
  const raw = await res.text().catch(() => "");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { /* Non-JSON error handled below. */ }
  throwIfRateLimited(res, data);
  const { message, malformed } = parseErrorMessage(raw, res.status);
  throw new GatewayError(res.status, message, malformed, parseRetryAfterMs(res));
}

/** Consumes an OpenAI-chat-completions-shaped SSE response, driving the given callbacks. Returns accumulated tool calls. */
export async function consumeOpenAIStream(
  res: Response,
  callbacks: OpenAIStreamCallbacks
): Promise<ToolCallWire[]> {
  let sawContent = false;
  let sawError = false;
  let sawDone = false;
  let finishReason: string | undefined;
  const accumulatingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  // Some open-weight "reasoning" models have no separate reasoning_content
  // field — they wrap their chain-of-thought in inline <think>/<thinking>
  // tags within the regular content stream instead. Route those out to
  // onReasoning (the "Thinking" UI) so they don't land in the visible answer.
  // Chained after thinkSplitter: catches models that narrate reasoning as
  // plain prose with no <think> tag at all (see narrativeReasoning.ts).
  const narrativeSplitter = createNarrativeReasoningSplitter({
    onContent: (t) => callbacks.onDelta(t),
    onReasoning: (t) => callbacks.onReasoning?.(t),
  });
  const thinkSplitter = createThinkTagSplitter({
    onContent: (t) => narrativeSplitter.push(t),
    onReasoning: (t) => callbacks.onReasoning?.(t),
  });

  const handleEvent = (payload: string) => {
    if (sawDone) return;
    if (payload === "[DONE]") {
      sawDone = true;
      callbacks.onDone?.();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const err = extractError(json);
    if (err) {
      sawError = true;
      callbacks.onError?.(err);
      return;
    }
    const jsonObj = json as Record<string, unknown>;
    const choice = (jsonObj.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) return;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        sawContent = true;
        callbacks.onReasoning?.(reasoning);
      }
      // Preserve boundaries for the shared, chunk-aware response guard.
      const content = delta.content;
      if (typeof content === "string" && content) {
        sawContent = true;
        thinkSplitter.push(content);
      }
      const toolCallsDelta = delta.tool_calls;
      if (Array.isArray(toolCallsDelta)) {
        for (const call of toolCallsDelta) {
          const obj = call as Record<string, unknown>;
          const index = typeof obj.index === "number" ? obj.index : 0;
          let acc = accumulatingToolCalls.get(index);
          if (!acc) {
            acc = { id: "", name: "", arguments: "" };
            accumulatingToolCalls.set(index, acc);
          }
          if (obj.id && typeof obj.id === "string") acc.id = obj.id;
          const fn = obj.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === "string" && fn.name && fn.name !== acc.name) acc.name += fn.name;
            if (typeof fn.arguments === "string") acc.arguments += fn.arguments;
            if (acc.arguments.length > 131072 || acc.name.length > 256 || accumulatingToolCalls.size > 32) {
              throw new GatewayError(502, "Model tool call exceeded protocol limits", false, undefined, "invalid_tool_call");
            }
          }
        }
        sawContent = true;
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
      sawDone = true;
      callbacks.onDone?.();
    }
  };

  try {
    for await (const raw of iterateSSEEvents(res)) {
      const { data } = parseSSEBlock(raw);
      if (data) handleEvent(data);
    }
  } catch (err) {
    if (!callbacks.signal?.aborted) {
      sawError = true;
      callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
  // An unterminated <think> block (model cut off mid-reasoning) shouldn't
  // silently lose whatever text was buffered waiting for the close tag.
  thinkSplitter.flush();
  narrativeSplitter.flush();
  if (!sawContent && !sawError && !sawDone) {
    callbacks.onError?.("Provider returned an empty response");
  }

  const sorted = [...accumulatingToolCalls.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length && (finishReason === "length" || finishReason === "content_filter")) {
    throw new GatewayError(502, "Provider interrupted the tool call before completion", false, undefined, "invalid_tool_call");
  }
  const toolCalls: ToolCallWire[] = [];
  for (const [, acc] of sorted) {
    if (!acc.id || !acc.name) throw new GatewayError(502, "Model returned an incomplete tool call", false, undefined, "invalid_tool_call");
    toolCalls.push({ id: acc.id, type: "function", function: { name: acc.name, arguments: acc.arguments } });
  }
  if (toolCalls.length > 0) callbacks.onToolCalls?.(toolCalls);
  return toolCalls;
}

/** Extracts the assistant text from a non-streaming OpenAI chat-completions JSON response. */
export async function extractCompletionText(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  throwIfRateLimited(res, data);
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== "string") {
    throw new GatewayError(
      res.status,
      extractError(data) || "Unexpected response from provider",
      false,
      parseRetryAfterMs(res)
    );
  }
  return stripNarrativeReasoning(stripThinkTags(stripLeakedSpecialTokens(content))).trim();
}
