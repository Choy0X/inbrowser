/**
 * Bounded, in-memory record of protocol-guard violations (protocolOutput.ts).
 * The raw text that trips the guard is discarded the moment it's rejected —
 * there was previously no way to see what a model actually emitted when a
 * turn ends in "malformed tool or artifact markup" — so this captures just
 * enough to diagnose that after the fact, never surfaced in the chat UI.
 */
export interface ProtocolViolation {
  timestamp: number;
  modelId?: string;
  connectionAlias?: string;
  reason: string;
  /** A short prefix of the text that triggered the violation. */
  snippet: string;
}

const MAX_ENTRIES = 20;
const violations: ProtocolViolation[] = [];

export function logProtocolViolation(entry: Omit<ProtocolViolation, "timestamp">): void {
  violations.push({ ...entry, timestamp: Date.now() });
  if (violations.length > MAX_ENTRIES) violations.shift();
  if (typeof window !== "undefined") {
    (window as unknown as { __protocolViolations?: ProtocolViolation[] }).__protocolViolations = violations;
  }
}

export function getProtocolViolations(): readonly ProtocolViolation[] {
  return violations;
}
