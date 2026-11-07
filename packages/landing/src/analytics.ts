import { STATSIG_CLIENT_KEY } from "../../../src/shared/product-analytics/statsig";

/**
 * Counts visits and download intent with no cookies and nothing stored: the ID lives only for this
 * page load, so two page views can never be connected. A browser's privacy signal turns it off.
 */
const ENDPOINT = `https://events.statsigapi.net/v1/rgstr?k=${STATSIG_CLIENT_KEY}&st=nodex-landing&sv=1`;

const optedOut = (): boolean => {
  const signals = navigator as Navigator & { readonly globalPrivacyControl?: boolean };
  return signals.globalPrivacyControl === true || navigator.doNotTrack === "1";
};

const pageLoadId = crypto.randomUUID();

const send = (eventName: string, metadata: Readonly<Record<string, string>>): void => {
  if (optedOut()) return;
  const tier = location.hostname === "nodex.jyu.app" ? "production" : "development";
  const time = Date.now();
  navigator.sendBeacon(
    `${ENDPOINT}&t=${time}`,
    JSON.stringify({
      events: [
        {
          eventName,
          time,
          metadata,
          user: { customIDs: { stableID: pageLoadId }, statsigEnvironment: { tier } },
        },
      ],
      statsigMetadata: { sdkType: "nodex-landing", sdkVersion: "1" },
    }),
  );
};

send("landing_viewed", { page: location.pathname });

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const download = event.target.closest<HTMLElement>("a[data-download]");
  if (download?.dataset.download) {
    send("landing_download_clicked", { target: download.dataset.download });
    return;
  }
  if (event.target.closest(".landing-brew-copy")) {
    send("landing_download_clicked", { target: "homebrew" });
  }
});
