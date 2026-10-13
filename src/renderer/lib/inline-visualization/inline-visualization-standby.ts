import {
  createInlineVisualizationPreparedLease,
  type InlineVisualizationPreparedLease,
} from "./inline-visualization-prepared";

type Cancel = () => void;
export function scheduleInlineVisualizationIdle(callback: () => void): Cancel {
  if (window.requestIdleCallback && window.cancelIdleCallback) {
    const id = window.requestIdleCallback(callback, { timeout: 2_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}
interface StandbyPlatform {
  readonly idle: (callback: () => void) => Cancel;
  readonly delay: (callback: () => void, durationMs: number) => Cancel;
  readonly prepare: typeof createInlineVisualizationPreparedLease;
}
interface Root {
  readonly container: HTMLElement;
  readonly locale: string;
  didRetryPreparation: boolean;
}

/** The existing window Frame owner holds one unused connection; claimed guests never return. */
export function createInlineVisualizationStandby(
  platform: StandbyPlatform = {
    idle: scheduleInlineVisualizationIdle,
    delay: (callback, durationMs) => {
      const id = window.setTimeout(callback, durationMs);
      return () => window.clearTimeout(id);
    },
    prepare: createInlineVisualizationPreparedLease,
  },
) {
  let root: Root | null = null;
  let slot: InlineVisualizationPreparedLease | null = null;
  let cancelPending: Cancel | null = null;
  const stop = () => {
    root = null;
    cancelPending?.();
    cancelPending = null;
    void slot?.dispose();
  };
  const schedule = (delayedRetry = false): void => {
    const captured = root;
    if (!captured || slot || cancelPending) return;
    const prepare = () => {
      if (root !== captured) return;
      cancelPending = null;
      if (!captured.container.isConnected) return;
      const lease = platform.prepare(captured.locale, (disposed) => {
        if (slot !== disposed) return;
        slot = null;
        if (root !== captured || captured.didRetryPreparation) return;
        captured.didRetryPreparation = true;
        schedule(true);
      });
      slot = lease;
      void lease.prepare(captured.container).catch(() => lease.dispose());
    };
    cancelPending = delayedRetry ? platform.delay(prepare, 1_000) : platform.idle(prepare);
  };
  return {
    start(container: HTMLElement, locale: string): Cancel {
      stop();
      const captured: Root = { container, locale, didRetryPreparation: false };
      root = captured;
      schedule();
      return () => {
        if (root === captured) stop();
      };
    },
    claim(locale: string): InlineVisualizationPreparedLease | null {
      const lease = slot;
      if (!lease) {
        schedule();
        return null;
      }
      if (lease.locale !== locale) {
        void lease.dispose();
        return null;
      }
      if (!lease.isReady) return null;
      slot = null;
      schedule();
      return lease;
    },
    dispose: stop,
  };
}

export type InlineVisualizationStandby = ReturnType<typeof createInlineVisualizationStandby>;
export type InlineVisualizationStandbyClaim = Pick<InlineVisualizationStandby, "claim">;
