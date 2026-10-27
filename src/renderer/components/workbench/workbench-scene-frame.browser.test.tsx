import { render, waitFor } from "@testing-library/react";
import { motionValue } from "motion/react";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { AppShellMainContentLayout } from "@/lib/codex-panel-motion";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { WorkbenchSceneFrame } from "./workbench-scene-frame";
import "@/globals.css";

installRendererThemeFixture();

async function expectVisibleFade(fade: HTMLElement) {
  await waitFor(() => {
    expect(getComputedStyle(fade).opacity).toBe("1");
    expect(fade.getAnimations()).toHaveLength(0);
  });
}

function frame({
  sidebarWidth = 0,
  panelWidth = 0,
  primaryHidden = false,
  layout = "thread-edge-scroll",
}: {
  readonly sidebarWidth?: number;
  readonly panelWidth?: number;
  readonly primaryHidden?: boolean;
  readonly layout?: AppShellMainContentLayout;
} = {}) {
  return (
    <div style={{ display: "flex", width: "112rem", height: 480 }}>
      <aside style={{ width: sidebarWidth, flexShrink: 0 }} />
      <WorkbenchSceneFrame
        ownerKey="session:test"
        primary={<div>Transcript</div>}
        primaryTestId="session-thread-page"
        primaryHidden={primaryHidden}
        layout={{
          appShellMainContentLayout: layout,
          rightPanelTargetWidth: motionValue(panelWidth),
          bottomPanelHeight: motionValue(0),
          rightPanel: {
            mounted: panelWidth > 0,
            open: panelWidth > 0,
            fullWidth: primaryHidden,
            opacity: motionValue(1),
            animatedSize: motionValue(panelWidth),
            content: <div>Side panel</div>,
          },
          bottomPanel: {
            mounted: false,
            open: false,
            opacity: motionValue(0),
            animatedSize: motionValue(0),
            content: null,
          },
        }}
        chrome={{
          bottomPanelGlobalHeaderControls: null,
          setRightPanelComposerOverlayTarget: vi.fn(),
          resizeRightPanel: vi.fn(),
          resizeBottomPanel: vi.fn(),
        }}
      />
    </div>
  );
}

test("keeps the thread top fade visible as sidebar and panel widths cross the header breakpoint", async () => {
  await page.viewport(2200, 800);
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const view = render(frame());
  const viewport = view.getByTestId("session-thread-page");
  const fade = viewport.querySelector<HTMLElement>("[data-app-shell-main-content-top-fade]");
  if (!fade) throw new Error("Expected the thread top fade");

  expect(viewport.getBoundingClientRect().width).toBeGreaterThan(96 * rem);
  await expectVisibleFade(fade);
  expect(fade.getBoundingClientRect().height).toBe(40);
  expect(getComputedStyle(fade).pointerEvents).toBe("none");

  view.rerender(frame({ sidebarWidth: 18 * rem }));
  expect(viewport.getBoundingClientRect().width).toBeLessThan(96 * rem);
  await expectVisibleFade(fade);

  view.rerender(frame({ sidebarWidth: 18 * rem, panelWidth: 24 * rem }));
  expect(viewport.getBoundingClientRect().width).toBeLessThan(96 * rem);
  await expectVisibleFade(fade);

  view.rerender(frame());
  expect(viewport.getBoundingClientRect().width).toBeGreaterThan(96 * rem);
  await expectVisibleFade(fade);
});

test("keeps the top fade within the hidden primary viewport when the panel fills the scene", async () => {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const view = render(frame({ panelWidth: 112 * rem, primaryHidden: true }));
  const viewport = view.getByTestId("session-thread-page");
  const fade = viewport.querySelector<HTMLElement>("[data-app-shell-main-content-top-fade]");
  if (!fade) throw new Error("Expected the thread top fade");

  expect(viewport.getBoundingClientRect().width).toBe(0);
  expect(fade.getBoundingClientRect().width).toBe(0);
});

test("hides the top fade in the browser window", async () => {
  applyRendererThemeForTest("light", { windowType: "browser" });
  const view = render(frame());
  const fade = view.container.querySelector<HTMLElement>("[data-app-shell-main-content-top-fade]");
  if (!fade) throw new Error("Expected the thread top fade");

  expect(getComputedStyle(fade).display).toBe("none");
});

test.each(["default", "full-bleed"] as const)(
  "preserves the hidden thread fade on the existing %s non-thread layout",
  async (layout) => {
    const view = render(frame({ layout }));
    const fade = view.container.querySelector<HTMLElement>(
      "[data-app-shell-main-content-top-fade]",
    );
    if (!fade) throw new Error("Expected the main-content top fade");
    await waitFor(() => expect(getComputedStyle(fade).opacity).toBe("0"));
  },
);
