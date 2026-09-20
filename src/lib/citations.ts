/**
 * Citation marker normalization for InBrowser chat answers.
 *
 * Web-search–backed model output sometimes emits citation groups (`[1]`,
 * `[2] [3]`) on their OWN line — frequently doubled by blank lines — instead of
 * inline with the claim they support. Markdown then parses those stranded
 * markers as separate BLOCK elements: the sentence gets split mid-stream, the
 * badges land on a line of their own, and bullet badges fall below their item.
 *
 * These helpers normalize the RAW string BEFORE it reaches the markdown parser:
 * a line whose only content is citation markers is pulled up into the preceding
 * line, and the following prose line (when it isn't a new block) is merged into
 * the same sentence so nothing is orphaned. Code-fenced regions are never
 * touched, markers that are already inline are left exactly as-is, and
 * `[n]: url` reference-definition lines are left alone.
 */

/** A line whose trimmed content is nothing but citation markers. */
const STRANDED_LINE_RE = /^[ \t]*(?:\[[0-9]{1,3}\][ \t]*)+\s*$/;

/** A line that clearly starts a new block (bullet/numbered list, heading, quote, table, fence). */
const BLOCK_START_RE = /^[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|#{1,6}[ \t]|>[ \t]?\S|```|~~~|\|)/;

const FENCE_RE = /^(?:```|~~~)/;

/** True when a line holds only citation markers (e.g. "  [2] [3]" or "[1]"). */
export function isStrandedCitationLine(line: string): boolean {
  return STRANDED_LINE_RE.test(line);
}

/** True when a line begins with markdown block syntax (so it should stay separate). */
export function isBlockStart(line: string): boolean {
  return BLOCK_START_RE.test(line);
}

/** Pull a stranded citation line into its surroundings inside a prose run. */
function normalizeProse(prose: string): string {
  const lines = prose.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!isStrandedCitationLine(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Stranded group → attach to the end of the previous line (same paragraph).
    // Hop over any blank lines that separated it so it glues to the prose, and
    // never leave an empty paragraph behind.
    const group = line.trim();
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    const prev = out.pop();
    let merged = (prev === undefined ? group : prev.trimEnd() + " " + group);

    // Merge the next prose line (NOT a new block) so the sentence isn't orphaned.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j += 1;
    if (j < lines.length && !isBlockStart(lines[j])) {
      merged += " " + lines[j].trim();
      i = j + 1;
    } else {
      i = j;
    }
    out.push(merged);
  }

  // Collapse "badge . text" artifacts left behind by the merges into "badge. text".
  return out.join("\n").replace(/\] +([.,;:!?])/g, "]$1");
}

/**
 * Normalize a raw assistant message so citation markers render inline.
 *
 * Only content outside fenced code blocks is considered. Returns the original
 * string untouched when there is nothing to fix (no line-start citations).
 */
export function normalizeCitationMarkers(raw: string): string {
  // Fast path: if no citation group starts a line, there's nothing to do.
  if (!/\n[ \t]*\[[0-9]{1,3}\]/.test(raw)) return raw;

  const segments: string[] = [];
  let prose: string[] = [];
  let inFence = false;

  const flushProse = () => {
    if (prose.length > 0) {
      segments.push(normalizeProse(prose.join("\n")));
      prose = [];
    }
  };

  for (const line of raw.split("\n")) {
    if (inFence) {
      segments.push(line);
      if (FENCE_RE.test(line.trimStart())) inFence = false;
      continue;
    }
    if (FENCE_RE.test(line.trimStart())) {
      flushProse();
      segments.push(line);
      inFence = true;
      continue;
    }
    prose.push(line);
  }
  flushProse();

  const normalized = segments.join("\n");
  return normalized;
}