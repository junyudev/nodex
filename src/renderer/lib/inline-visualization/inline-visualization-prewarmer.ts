import { scheduleAfterPaint } from "../schedule-after-paint";
import {
  scheduleInlineVisualizationIdle,
  type InlineVisualizationStandby,
} from "./inline-visualization-standby";

type Cancel = () => void;
export const readInlineVisualizationLocale = () => navigator.language;
export function subscribeInlineVisualizationLocale(callback: () => void): Cancel {
  window.addEventListener("languagechange", callback);
  return () => window.removeEventListener("languagechange", callback);
}
interface PrewarmerPlatform {
  readonly afterVisiblePaint: (callback: () => void) => Cancel;
  readonly delay: (callback: () => void, durationMs: number) => Cancel;
  readonly idle: (callback: () => void) => Cancel;
  readonly readLocale: () => string;
  readonly onLocaleChange: (callback: () => void) => Cancel;
  readonly onPageHide: (callback: () => void) => Cancel;
}
/** Background readiness and the broker's preparation are separate, cancellable idle phases. */
export function startInlineVisualizationPrewarmer(
  container: HTMLElement,
  standby: Pick<InlineVisualizationStandby, "start">,
  platform: PrewarmerPlatform = {
    afterVisiblePaint: (callback) => scheduleAfterPaint(callback, { requireVisibleAtPaint: true }),
    delay: (callback, durationMs) => {
      const id = window.setTimeout(callback, durationMs);
      return () => window.clearTimeout(id);
    },
    idle: scheduleInlineVisualizationIdle,
    readLocale: readInlineVisualizationLocale,
    onLocaleChange: subscribeInlineVisualizationLocale,
    onPageHide: (callback) => {
      window.addEventListener("pagehide", callback);
      return () => window.removeEventListener("pagehide", callback);
    },
  },
): Cancel {
  let stopped = false;
  let backgroundReady = false;
  let locale = platform.readLocale();
  let cancelPhase: Cancel | null = null;
  let stopRoot: Cancel | null = null;
  const replaceRoot = () => {
    stopRoot?.();
    stopRoot = standby.start(container, locale);
  };
  cancelPhase = platform.afterVisiblePaint(() => {
    if (stopped) return;
    cancelPhase = platform.delay(() => {
      if (stopped) return;
      cancelPhase = platform.idle(() => {
        if (stopped) return;
        backgroundReady = true;
        cancelPhase = null;
        replaceRoot();
      });
    }, 5_000);
  });
  const cancelLocale = platform.onLocaleChange(() => {
    const next = platform.readLocale();
    if (stopped || next === locale) return;
    locale = next;
    if (backgroundReady) replaceRoot();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelPhase?.();
    cancelPhase = null;
    stopRoot?.();
    stopRoot = null;
    cancelLocale();
    cancelPageHide();
  };
  const cancelPageHide = platform.onPageHide(stop);
  return stop;
}
