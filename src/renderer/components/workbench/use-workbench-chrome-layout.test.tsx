import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
import { useMotionValue } from "motion/react";
import { expect, test, vi } from "vite-plus/test";
import { useWorkbenchChromeLayout } from "./use-workbench-chrome-layout";

function ChromeGeometryFixture() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const animatedWidth = useMotionValue(300);
  const targetWidth = useMotionValue(300);
  const { safeHeaderLeftWidth } = useWorkbenchChromeLayout({
    activeSessionId: null,
    destinationRouteOpen: false,
    bottomPanelOpen: false,
    bottomPanelRequestedHeight: null,
    headerLeftWidth: 0,
    isMacPlatform: true,
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
  return (
    <div ref={rootRef} style={{ "--codex-window-zoom": 1 } as CSSProperties}>
      <output aria-label="Native controls inset">{safeHeaderLeftWidth}</output>
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
