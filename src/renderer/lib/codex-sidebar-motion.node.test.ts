import { describe, expect, test } from "vite-plus/test";
import {
  resolveCodexSidebarMotionMounted,
  resolveCodexSidebarMotionSetOpen,
  shouldCommitCodexSidebarMotionCompletion,
} from "./codex-sidebar-motion";

describe("Codex sidebar motion controller helpers", () => {
  test("keeps the inline sidebar mounted while closing progress is still visible", () => {
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: true, progress: 0 })).toBe(true);
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: false, progress: 0.25 })).toBe(true);
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: false, progress: 0 })).toBe(false);
  });

  test("snaps reduced-motion and animate false updates to the target progress", () => {
    const reducedMotionResolution = resolveCodexSidebarMotionSetOpen({
      nextOpen: true,
      animate: true,
      reducedMotion: true,
    });
    expect(reducedMotionResolution.targetProgress).toBe(1);
    expect(reducedMotionResolution.shouldAnimate).toBe(false);

    const nonAnimatedResolution = resolveCodexSidebarMotionSetOpen({
      nextOpen: false,
      animate: false,
      reducedMotion: false,
    });
    expect(nonAnimatedResolution.targetProgress).toBe(0);
    expect(nonAnimatedResolution.shouldAnimate).toBe(false);
  });

  test("ignores stale animation completions after a newer toggle generation starts", () => {
    expect(
      shouldCommitCodexSidebarMotionCompletion({
        completionGeneration: 3,
        currentGeneration: 4,
      }),
    ).toBe(false);
    expect(
      shouldCommitCodexSidebarMotionCompletion({
        completionGeneration: 4,
        currentGeneration: 4,
      }),
    ).toBe(true);
  });
});
