import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useResolvedReducedMotion } from "../use-reduced-motion";
import {
  createAdaptiveMarkdownBuffer,
  type AdaptiveMarkdownScheduler,
} from "./adaptive-markdown-buffer";

const browserScheduler: AdaptiveMarkdownScheduler = {
  nowSeconds: () => performance.now() / 1_000,
  timeout: (callback, delayMs) => {
    const id = window.setTimeout(callback, delayMs);
    return () => window.clearTimeout(id);
  },
  frame: (callback) => {
    const id = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(id);
  },
};

export interface AdaptiveMarkdownOptions {
  readonly streamId: string;
  readonly arrivalIntervalFloorSeconds?: number;
  /** False presents the source directly without changing the renderer's identity. */
  readonly enabled?: boolean;
}

export function useAdaptiveMarkdown(
  source: string,
  options: AdaptiveMarkdownOptions,
  streaming: boolean,
  animate: boolean,
) {
  const reducedMotion = useResolvedReducedMotion();
  const { streamId, arrivalIntervalFloorSeconds = 10, enabled = true } = options;
  const active = enabled && streaming && animate && !reducedMotion;
  const [owner] = useState(() =>
    createAdaptiveMarkdownBuffer({ source, streamId, active }, browserScheduler),
  );
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useLayoutEffect(() => () => owner.cancel(), [owner]);
  useLayoutEffect(() => {
    owner.update({ source, streamId, active, arrivalIntervalFloorSeconds });
  }, [owner, source, streamId, active, arrivalIntervalFloorSeconds]);
  return {
    text:
      active && snapshot.streamId === streamId && source.startsWith(snapshot.source)
        ? snapshot.text
        : source,
    active,
    animate: animate && !reducedMotion,
  };
}
