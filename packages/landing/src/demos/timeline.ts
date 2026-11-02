import { useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CaptureHandle } from "./capture-demos";

/** A named moment in a demo's script, in milliseconds from the start of the loop. */
export interface Cue {
  readonly id: string;
  readonly at: number;
}

export interface TimelineScript {
  readonly cues: readonly Cue[];
  /** Full loop length, including the hold after the last cue. */
  readonly durationMs: number;
}

export interface Timeline {
  /** Whether the script has reached a cue in the current loop. */
  readonly reached: (id: string) => boolean;
  /** Changes on every loop so components can remount their entrance state. */
  readonly loop: number;
  /** Elapsed milliseconds in the current loop, updated every frame without re-rendering. */
  readonly elapsed: MotionValue<number>;
  readonly durationMs: number;
  readonly playing: boolean;
  /** The reader paused playback. */
  readonly paused: boolean;
  /** Reduced motion: the demo holds one frame, and `seek` chooses which. */
  readonly still: boolean;
  readonly toggle: () => void;
  readonly seek: (ms: number) => void;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Server HTML always starts in motion; the client switches to the still frame after hydrating. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

const captureMode = () =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture");

/**
 * How long a demo may go without a new beat. A visitor gives a demo a few seconds: its first beat
 * lands right after it starts playing, no beat waits long for the next, and the final frame
 * holds only long enough to register before the story plays again.
 */
export const PACING = { firstBeatMs: 800, holdMs: 2000, tailMs: 2500 } as const;

/** Where a script leaves the viewer waiting, in words; empty when it keeps moving. */
export function pacingIssues(script: TimelineScript): string[] {
  const cues = [...script.cues].sort((a, b) => a.at - b.at);
  const issues: string[] = [];
  const firstAt = cues[0]?.at ?? script.durationMs;
  if (firstAt > PACING.firstBeatMs) issues.push(`first beat at ${firstAt} ms`);
  for (let index = 1; index < cues.length; index += 1) {
    const hold = cues[index]!.at - cues[index - 1]!.at;
    if (hold > PACING.holdMs) issues.push(`waits ${hold} ms after ${cues[index - 1]!.id}`);
  }
  const tail = script.durationMs - (cues.at(-1)?.at ?? 0);
  if (tail > PACING.tailMs) issues.push(`holds its last frame for ${tail} ms`);
  return issues;
}

/** The index of the last cue at or before `ms`; cues are sorted by time. */
export function cueIndexAt(cues: readonly Cue[], ms: number): number {
  let index = -1;
  for (let at = 0; at < cues.length; at += 1) {
    if (cues[at]!.at > ms) break;
    index = at;
  }
  return index;
}

/**
 * Drives a scripted demo from one clock. React state changes only when a cue is crossed, so a
 * demo re-renders a handful of times per loop; continuous motion reads `elapsed` directly.
 * Reduced motion holds the final frame until a seek picks another. `?capture` plays once from
 * the start for recording.
 * Playback runs only while `root` is on screen.
 */
export function useTimeline(
  script: TimelineScript,
  root: React.RefObject<HTMLElement | null>,
): Timeline {
  const cues = useMemo(() => [...script.cues].sort((a, b) => a.at - b.at), [script.cues]);
  const elapsed = useMotionValue(0);
  const [playedIndex, setIndex] = useState(-1);
  const [loop, setLoop] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const clock = useRef(0);
  const [capture] = useState(captureMode);
  const still = useReducedMotion() && !capture;
  const [stillAt, setStillAt] = useState<number | null>(null);
  const index = still ? cueIndexAt(cues, stillAt ?? script.durationMs) : playedIndex;

  useEffect(() => {
    if (still) elapsed.set(stillAt ?? script.durationMs);
  }, [elapsed, script.durationMs, still, stillAt]);

  useEffect(() => {
    const node = root.current;
    if (!node || capture) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.25 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [capture, root]);

  useEffect(() => {
    if (!capture) return;
    let resolve = () => {};
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const handle: CaptureHandle = { durationMs: script.durationMs, done };
    window.__nodexCapture = handle;
    const stop = elapsed.on("change", (value) => {
      if (value >= script.durationMs) resolve();
    });
    return stop;
  }, [capture, elapsed, script.durationMs]);

  const active = !still && playing && (visible || capture);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // A background tab or a long frame must not skip half the story.
      const delta = Math.min(now - last, 64);
      last = now;
      let next = clock.current + delta;
      if (next >= script.durationMs) {
        if (capture) {
          clock.current = script.durationMs;
          elapsed.set(script.durationMs);
          return;
        }
        next = 0;
        setLoop((value) => value + 1);
      }
      clock.current = next;
      elapsed.set(next);
      setIndex(cueIndexAt(cues, next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, capture, cues, elapsed, script.durationMs]);

  const reached = useCallback(
    (id: string) => {
      const at = cues.findIndex((cue) => cue.id === id);
      return at !== -1 && at <= index;
    },
    [cues, index],
  );

  const seek = useCallback(
    (ms: number) => {
      const target = Math.max(0, Math.min(ms, script.durationMs - 1));
      if (still) {
        setStillAt(target);
        return;
      }
      if (target < clock.current) setLoop((value) => value + 1);
      clock.current = target;
      elapsed.set(target);
      setIndex(cueIndexAt(cues, target));
      setPlaying(true);
    },
    [cues, elapsed, script.durationMs, still],
  );

  return {
    reached,
    loop,
    elapsed,
    durationMs: script.durationMs,
    playing: active,
    paused: !playing,
    still,
    toggle: () => setPlaying((value) => !value),
    seek,
  };
}

/** Text that types itself out from `start`, one character every `msPerChar`, driven by the clock. */
export function useTyped(
  elapsed: MotionValue<number>,
  text: string,
  start: number,
  msPerChar = 18,
): MotionValue<string> {
  return useTransform(elapsed, (t) =>
    t < start ? "" : text.slice(0, Math.floor((t - start) / msPerChar) + 1),
  );
}
