import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
import { useMotionValue } from "motion/react";
import { expect, test, vi } from "vite-plus/test";
import { useMotionValueState } from "@/lib/resize-observer-motion-values";
import { useWorkbenchChromeLayout } from "./use-workbench-chrome-layout";

function ChromeGeometryFixture({
  applicationMenu = false,
  sessionId = null,
}: {
  applicationMenu?: boolean;
  sessionId?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const animatedWidth = useMotionValue(300);
  const targetWidth = useMotionValue(300);
  const {
    safeHeaderLeftWidth,
    workspaceHeaderLeft,
    effectiveHeaderLeftWidth,
    rightPanelRequestedWidth,
    bottomPanelRequestedHeight,
  } = useWorkbenchChromeLayout({
    activeSessionId: sessionId,
    destinationRouteOpen: false,
    bottomPanelOpen: false,
    bottomPanelRequestedHeight: null,
    headerLeftWidth: 0,
    isMacPlatform: !applicationMenu,
    applicationMenuBarEnabled: applicationMenu,
    reducedMotion: true,
    rightPanelFullWidth: false,
    rightPanelFullView: false,
    rightPanelSide: "right",
    rightPanelOpen: false,
    rightPanelRequestedWidth: null,
    rootRef,
    sidebarLogicalCollapsed: false,
    sidebarMotion: { animatedWidth, mounted: true, targetWidth },
    sidebarOpen: true,
  });
  const requestedRightWidth = useMotionValueState(rightPanelRequestedWidth);
  const requestedBottomHeight = useMotionValueState(bottomPanelRequestedHeight);
  return (
    <div ref={rootRef} style={{ "--codex-window-zoom": 1 } as CSSProperties}>
      <button
        type="button"
        onClick={() => {
          rightPanelRequestedWidth.set(550);
          bottomPanelRequestedHeight.set(400);
        }}
      >
        Resize panels
      </button>
      <output aria-label="Requested right width">{requestedRightWidth}</output>
      <output aria-label="Requested bottom height">{requestedBottomHeight}</output>
      <output aria-label="Native controls inset">{safeHeaderLeftWidth}</output>
      <output aria-label="Workspace header start">{workspaceHeaderLeft.get()}</output>
      <output aria-label="Workspace header padding">{effectiveHeaderLeftWidth}</output>
    </div>
  );
}

test("native controls retain their physical reservation when page zoom changes", async () => {
  const originalApi = window.api;
  let nativeZoom = 1;
  window.api = {
    invoke: async () => undefined,
    on: () => () => undefined,
    ...originalApi,
    getWindowZoomFactor: () => nativeZoom,
  };
  const userAgent = vi
    .spyOn(navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  try {
    const view = render(<ChromeGeometryFixture />);
    const inset = view.getByRole("status", { name: "Native controls inset" });
    expect(Number(inset.textContent)).toBe(88);

    await act(async () => {
      nativeZoom = 0.8;
      fireEvent.resize(window);
      await Promise.resolve();
    });
    await waitFor(() => expect(Number(inset.textContent)).toBe(108.5));

    await act(async () => {
      nativeZoom = 1.25;
      fireEvent.resize(window);
      await Promise.resolve();
    });
    await waitFor(() => expect(Number(inset.textContent)).toBe(71.6));
  } finally {
    window.api = originalApi;
    userAgent.mockRestore();
  }
});

test("Windows starts the header at the content column with ordinary padding", async () => {
  const view = render(<ChromeGeometryFixture applicationMenu />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.getByRole("status", { name: "Workspace header start" }).textContent).toBe("352");
  expect(view.getByRole("status", { name: "Workspace header padding" }).textContent).toBe("8");
});

test("resets live panel sizes when the selected Session changes with equal persisted sizes", async () => {
  const view = render(<ChromeGeometryFixture sessionId="first" />);
  const right = view.getByRole("status", { name: "Requested right width" });
  const bottom = view.getByRole("status", { name: "Requested bottom height" });
  const initialRight = right.textContent;
  const initialBottom = bottom.textContent;
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Resize panels" }));
    await Promise.resolve();
  });
  expect(right.textContent).toBe("550");
  expect(bottom.textContent).toBe("400");
  view.rerender(<ChromeGeometryFixture sessionId="first" />);
  expect(right.textContent).toBe("550");
  view.rerender(<ChromeGeometryFixture sessionId="second" />);
  await waitFor(() => {
    expect(right.textContent).toBe(initialRight);
    expect(bottom.textContent).toBe(initialBottom);
  });
});
