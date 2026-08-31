import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_THREAD_ACCORDION_TRANSITION,
  CODEX_THREAD_DIVIDER_ENTER_ANIMATE,
  CODEX_THREAD_DIVIDER_ENTER_INITIAL,
  CODEX_THREAD_DIVIDER_EXIT,
  resolveCodexThreadAgentBodyMotion,
} from "./thread-motion";

describe("thread motion contract", () => {
  test("matches Codex Electron accordion timing", () => {
    expect(CODEX_THREAD_ACCORDION_TRANSITION.duration).toBe(0.3);
    expect(
      Array.isArray(CODEX_THREAD_ACCORDION_TRANSITION.ease)
        ? CODEX_THREAD_ACCORDION_TRANSITION.ease.join(",")
        : "",
    ).toBe("0.19,1,0.22,1");
  });

  test("uses the Codex Electron divider reveal shape", () => {
    expect(CODEX_THREAD_DIVIDER_ENTER_INITIAL.opacity).toBe(0);
    expect(CODEX_THREAD_DIVIDER_ENTER_INITIAL.height).toBe(0);
    expect(CODEX_THREAD_DIVIDER_ENTER_ANIMATE.opacity).toBe(1);
    expect(CODEX_THREAD_DIVIDER_ENTER_ANIMATE.height).toBe("auto");
    expect(CODEX_THREAD_DIVIDER_EXIT.opacity).toBe(0);
    expect(CODEX_THREAD_DIVIDER_EXIT.height).toBe(0);
  });

  test("uses the historical agent-body enter and exit motion contract", () => {
    const motion = resolveCodexThreadAgentBodyMotion(false);

    expect(motion.initial).toEqual({
      height: 0,
      opacity: 0,
      overflow: "hidden",
      transform: "translateY(-8px)",
    });
    expect(motion.animate).toEqual({
      height: "auto",
      opacity: 1,
      transform: "translateY(0)",
      transitionEnd: { overflow: "visible" },
    });
    expect(motion.exit).toEqual({
      height: 0,
      opacity: 0,
      overflow: "hidden",
      transform: "translateY(-8px)",
      transition: {
        duration: 0.15,
        ease: [0.23, 1, 0.32, 1],
      },
    });
    expect(motion.transition).toEqual({
      duration: 0.22,
      ease: [0.33, 1, 0.68, 1],
    });
  });

  test("removes translation and shortens the enter under reduced motion", () => {
    const motion = resolveCodexThreadAgentBodyMotion(true);

    expect(motion.initial).toEqual({
      height: "auto",
      opacity: 0,
      overflow: "hidden",
      transform: "translateY(0)",
    });
    expect(motion.exit.height).toBe("auto");
    expect(motion.exit.transform).toBe("translateY(0)");
    expect(motion.transition.duration).toBe(0.12);
  });
});
