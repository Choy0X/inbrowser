/**
 * Google Analytics (GA4), loaded only when a deployer has set
 * config.json's client.analyticsId - empty by default, so a fork of this
 * repository does not silently report its own visitors to InBrowser's GA
 * property. It is also gated on visitor consent (analyticsConsent.ts):
 * `trackPageview` is a no-op until the visitor has explicitly accepted, so
 * `ensureLoaded()` - and the gtag script/cookie it injects - never runs
 * before that.
 *
 * Page views are sent by hand rather than through GA4's own automatic
 * pageview: this is a single-page app, so a client-side route change never
 * re-fetches the document, and GA's automatic pageview would only ever see
 * the very first URL a visitor landed on. useRouteHead.ts calls
 * `trackPageview` on every route change, including the first, so
 * `send_page_view` is turned off in the initial config to avoid double
 * counting that first load.
 */
import { APP_ANALYTICS_ID } from "./appConfig";
import { hasAnalyticsConsent } from "./analyticsConsent";
import type { ResolvedSeo } from "./seo/head";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

let scriptInjected = false;

function gtag(...args: unknown[]): void {
  window.dataLayer!.push(args);
}

function ensureLoaded(): void {
  if (scriptInjected) return;
  scriptInjected = true;

  window.dataLayer = window.dataLayer || [];
  gtag("js", new Date());
  gtag("config", APP_ANALYTICS_ID, { send_page_view: false });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${APP_ANALYTICS_ID}`;
  document.head.appendChild(script);
}

/**
 * Records one page view. `pathname` is the real URL for an indexable route,
 * but the route's generic path (e.g. "/chat", never "/chat/<id>") for
 * anything that isn't - a conversation id is exactly the kind of per-visitor
 * identifier the privacy policy promises never leaves the browser, and GA is
 * a third party, not a server of ours.
 */
export function trackPageview(seo: ResolvedSeo, pathname: string): void {
  if (!APP_ANALYTICS_ID || typeof window === "undefined" || !hasAnalyticsConsent()) return;
  ensureLoaded();

  const path = seo.route.indexable ? pathname : seo.route.path;
  gtag("event", "page_view", {
    page_path: path,
    page_title: seo.title,
    page_location: `${window.location.origin}${path}`,
  });
}
