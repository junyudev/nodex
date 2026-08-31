import type { TargetAndTransition, Transition } from "motion/react";

export const CODEX_THREAD_ACCORDION_TRANSITION: Transition = {
  duration: 0.3,
  ease: [0.19, 1, 0.22, 1],
};

export const CODEX_THREAD_DIVIDER_ENTER_INITIAL: TargetAndTransition = {
  opacity: 0,
  height: 0,
};

export const CODEX_THREAD_DIVIDER_ENTER_ANIMATE: TargetAndTransition = {
  opacity: 1,
  height: "auto",
};

export const CODEX_THREAD_DIVIDER_EXIT: TargetAndTransition = {
  opacity: 0,
  height: 0,
};

/** Historical agent work stays mounted through its bounded exit animation. */
export function resolveCodexThreadAgentBodyMotion(reducedMotion: boolean) {
  const collapsed = {
    height: reducedMotion ? "auto" : 0,
    opacity: 0,
    overflow: "hidden",
    transform: reducedMotion ? "translateY(0)" : "translateY(-8px)",
  } satisfies TargetAndTransition;

  return {
    initial: collapsed,
    animate: {
      height: "auto",
      opacity: 1,
      transform: "translateY(0)",
      transitionEnd: { overflow: "visible" },
    } satisfies TargetAndTransition,
    exit: {
      ...collapsed,
      transition: {
        duration: 0.15,
        ease: [0.23, 1, 0.32, 1],
      },
    } satisfies TargetAndTransition,
    transition: {
      duration: reducedMotion ? 0.12 : 0.22,
      ease: [0.33, 1, 0.68, 1],
    } satisfies Transition,
  };
}
