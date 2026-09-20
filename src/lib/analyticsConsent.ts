/**
 * Whether a visitor has agreed to Google Analytics loading (see analytics.ts).
 *
 * Kept as its own key rather than a field on Preferences (preferences.ts):
 * it's read and flipped from two places that aren't App.tsx or the Settings
 * modal (AnalyticsConsentBar, and the control on the Privacy Policy page),
 * it's a tri-state rather than a boolean, and a legal consent choice must
 * never travel between machines through the backup export/import feature the
 * way the rest of Preferences deliberately does.
 */
import { useCallback, useState } from "react";

export type AnalyticsConsent = "unset" | "accepted" | "declined";

const KEY = "fachoy:analytics-consent:v1";

export function getAnalyticsConsent(): AnalyticsConsent {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "accepted" || raw === "declined") return raw;
  } catch {
    /* ignore */
  }
  return "unset";
}

export function setAnalyticsConsent(consent: "accepted" | "declined"): void {
  try {
    localStorage.setItem(KEY, consent);
  } catch {
    /* ignore */
  }
}

export function hasAnalyticsConsent(): boolean {
  return getAnalyticsConsent() === "accepted";
}

/** Shared state-mirroring for the two surfaces that show and flip this choice. */
export function useAnalyticsConsent(): {
  consent: AnalyticsConsent;
  accept: () => void;
  decline: () => void;
} {
  const [consent, setConsent] = useState<AnalyticsConsent>(getAnalyticsConsent);
  const accept = useCallback(() => {
    setAnalyticsConsent("accepted");
    setConsent("accepted");
  }, []);
  const decline = useCallback(() => {
    setAnalyticsConsent("declined");
    setConsent("declined");
  }, []);
  return { consent, accept, decline };
}
