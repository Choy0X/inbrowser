import { Badge, Button, Section } from "./ui";
import { APP_ANALYTICS_ID, APP_NAME, APP_REPO_URL, APP_URL } from "../lib/appConfig";
import { privacyPolicySections } from "../lib/seo/content/privacyPolicy";
import { useAnalyticsConsent } from "../lib/analyticsConsent";
import { trackPageview } from "../lib/analytics";
import { resolveRouteSeo } from "../lib/seo/head";
import { useLocation } from "react-router-dom";

/**
 * The Accept/Decline/current-answer control shown next to the "Site
 * analytics" section's heading (matched by title - see the map below). Lets a
 * visitor change the choice AnalyticsConsentBar first asked for. Renders
 * nothing on a build with no analytics id, same as the bar itself.
 */
function AnalyticsConsentControl() {
  const { pathname } = useLocation();
  const { consent, accept, decline } = useAnalyticsConsent();
  if (!APP_ANALYTICS_ID) return null;

  const handleAccept = () => {
    accept();
    trackPageview(resolveRouteSeo(pathname), pathname);
  };

  if (consent === "unset") {
    return (
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={decline}>
          Decline
        </Button>
        <Button variant="secondary" size="sm" onClick={handleAccept}>
          Accept
        </Button>
      </div>
    );
  }

  const accepted = consent === "accepted";
  return (
    <div className="flex items-center gap-2">
      <Badge tone={accepted ? "success" : "neutral"}>{accepted ? "Accepted" : "Declined"}</Badge>
      <Button variant="secondary" size="sm" onClick={accepted ? decline : handleAccept}>
        {accepted ? "Decline" : "Accept"}
      </Button>
    </div>
  );
}

/**
 * The policy prose lives in lib/seo/content/privacyPolicy.ts, not here, so the
 * copy a crawler reads in the static shell and the copy a visitor reads are the
 * same strings. See that file's header.
 */
export function PrivacyPolicyContent() {
  const sections = privacyPolicySections({
    name: APP_NAME,
    url: APP_URL,
    repoUrl: APP_REPO_URL,
  });

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <Section
          key={section.title}
          title={section.title}
          actions={section.title === "Site analytics" ? <AnalyticsConsentControl /> : undefined}
        >
          {section.paragraphs.map((paragraph, i) => (
            <p key={i} className={i === 0 ? "" : "mt-3"}>
              {paragraph}
            </p>
          ))}
          {section.links && (
            <ul className="mt-3 space-y-1">
              {section.links.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2 hover:text-accent/80"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ))}
    </div>
  );
}
