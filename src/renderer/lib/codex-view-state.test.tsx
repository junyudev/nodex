import { act, useLayoutEffect, useRef } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { useMotionValue } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import { useCodexAnimatedPanelState } from "./codex-panel-motion";
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

describe("codex panel motion", () => {
  interface PanelCommit {
    open: boolean;
    contentPresent: boolean;
  }

  function Panel({
    open,
    reducedMotion = false,
    onCommit,
  }: {
    open: boolean;
    reducedMotion?: boolean;
    onCommit: (commit: PanelCommit) => void;
  }) {
    const root = useRef<HTMLDivElement>(null);
    const targetSize = useMotionValue(300);
    const panel = useCodexAnimatedPanelState({ open, targetSize, reducedMotion });
    useLayoutEffect(() => {
      onCommit({ open, contentPresent: Boolean(root.current?.firstElementChild) });
    });
    return <div ref={root}>{panel.mounted ? <button>Panel content</button> : null}</div>;
  }

  describe("animated panel content lifetime", () => {
    test("snaps a reset and reduced-motion close without retaining animation activity", async () => {
      const { result, rerender } = renderHook(
        ({ open, reducedMotion, resetKey }) => {
          const targetSize = useMotionValue(300);
          return useCodexAnimatedPanelState({ open, reducedMotion, resetKey, targetSize });
        },
        { initialProps: { open: false, reducedMotion: false, resetKey: 0 } },
      );
      rerender({ open: true, reducedMotion: false, resetKey: 0 });
      expect(result.current.mounted).toBe(true);
      expect(result.current.animating).toBe(true);
      rerender({ open: false, reducedMotion: false, resetKey: 1 });
      expect(result.current.mounted).toBe(false);
      expect(result.current.animating).toBe(false);
      rerender({ open: true, reducedMotion: true, resetKey: 1 });
      expect(result.current.mounted).toBe(true);
      expect(result.current.animating).toBe(false);
      rerender({ open: false, reducedMotion: true, resetKey: 1 });
      expect(result.current.mounted).toBe(false);
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.animating).toBe(false);
    });

    test.each([false, true])(
      "mounts an opening panel in the same commit as its open intent (reduced motion: %s)",
      async (reducedMotion) => {
        const commits: PanelCommit[] = [];
        const onCommit = (commit: PanelCommit) => commits.push(commit);
        const view = render(
          <Panel open={false} reducedMotion={reducedMotion} onCommit={onCommit} />,
        );
        expect(screen.queryByRole("button", { name: "Panel content" })).toBeNull();

        await act(async () => {
          view.rerender(<Panel open reducedMotion={reducedMotion} onCommit={onCommit} />);
        });

        expect(commits.find((commit) => commit.open)).toEqual({
          open: true,
          contentPresent: true,
        });
        expect(screen.getByRole("button", { name: "Panel content" })).toBeTruthy();
      },
    );

    test("retains content through the closing commit, then removes it", async () => {
      const commits: PanelCommit[] = [];
      const onCommit = (commit: PanelCommit) => commits.push(commit);
      const view = render(<Panel open onCommit={onCommit} />);

      await act(async () => {
        view.rerender(<Panel open={false} onCommit={onCommit} />);
      });

      expect(commits.find((commit) => !commit.open)).toEqual({
        open: false,
        contentPresent: true,
      });
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Panel content" })).toBeNull();
      });
    });
  });
});

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
