import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_SIDEBAR_FLOATING_PANEL_REDUCED_MOTION_TRANSITION,
  CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION,
  CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS,
  CODEX_SIDEBAR_FLOATING_OUTER_CLASS,
  CODEX_SIDEBAR_POINTER_DEFAULT,
  clampCodexSidebarWidth,
  deriveCodexSidebarFloatingVisibility,
  getCodexSidebarFloatingOuterClassName,
  getCodexSidebarFloatingTransition,
  isCodexSidebarExpandedMounted,
  isCodexSidebarKeepOpenX,
  normalizeCodexSidebarPointer,
  resolveCodexSidebarToggleTargetProgress,
  resolveCodexSidebarWidth,
  shouldAnimateCodexSidebarToggle,
  shouldCollapseCodexSidebarResizeWidth,
  shouldClearCodexSidebarHoverSuppression,
  shouldResetCodexSidebarPointerOnWindowMouseOut,
  shouldSuppressCodexSidebarHoverOpen,
} from "./codex-sidebar-auto-reveal";

describe("Codex sidebar auto-reveal contract", () => {
  test("clamps width to the Codex default/min/max contract", () => {
    expect(clampCodexSidebarWidth(Number.NaN)).toBe(288);
    expect(clampCodexSidebarWidth(120)).toBe(240);
    expect(clampCodexSidebarWidth(239)).toBe(240);
    expect(clampCodexSidebarWidth(300)).toBe(300);
    expect(clampCodexSidebarWidth(900)).toBe(520);
  });

  test("collapses expanded sidebar only below Codex half-minimum threshold", () => {
    expect(shouldCollapseCodexSidebarResizeWidth(119)).toBe(true);
    expect(shouldCollapseCodexSidebarResizeWidth(120)).toBe(false);
    expect(shouldCollapseCodexSidebarResizeWidth(239)).toBe(false);
  });

  test("resolves width with layout, Codex storage, Nodex storage, then default precedence", () => {
    expect(
      resolveCodexSidebarWidth({
        layoutSnapshotWidth: 260,
        codexStorageWidth: 320,
        nodexStorageWidth: 340,
      }),
    ).toBe(260);
    expect(
      resolveCodexSidebarWidth({
        codexStorageWidth: 320,
        nodexStorageWidth: 340,
      }),
    ).toBe(320);
    expect(
      resolveCodexSidebarWidth({
        nodexStorageWidth: 340,
      }),
    ).toBe(340);
    expect(resolveCodexSidebarWidth({})).toBe(288);
  });

  test("keeps the peek open only within the contextual sidebar horizontal bounds", () => {
    expect(isCodexSidebarKeepOpenX(null, 300)).toBe(false);
    expect(isCodexSidebarKeepOpenX(-1, 300)).toBe(false);
    expect(isCodexSidebarKeepOpenX(0, 300)).toBe(true);
    expect(isCodexSidebarKeepOpenX(300, 300)).toBe(true);
    expect(isCodexSidebarKeepOpenX(301, 300)).toBe(false);
  });

  test("keeps collapse suppression until both navigation and titlebar triggers are left", () => {
    expect(
      shouldClearCodexSidebarHoverSuppression({
        triggerHovered: false,
        navigationHovered: true,
      }),
    ).toBe(false);
    expect(
      shouldClearCodexSidebarHoverSuppression({
        triggerHovered: true,
        navigationHovered: false,
      }),
    ).toBe(false);
    expect(
      shouldClearCodexSidebarHoverSuppression({
        triggerHovered: false,
        navigationHovered: false,
      }),
    ).toBe(true);
  });

  test("derives floating visibility from navigation, open, animation, suppression, and focus", () => {
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 8,
        leftPanelWidthPx: 300,
        sidebarOpen: true,
        sidebarAnimating: false,
        hoverSuppressed: false,
        navigationHovered: true,
        focusOverride: false,
        currentlyVisible: false,
      }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 8,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: true,
        hoverSuppressed: false,
        navigationHovered: true,
        focusOverride: false,
        currentlyVisible: false,
      }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 8,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: false,
        hoverSuppressed: true,
        navigationHovered: true,
        focusOverride: true,
        currentlyVisible: false,
      }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 12,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: false,
        hoverSuppressed: false,
        navigationHovered: true,
        focusOverride: false,
        currentlyVisible: false,
      }),
    ).toBe(true);
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 301,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: false,
        hoverSuppressed: false,
        navigationHovered: false,
        focusOverride: false,
        currentlyVisible: true,
      }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 301,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: false,
        hoverSuppressed: false,
        navigationHovered: false,
        focusOverride: true,
        currentlyVisible: true,
      }),
    ).toBe(true);
  });

  test("keeps a floating sidebar visible while a portalled hover surface is active", () => {
    expect(
      deriveCodexSidebarFloatingVisibility({
        pointerX: 640,
        leftPanelWidthPx: 300,
        sidebarOpen: false,
        sidebarAnimating: false,
        hoverSuppressed: false,
        navigationHovered: false,
        focusOverride: false,
        hoverSurfaceActive: true,
        currentlyVisible: true,
      }),
    ).toBe(true);
  });

  test("content edges never open a hidden peek, while an open peek survives transfer from the rail", () => {
    const base = {
      leftPanelWidthPx: 300,
      sidebarOpen: false,
      sidebarAnimating: false,
      hoverSuppressed: false,
      navigationHovered: false,
      focusOverride: false,
    };
    expect(
      deriveCodexSidebarFloatingVisibility({ ...base, pointerX: 0, currentlyVisible: false }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({ ...base, pointerX: 12, currentlyVisible: false }),
    ).toBe(false);
    expect(
      deriveCodexSidebarFloatingVisibility({ ...base, pointerX: 150, currentlyVisible: true }),
    ).toBe(true);
    expect(
      deriveCodexSidebarFloatingVisibility({
        ...base,
        pointerX: null,
        navigationHovered: true,
        currentlyVisible: false,
      }),
    ).toBe(true);
  });

  test("derives Codex explicit toggle target progress and hover suppression", () => {
    expect(resolveCodexSidebarToggleTargetProgress(true)).toBe(1);
    expect(resolveCodexSidebarToggleTargetProgress(false)).toBe(0);
    expect(shouldSuppressCodexSidebarHoverOpen({ nextOpen: false })).toBe(true);
    expect(shouldSuppressCodexSidebarHoverOpen({ nextOpen: false, suppressHoverOpen: false })).toBe(
      false,
    );
    expect(shouldSuppressCodexSidebarHoverOpen({ nextOpen: true })).toBe(false);
  });

  test("snaps explicit sidebar toggles for reduced motion or animate false", () => {
    expect(shouldAnimateCodexSidebarToggle({ animate: true, reducedMotion: false })).toBe(true);
    expect(shouldAnimateCodexSidebarToggle({ reducedMotion: null })).toBe(true);
    expect(shouldAnimateCodexSidebarToggle({ animate: false, reducedMotion: false })).toBe(false);
    expect(shouldAnimateCodexSidebarToggle({ animate: true, reducedMotion: true })).toBe(false);
  });

  test("keeps the real sidebar mounted while closing progress remains above zero", () => {
    expect(isCodexSidebarExpandedMounted({ open: true, progress: 0 })).toBe(true);
    expect(isCodexSidebarExpandedMounted({ open: false, progress: 0.25 })).toBe(true);
    expect(isCodexSidebarExpandedMounted({ open: false, progress: 0 })).toBe(false);
    expect(isCodexSidebarExpandedMounted({ open: false, progress: Number.NaN })).toBe(false);
  });

  test("normalizes pointer coordinates and velocity by the Codex window zoom", () => {
    const first = normalizeCodexSidebarPointer(
      { clientX: 20, clientY: 10, updatedAt: 1000 },
      CODEX_SIDEBAR_POINTER_DEFAULT,
      2,
    );
    const second = normalizeCodexSidebarPointer(
      { clientX: 40, clientY: 30, updatedAt: 2000 },
      first,
      2,
    );

    expect(first.x).toBe(10);
    expect(first.y).toBe(5);
    expect(first.speed).toBe(0);
    expect(second.x).toBe(20);
    expect(second.y).toBe(15);
    expect(second.velocityX).toBe(10);
    expect(second.velocityY).toBe(10);
    expect(Math.round(second.speed)).toBe(14);
  });

  test("resets pointer on Codex window mouseout only when leaving the viewport", () => {
    expect(
      shouldResetCodexSidebarPointerOnWindowMouseOut({
        clientX: 10,
        clientY: 10,
        innerWidth: 800,
        innerHeight: 600,
        relatedTarget: document.body,
      }),
    ).toBe(false);
    expect(
      shouldResetCodexSidebarPointerOnWindowMouseOut({
        clientX: 10,
        clientY: 10,
        innerWidth: 800,
        innerHeight: 600,
        relatedTarget: null,
      }),
    ).toBe(false);
    expect(
      shouldResetCodexSidebarPointerOnWindowMouseOut({
        clientX: -1,
        clientY: 10,
        innerWidth: 800,
        innerHeight: 600,
        relatedTarget: null,
      }),
    ).toBe(true);
    expect(
      shouldResetCodexSidebarPointerOnWindowMouseOut({
        clientX: 800,
        clientY: 10,
        innerWidth: 800,
        innerHeight: 600,
        relatedTarget: null,
      }),
    ).toBe(true);
  });

  test("selects the Codex spring or reduced-motion transition", () => {
    expect(JSON.stringify(getCodexSidebarFloatingTransition(false))).toBe(
      JSON.stringify(CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION),
    );
    expect(JSON.stringify(getCodexSidebarFloatingTransition(true))).toBe(
      JSON.stringify(CODEX_SIDEBAR_FLOATING_PANEL_REDUCED_MOTION_TRANSITION),
    );
  });

  test("selects the Codex floating top inset for application menu windows", () => {
    expect(getCodexSidebarFloatingOuterClassName(false)).toBe(CODEX_SIDEBAR_FLOATING_OUTER_CLASS);
    expect(getCodexSidebarFloatingOuterClassName(true)).toBe(
      CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS,
    );
  });
});
