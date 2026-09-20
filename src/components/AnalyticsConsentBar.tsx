import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "./ui";
import { APP_ANALYTICS_ID, APP_NAME } from "../lib/appConfig";
import { useAnalyticsConsent } from "../lib/analyticsConsent";
import { trackPageview } from "../lib/analytics";
import { resolveRouteSeo } from "../lib/seo/head";

/**
 * Asked once, before Google Analytics ever loads - see analytics.ts and
 * analyticsConsent.ts. Renders nothing on a build with no analytics id
 * (nothing to consent to) or once the visitor has already answered, this
 * session or a previous one. The answer can be changed later from the
 * "Site analytics" section of the Privacy Policy page.
 */
export function AnalyticsConsentBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { consent, accept, decline } = useAnalyticsConsent();

  if (!APP_ANALYTICS_ID || consent !== "unset") return null;

  const handleAccept = () => {
    accept();
    trackPageview(resolveRouteSeo(pathname), pathname);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-elevated px-4 py-3 shadow-lift">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-5 text-fg-dim">
          {APP_NAME} uses Google Analytics to measure site traffic, which sets a cookie in your browser.{" "}
          <button
            type="button"
            onClick={() => navigate("/privacy")}
            className="text-accent underline underline-offset-2 hover:text-accent/80"
          >
            Privacy Policy
          </button>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={decline}>
            Decline
          </Button>
          <Button variant="primary" size="sm" onClick={handleAccept}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
