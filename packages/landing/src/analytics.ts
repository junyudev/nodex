import { STATSIG_CLIENT_KEY } from "../../../src/shared/product-analytics/statsig";
import { trafficSource } from "./traffic-source";

/**
 * Counts visits and download intent with no cookies or stored identity: the ID lives only for this
 * page load, so two page views can never be connected. A browser's privacy signal turns it off.
 */
const ENDPOINT = `https://events.statsigapi.net/v1/rgstr?k=${STATSIG_CLIENT_KEY}&st=nodex-landing&sv=1`;

const optedOut = (): boolean => {
  const signals = navigator as Navigator & { readonly globalPrivacyControl?: boolean };
  return signals.globalPrivacyControl === true || navigator.doNotTrack === "1";
};

function trackPage(): void {
  const root = document.documentElement;
  // The homepage that redirects to the visitor's language is not a visit of its own; the
  // destination counts it, using the referrer the redirect carried across.
  if (root.dataset.languageRedirect === "true" || optedOut()) return;

  const pageLoadId = crypto.randomUUID();
  const referrer = root.dataset.languageReferrer ?? document.referrer;
  const source = trafficSource(new URL(location.href), referrer);
  const tier = location.hostname === "nodex.jyu.app" ? "production" : "development";

  const send = (eventName: string, metadata: Readonly<Record<string, string>>): void => {
    const time = Date.now();
    // Keep the request alive during download navigation and exclude third-party cookies.
    void fetch(`${ENDPOINT}&t=${time}`, {
      method: "POST",
      keepalive: true,
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({
        events: [
          {
            eventName,
            time,
            metadata: { ...metadata, source },
            user: { customIDs: { stableID: pageLoadId }, statsigEnvironment: { tier } },
          },
        ],
        statsigMetadata: { sdkType: "nodex-landing", sdkVersion: "1" },
      }),
    }).catch(() => {
      // Analytics is best-effort and must not affect the site.
    });
  };

  const trackDownload = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (event.type === "auxclick" && event.button !== 1) return;

    const selector = event.type === "auxclick" ? "a[data-download]" : "[data-download]";
    const target = event.target.closest<HTMLElement>(selector)?.dataset.download;
    if (target) send("landing_download_clicked", { target });
  };

  document.addEventListener("click", trackDownload);
  document.addEventListener("auxclick", trackDownload);
  send("landing_viewed", { page: location.pathname });
}

trackPage();
