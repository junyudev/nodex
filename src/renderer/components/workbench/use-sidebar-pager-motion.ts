import { animate, type AnimationPlaybackControls } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CODEX_SIDEBAR_DISCLOSURE_TRANSITION } from "@/lib/codex-panel-motion";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";

/** How long a held list waits for its rows to change before it lets go. */
const UNCHANGED_RELEASE_MS = 500;

interface HeldList {
  readonly clip: HTMLElement;
  readonly content: HTMLElement;
  readonly observer: ResizeObserver;
  animation: AnimationPlaybackControls | null;
  /** The clip is folding over rows that stay until it has passed them. */
  folding: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const heightOf = (element: HTMLElement) => element.getBoundingClientRect().height;

/**
 * The height motion of a paginated sidebar list's rows. A pager press holds the rows' clip at
 * its current height. Rows that Show more reveals mount at once and the clip unfolds over them
 * from the top; rows that Show less hides stay while the clip folds up past them, then leave.
 * The pager after the clip and whatever follows the list ride its edge, and rows a source
 * delivers while the clip is held join the same motion.
 *
 * `settled` is false while the list is still reading rows its depth asks for.
 */
export function useSidebarPagerMotion(settled: boolean) {
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useResolvedReducedMotion();
  const [motion] = useState(createSidebarPagerMotion);

  useEffect(() => motion.setSettled(settled), [motion, settled]);
  useEffect(() => motion.release, [motion]);

  /** Holds the list at its current height before a press changes its rows. */
  const hold = useCallback(() => {
    const clip = clipRef.current;
    const content = contentRef.current;
    return !reducedMotion && clip !== null && content !== null && motion.hold(clip, content);
  }, [motion, reducedMotion]);

  /** The height of the rows laid out now. */
  const contentHeight = useCallback(
    () => (contentRef.current ? heightOf(contentRef.current) : null),
    [],
  );

  return {
    clipRef,
    contentRef,
    hold,
    contentHeight,
    fold: motion.fold,
    interruptFold: motion.interruptFold,
  };
}

function createSidebarPagerMotion() {
  let held: HeldList | null = null;
  let settled = true;

  const release = () => {
    if (!held) return;
    const list = held;
    held = null;
    list.observer.disconnect();
    list.animation?.stop();
    if (list.releaseTimer !== null) clearTimeout(list.releaseTimer);
    list.clip.style.height = "";
    list.clip.style.overflow = "";
  };

  const clearReleaseTimer = (list: HeldList) => {
    if (list.releaseTimer === null) return;
    clearTimeout(list.releaseTimer);
    list.releaseTimer = null;
  };

  const ease = (list: HeldList, to: number, onDone: () => void) => {
    clearReleaseTimer(list);
    list.animation?.stop();
    const animation = animate(
      list.clip,
      { height: [`${heightOf(list.clip)}px`, `${to}px`] },
      CODEX_SIDEBAR_DISCLOSURE_TRANSITION,
    );
    list.animation = animation;
    void animation.finished.then(() => {
      if (held !== list || list.animation !== animation) return;
      list.animation = null;
      onDone();
    });
  };

  // Lets go once nothing moves and no rows are on their way. A change that landed before
  // its resize was observed starts its motion instead.
  const releaseWhenIdle = () => {
    if (!held || held.animation !== null || held.folding || !settled) return;
    if (Math.abs(heightOf(held.content) - heightOf(held.clip)) >= 0.5) follow();
    else release();
  };

  // Eases the clip from wherever it is now to the rows' current height.
  function follow() {
    const list = held;
    if (!list || list.folding) return;
    const to = heightOf(list.content);
    if (Math.abs(to - heightOf(list.clip)) < 0.5) {
      if (list.animation === null) releaseWhenIdle();
      return;
    }
    ease(list, to, releaseWhenIdle);
  }

  const hold = (clip: HTMLElement, content: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return false;
    // A list without layout, such as one inside a folded section, has nothing to move.
    if (!held && heightOf(clip) === 0 && heightOf(content) === 0) return false;
    if (!held) {
      clip.style.height = `${heightOf(clip)}px`;
      clip.style.overflow = "hidden";
      held = {
        clip,
        content,
        observer: new ResizeObserver(follow),
        animation: null,
        folding: false,
        releaseTimer: null,
      };
      held.observer.observe(content);
    }
    if (held.animation === null) {
      const list = held;
      clearReleaseTimer(list);
      list.releaseTimer = setTimeout(() => {
        list.releaseTimer = null;
        releaseWhenIdle();
      }, UNCHANGED_RELEASE_MS);
    }
    return true;
  };

  /** Folds the held clip to `height`, then lets the rows it covered leave through `onFolded`. */
  const fold = (height: number, onFolded: () => void) => {
    const list = held;
    if (!list) {
      onFolded();
      return;
    }
    list.folding = true;
    ease(list, height, () => {
      list.folding = false;
      onFolded();
      // The covered rows leave in the next commit; the clip already has their height.
      requestAnimationFrame(releaseWhenIdle);
    });
  };

  /** Stops a fold where it is, so another press can continue from there. */
  const interruptFold = () => {
    if (!held?.folding) return;
    held.animation?.stop();
    held.animation = null;
    held.folding = false;
  };

  const setSettled = (next: boolean) => {
    settled = next;
    if (next) releaseWhenIdle();
  };

  return { hold, fold, interruptFold, release, setSettled };
}
