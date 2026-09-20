import { logProtocolViolation } from "./protocolOutputLog";

/** Tracks Markdown code examples without buffering their bodies. */
export function createLiteralTracker() {
  let fence = 0, inline = 0, run = 0;
  let marker = "";
  let fenceMarker = "";
  return {
    get literal() { return fence > 0 || inline > 0; },
    consume(text: string) {
      for (const char of text) {
        if ((char === "`" || char === "~") && (!marker || marker === char)) {
          marker = char; run++; continue;
        }
        if (run) {
          if (run >= 3 && !inline) {
            if (!fence) { fence = run; fenceMarker = marker; }
            else if (marker === fenceMarker && run >= fence) fence = 0;
          }
          else if (!fence && marker === "`") inline = inline === run ? 0 : inline || run;
          run = 0; marker = "";
        }
      }
    },
  };
}

const TOOL_MARKERS = ["<minimax:tool_call", "</minimax:tool_call", "<tool_call", "</tool_call",
  "<tool_calls", "</tool_calls", "<function_call", "</function_call", "[tool_calls]",
  "<tool_use", "</tool_use", "<function=", "<invoke ", "<artifact ", "</artifact>",
  "<|im_end|>", "<|im_start|>", "<|eot_id|>", "<|end_of_text|>", "<|start_header_id|>",
  "<｜end▁of▁sentence｜>"];
const ARTIFACT_OPEN = "<fachoy-artifact";
const ARTIFACT_CLOSE = "</fachoy-artifact>";
const MARKERS = [...TOOL_MARKERS, ARTIFACT_OPEN, ARTIFACT_CLOSE];

function validArtifactHeader(header: string): boolean {
  const attributes = new Map([...header.matchAll(/\b(\w+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
  return Boolean(attributes.get("id") && attributes.get("title") &&
    attributes.get("id") !== "UNIQUE_ID" && attributes.get("title") !== "FILENAME.EXT" &&
    ["code", "markdown", "html", "svg", "document"].includes(attributes.get("type") ?? ""));
}

/** Known protocol boundaries outside literal examples end the answer. Never
 * interpret text pretending to be a function call as an executable tool. */
export function createProtocolOutputGuard(
  onText: (text: string) => void,
  allowArtifacts = false,
  context?: { modelId?: string; connectionAlias?: string }
) {
  const literal = createLiteralTracker();
  let pending = "", stopped = false, artifact = false, openingArtifact = false;
  let violations = 0;
  function recordViolation(reason: string) {
    violations++;
    logProtocolViolation({ ...context, reason, snippet: pending.slice(0, 300) });
  }
  function drain(final = false) {
    let output = "";
    while (pending && !stopped) {
      if (openingArtifact) {
        const end = pending.indexOf(">");
        if (end < 0) {
          if (!final && pending.length <= 512) break;
          stopped = true; recordViolation("artifact-header-unterminated"); break;
        }
        if (end > 512 || !validArtifactHeader(pending.slice(0, end + 1))) { stopped = true; recordViolation("artifact-header-invalid"); break; }
        output += pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        openingArtifact = false; artifact = true;
        continue;
      }
      const lower = pending.toLowerCase();
      if (artifact) {
        if (lower.startsWith(ARTIFACT_CLOSE)) {
          output += pending.slice(0, ARTIFACT_CLOSE.length);
          pending = pending.slice(ARTIFACT_CLOSE.length); artifact = false; continue;
        }
        if (!final && ARTIFACT_CLOSE.startsWith(lower)) break;
      } else {
        // Finalize any backtick run before deciding whether a marker is code.
        literal.consume(pending[0]);
        if (!literal.literal) {
          if (lower.startsWith("<|") || lower.startsWith("<｜")) {
            const close = lower.indexOf(lower[1] + ">");
            if (close < 0) {
              if (!final && pending.length < 96) break;
              stopped = true; recordViolation("special-token-unterminated"); break;
            }
            const token = lower.slice(2, close).replaceAll("▁", "_");
            if (/tool|function|im_end|im_start|eot_id|end_of_text|end.*sentence|start_header_id/.test(token)) {
              stopped = true;
              // An ordinary end-of-turn token is a boundary, not evidence
              // that the model failed to answer correctly.
              if (/tool|function|im_start|start_header_id/.test(token)) recordViolation(`special-token:${token}`);
              break;
            }
            pending = pending.slice(close + 2);
            continue;
          }
          const marker = MARKERS.find(m => lower.startsWith(m));
          if (marker) {
            if (marker === ARTIFACT_OPEN && allowArtifacts) { openingArtifact = true; continue; }
            stopped = true; recordViolation(`marker:${marker}`); break;
          }
          if (MARKERS.some(m => m.startsWith(lower))) {
            if (!final) break;
            // Do not leak a truncated protocol prefix; keep ordinary '<' text.
            if (lower.length >= 5) { stopped = true; recordViolation("marker-prefix-truncated"); break; }
          }
        }
      }
      output += pending[0]; pending = pending.slice(1);
    }
    if (stopped) pending = "";
    if (output) onText(output);
  }
  return {
    push(text: string) { if (!stopped) { pending += text; drain(); } },
    flush() { drain(true); },
    get violations() { return violations; },
  };
}

export function cleanProtocolOutput(text: string, allowArtifacts = false): string {
  let clean = "";
  const guard = createProtocolOutputGuard(t => { clean += t; }, allowArtifacts);
  guard.push(text); guard.flush();
  return clean;
}
