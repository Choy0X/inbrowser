import { Section } from "./ui";
import { APP_NAME, APP_REPO_URL, APP_URL } from "../lib/appConfig";
import { privacyPolicySections } from "../lib/seo/content/privacyPolicy";

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
        <Section key={section.title} title={section.title}>
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
