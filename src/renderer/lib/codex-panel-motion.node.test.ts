import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION,
  CODEX_SUMMARY_SHIFT_X,
  clampCodexPanelProgress,
  resolveCodexAnimatedPanelSize,
  resolveCodexHeaderEdgeScroll,
  resolveCodexMainContentTargetWidth,
  resolveCodexSummaryContentShift,
  resolveCodexSummaryPanelLayoutMode,
  shouldSnapCodexMotion,
} from "./codex-panel-motion";

describe("Codex panel motion helpers", () => {
  test("matches the Codex project folder fold transition", () => {
    expect(CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION.duration).toBe(0.5);
    expect(
      Array.isArray(CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION.ease)
        ? CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION.ease.join(",")
        : "",
    ).toBe("0.19,1,0.22,1");
  });

  test("clamps panel progress to the Codex 0..1 range", () => {
    expect(clampCodexPanelProgress(-0.5)).toBe(0);
    expect(clampCodexPanelProgress(0.42)).toBe(0.42);
    expect(clampCodexPanelProgress(1.5)).toBe(1);
    expect(clampCodexPanelProgress(Number.NaN)).toBe(0);
  });

  test("derives animated size from clamped progress and target size", () => {
    expect(resolveCodexAnimatedPanelSize(0, 600)).toBe(0);
    expect(resolveCodexAnimatedPanelSize(0.5, 600)).toBe(300);
    expect(resolveCodexAnimatedPanelSize(2, 600)).toBe(600);
    expect(resolveCodexAnimatedPanelSize(0.5, -1)).toBe(0);
  });

  test("matches Codex summary display breakpoints", () => {
    expect(resolveCodexSummaryPanelLayoutMode(1095)).toBe("overlay");
    expect(resolveCodexSummaryPanelLayoutMode(1096)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(1535)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(1536)).toBe("gutter");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 179 * 2)).toBe("overlay");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 180 * 2)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 399 * 2)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 400 * 2)).toBe("gutter");
  });

  test("derives Codex main content target width from shell panel reservations", () => {
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: false,
        leftSidebarWidth: 300,
        rightPanelOpen: false,
        rightPanelWidth: 600,
      }),
    ).toBe(1800);
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: true,
        leftSidebarWidth: 300,
        rightPanelOpen: true,
        rightPanelWidth: 500,
      }),
    ).toBe(1000);
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: true,
        leftSidebarWidth: 300,
        rightPanelOpen: true,
        rightPanelWidth: 500,
        rightPanelFullWidth: true,
      }),
    ).toBe(0);
  });

  test("matches Codex thread edge-scroll guards", () => {
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1535,
      }),
    ).toBe(false);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1536,
      }),
    ).toBe(true);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1536,
        rightPanelFullWidth: true,
      }),
    ).toBe(false);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "full-bleed",
        mainContentWidth: 1536,
      }),
    ).toBe(false);
  });

  test("applies Codex shift only for pinned shift mode", () => {
    expect(CODEX_SUMMARY_SHIFT_X).toBe(-158);
    expect(resolveCodexSummaryContentShift({ layoutMode: "shift", pinnedOpen: true })).toBe(-158);
    expect(resolveCodexSummaryContentShift({ layoutMode: "shift", pinnedOpen: false })).toBe(0);
    expect(resolveCodexSummaryContentShift({ layoutMode: "overlay", pinnedOpen: true })).toBe(0);
    expect(resolveCodexSummaryContentShift({ layoutMode: "gutter", pinnedOpen: true })).toBe(0);
  });

  test("snaps panel motion for reduced motion or explicit non-animated updates", () => {
    expect(shouldSnapCodexMotion(true, true)).toBe(true);
    expect(shouldSnapCodexMotion(false, false)).toBe(true);
    expect(shouldSnapCodexMotion(null, true)).toBe(false);
    expect(shouldSnapCodexMotion(false, true)).toBe(false);
  });
});
