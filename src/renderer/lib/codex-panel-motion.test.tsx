import { act, useLayoutEffect, useRef } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { useMotionValue } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import { useCodexAnimatedPanelState } from "./codex-panel-motion";

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
      const view = render(<Panel open={false} reducedMotion={reducedMotion} onCommit={onCommit} />);
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
