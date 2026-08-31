import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "../../test/dom";
import { BrowserSidebarRuntimeSynchronizer } from "./browser-sidebar-runtime-synchronizer";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("./browser-sidebar-hidden-webview-hosts", () => ({
  BrowserSidebarBrowserUseWebviewHosts: () => (
    <div data-testid="browser-use-global-webview-hosts" />
  ),
}));

vi.mock("./browser-sidebar-renderer-state-store", () => ({
  refreshBrowserSidebarRendererStateStore: mocks.refresh,
  startBrowserSidebarRendererStateStore: mocks.start,
}));

describe("BrowserSidebarRuntimeSynchronizer", () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.start.mockReset();
    mocks.stop.mockClear();
    mocks.start.mockReturnValue(mocks.stop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("owns Browser Use hosts globally and resynchronizes them when the window returns", async () => {
    const resyncAttachedHosts = vi.spyOn(
      browserSidebarRendererWebviewManager,
      "resyncAttachedHosts",
    );
    const view = render(<BrowserSidebarRuntimeSynchronizer />);
    await settleAsyncRender();

    expect(view.getByTestId("browser-use-global-webview-hosts")).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledOnce();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(resyncAttachedHosts).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
