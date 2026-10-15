import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS,
  CODEX_SIDEBAR_FLOATING_OUTER_CLASS,
  clampCodexSidebarWidth,
  getCodexSidebarFloatingOuterClassName,
  isCodexSidebarExpandedMounted,
  resolveCodexSidebarToggleTargetProgress,
  resolveCodexSidebarWidth,
  shouldAnimateCodexSidebarToggle,
  shouldCollapseCodexSidebarResizeWidth,
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

  test("derives explicit toggle target progress", () => {
    expect(resolveCodexSidebarToggleTargetProgress(true)).toBe(1);
    expect(resolveCodexSidebarToggleTargetProgress(false)).toBe(0);
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

  test("selects the Codex floating top inset for application menu windows", () => {
    expect(getCodexSidebarFloatingOuterClassName(false)).toBe(CODEX_SIDEBAR_FLOATING_OUTER_CLASS);
    expect(getCodexSidebarFloatingOuterClassName(true)).toBe(
      CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS,
    );
  });
});
