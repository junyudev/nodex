import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "../../../../lib/utils";

export const CODEX_SHIMMER_CADENCE_MS = {
  initialDelay: 600,
  activeDuration: 1_000,
  interval: 4_000,
} as const;

export const CODEX_SHIMMER_VARIANT = "cadenced" as const;

type CodexShimmerVariant = "classic" | "cadenced";

const CADENCED_SHIMMER_ACTIVE_CLASS = "codex-cadenced-shimmer-active";

/** Marks the element whose visibility decides whether a label that starts with a sweep may run. */
export const SHIMMER_VISIBILITY_ROOT_ATTRIBUTE = "data-shimmer-visibility-root";

const CodexShimmerEnabledContext = createContext(true);

export function CodexShimmerProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  return (
    <CodexShimmerEnabledContext.Provider value={enabled}>
      {children}
    </CodexShimmerEnabledContext.Provider>
  );
}

/** Whether shimmer may run here; nested activity lists switch it off for their rows. */
export function useCodexShimmerEnabled(): boolean {
  return useContext(CodexShimmerEnabledContext);
}

interface CodexShimmerTextProps extends ComponentPropsWithoutRef<"span"> {
  active?: boolean;
  variant?: CodexShimmerVariant;
  /** Sweep as soon as the label is visible instead of after the resting delay. */
  startWithSweep?: boolean;
  /** Reports each sweep's start and end; also reports `false` when no sweep can start. */
  onSweepChange?: (sweeping: boolean) => void;
}

function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/**
 * Runs one highlight sweep every few seconds while the label is visible, the window is shown and
 * motion is allowed. Every sweep is a single, stepped pass so idle labels cost nothing between
 * passes.
 */
function useCadencedSweep(
  element: { current: HTMLSpanElement | null },
  input: {
    enabled: boolean;
    reducedMotion: boolean;
    startWithSweep: boolean;
    onSweepChange?: (sweeping: boolean) => void;
  },
) {
  const onSweepChangeRef = useRef(input.onSweepChange);
  useLayoutEffect(() => {
    onSweepChangeRef.current = input.onSweepChange;
  });
  const { enabled, reducedMotion, startWithSweep } = input;

  useLayoutEffect(() => {
    const node = element.current;
    if (!enabled || !node) return;
    const report = (sweeping: boolean) => onSweepChangeRef.current?.(sweeping);
    let endTimer: number | undefined;
    let nextTimer: number | undefined;
    let sweeping = false;
    let running = false;
    let inView = typeof IntersectionObserver !== "function";

    const endSweep = (reportEnd: boolean) => {
      if (endTimer !== undefined) window.clearTimeout(endTimer);
      endTimer = undefined;
      node.classList.remove(CADENCED_SHIMMER_ACTIVE_CLASS);
      if (!sweeping) return;
      sweeping = false;
      if (reportEnd) report(false);
    };
    const sweep = () => {
      endSweep(true);
      node.classList.add(CADENCED_SHIMMER_ACTIVE_CLASS);
      sweeping = true;
      report(true);
      endTimer = window.setTimeout(() => endSweep(true), CODEX_SHIMMER_CADENCE_MS.activeDuration);
      nextTimer = window.setTimeout(sweep, CODEX_SHIMMER_CADENCE_MS.interval);
    };
    // Stopping because the label left the screen ends its sweep for the owner; tearing the
    // effect down does not, so a remounted effect (or an unmounting label) reports nothing.
    const stop = (reportEnd: boolean) => {
      running = false;
      if (nextTimer !== undefined) window.clearTimeout(nextTimer);
      nextTimer = undefined;
      endSweep(reportEnd);
    };
    const update = () => {
      const shouldRun = inView && !document.hidden && !reducedMotion;
      if (shouldRun === running) return;
      if (!shouldRun) {
        stop(true);
        return;
      }
      running = true;
      if (startWithSweep) sweep();
      else nextTimer = window.setTimeout(sweep, CODEX_SHIMMER_CADENCE_MS.initialDelay);
    };

    const visibilityTarget = startWithSweep
      ? (node.closest(`[${SHIMMER_VISIBILITY_ROOT_ATTRIBUTE}]`) ?? node)
      : node;
    // A label that should sweep at once may mount just below the fold while the transcript
    // follows new content; it waits for the observer's first verdict before giving up.
    let awaitingFirstVerdict = startWithSweep;
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            if (!entry) return;
            inView = entry.isIntersecting;
            update();
            if (!awaitingFirstVerdict) return;
            awaitingFirstVerdict = false;
            if (!sweeping) report(false);
          })
        : null;
    observer?.observe(visibilityTarget);
    if (startWithSweep && observer && !document.hidden) inView = isInViewport(visibilityTarget);
    update();
    if (startWithSweep && (sweeping || !observer || document.hidden || reducedMotion)) {
      awaitingFirstVerdict = false;
      if (!sweeping) report(false);
    }
    document.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
      stop(false);
    };
  }, [element, enabled, reducedMotion, startWithSweep]);
}

export function CodexShimmerText({
  active = true,
  className,
  children,
  variant = CODEX_SHIMMER_VARIANT,
  startWithSweep = false,
  onSweepChange,
  ...props
}: CodexShimmerTextProps) {
  const contextEnabled = useCodexShimmerEnabled();
  const reducedMotion = useResolvedReducedMotion();
  const ref = useRef<HTMLSpanElement | null>(null);
  const effectiveActive = active && contextEnabled;
  const useCadenced = effectiveActive && variant === "cadenced";
  useCadencedSweep(ref, { enabled: useCadenced, reducedMotion, startWithSweep, onSweepChange });

  if (!effectiveActive) {
    return (
      <span className={className} data-codex-shimmer="static" {...props}>
        {children}
      </span>
    );
  }

  return (
    <span
      ref={useCadenced ? ref : undefined}
      className={cn(
        "loading-shimmer-pure-text",
        useCadenced && "codex-cadenced-shimmer",
        className,
      )}
      data-codex-shimmer={variant}
      {...props}
    >
      {children}
      {useCadenced ? (
        <span
          aria-hidden="true"
          className="codex-cadenced-shimmer-sweep"
          data-codex-shimmer-sweep="true"
        >
          <span className="codex-cadenced-shimmer-highlight">{children}</span>
        </span>
      ) : null}
    </span>
  );
}
