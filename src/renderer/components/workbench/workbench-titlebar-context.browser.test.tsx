import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { resolveFocusedPanelTabCycleScope } from "@/lib/workbench-panel-shortcut-scope";
import { WorkbenchPaneTitlebar, WorkbenchTitlebarProvider } from "./workbench-titlebar-context";
import "../../globals.css";

beforeEach(async () => {
  // The 800px desktop fixture reaches 1000px at its largest tested zoom.
  await page.viewport(1200, 800);
});

function TitlebarFixture({
  sidebarWidth,
  zoom,
  translateX = 0,
  active = true,
  onToggle,
}: {
  readonly sidebarWidth: number;
  readonly zoom: number;
  readonly translateX?: number;
  readonly active?: boolean;
  readonly onToggle?: () => void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div style={{ position: "relative", width: 800, height: 400, zoom }}>
      <div
        ref={setHost}
        data-testid="titlebar-host"
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 44 }}
      >
        <button
          type="button"
          onClick={onToggle}
          style={{ position: "absolute", top: 0, right: 0, height: 44 }}
        >
          Pane toggle
        </button>
      </div>
      <WorkbenchTitlebarProvider host={host} active={active}>
        <div style={{ display: "flex", paddingTop: 44 }}>
          <div style={{ width: sidebarWidth, flexShrink: 0 }} />
          <div
            data-testid="pane"
            data-app-shell-focus-area="right-panel"
            data-panel-group-leaf-id="leaf:editor"
            style={{ flex: 1, minWidth: 0, transform: `translateX(${translateX}px)` }}
          >
            <WorkbenchPaneTitlebar enabled>
              <div style={{ height: 44 }}>
                <button type="button">Editor tab</button>
              </div>
            </WorkbenchPaneTitlebar>
            <div data-testid="pane-body" style={{ height: 100 }} />
          </div>
        </div>
      </WorkbenchTitlebarProvider>
    </div>
  );
}

test("pane titlebar tracks scaled resize and movement without reserving content height", async () => {
  const onToggle = vi.fn();
  const view = render(<TitlebarFixture sidebarWidth={180} zoom={1.25} onToggle={onToggle} />);
  const host = view.getByTestId("titlebar-host");
  const pane = view.getByTestId("pane");
  const body = view.getByTestId("pane-body");
  const button = view.getByRole("button", { name: "Editor tab" });

  const expectAligned = async () => {
    await waitFor(() => {
      const chrome = host.querySelector<HTMLElement>("[data-workbench-pane-titlebar]");
      expect(chrome).not.toBeNull();
      if (!chrome) return;
      const chromeBounds = chrome.getBoundingClientRect();
      const paneBounds = pane.getBoundingClientRect();
      expect(chromeBounds.left).toBeCloseTo(paneBounds.left, 1);
      expect(chromeBounds.width).toBeCloseTo(paneBounds.width, 1);
      expect(chromeBounds.top).toBeCloseTo(host.getBoundingClientRect().top, 1);
      expect(body.getBoundingClientRect().top).toBeCloseTo(paneBounds.top, 1);
    });
  };

  await expectAligned();
  expect(host.contains(button)).toBe(true);
  expect(pane.contains(button)).toBe(false);
  expect(resolveFocusedPanelTabCycleScope(button)).toEqual({
    panelId: "right",
    leafId: "leaf:editor",
  });
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Pane toggle" }));
  });
  expect(onToggle).toHaveBeenCalledOnce();

  view.rerender(<TitlebarFixture sidebarWidth={260} zoom={1.25} />);
  await expectAligned();
  view.rerender(<TitlebarFixture sidebarWidth={260} zoom={0.8} translateX={34} />);
  await expectAligned();

  view.rerender(<TitlebarFixture sidebarWidth={260} zoom={0.8} active={false} />);
  expect(host.querySelector("[data-workbench-pane-titlebar]")).toBeNull();
  expect(pane.contains(view.getByRole("button", { name: "Editor tab" }))).toBe(true);
});

function ClippedTitlebarFixture({
  width,
  opacity,
  onSelect,
}: {
  readonly width: number;
  readonly opacity: number;
  readonly onSelect: (tab: string) => void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div style={{ position: "relative", width: 800, height: 200, opacity: 0.7 }}>
      <div ref={setHost} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 44 }} />
      <WorkbenchTitlebarProvider host={host}>
        <div style={{ paddingTop: 44, paddingLeft: 200 }}>
          <div style={{ width, overflow: "hidden", opacity }}>
            <div style={{ width: 400, opacity: 0.5 }}>
              <WorkbenchPaneTitlebar enabled>
                <div style={{ display: "flex", height: 44 }}>
                  {["Left", "Right"].map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      style={{ width: 180, height: 44, flexShrink: 0 }}
                      onClick={() => onSelect(tab)}
                    >
                      {tab} tab
                    </button>
                  ))}
                </div>
              </WorkbenchPaneTitlebar>
              <div style={{ height: 100 }} />
            </div>
          </div>
        </div>
      </WorkbenchTitlebarProvider>
    </div>
  );
}

test("portalled tabs retain the pane's animated horizontal clip and opacity", async () => {
  const onSelect = vi.fn();
  const view = render(<ClippedTitlebarFixture width={190} opacity={0.5} onSelect={onSelect} />);
  const left = view.getByRole("button", { name: "Left tab" });
  const right = view.getByRole("button", { name: "Right tab" });
  const chrome = left.closest<HTMLElement>("[data-workbench-pane-titlebar]");
  if (!chrome) throw new Error("Expected portalled pane chrome");
  const hitAtCenter = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
  };

  await waitFor(() => {
    expect(getComputedStyle(chrome).opacity).toBe("0.25");
    expect(hitAtCenter(left)).toBe(left);
    expect(hitAtCenter(right)).not.toBe(right);
  });
  await act(async () => {
    await userEvent.click(left);
  });
  expect(onSelect).toHaveBeenCalledWith("Left");

  view.rerender(<ClippedTitlebarFixture width={0} opacity={0} onSelect={onSelect} />);
  await waitFor(() => expect(getComputedStyle(chrome).visibility).toBe("hidden"));
  expect(hitAtCenter(left)).not.toBe(left);

  view.rerender(<ClippedTitlebarFixture width={400} opacity={1} onSelect={onSelect} />);
  await waitFor(() => expect(hitAtCenter(right)).toBe(right));
  await act(async () => {
    await userEvent.click(right);
  });
  expect(onSelect).toHaveBeenLastCalledWith("Right");
});
