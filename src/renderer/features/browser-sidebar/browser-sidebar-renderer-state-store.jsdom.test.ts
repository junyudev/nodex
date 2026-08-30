import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  BrowserSidebarRuntimeSnapshot,
  BrowserSidebarStateSnapshot,
} from "../../../shared/browser-sidebar";
import {
  browserSidebarRendererStateStore,
  resetBrowserSidebarRendererStateStoreForTests,
  startBrowserSidebarRendererStateStore,
} from "./browser-sidebar-renderer-state-store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  invoke: mocks.invoke,
}));

describe("browserSidebarRendererStateStore", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    resetBrowserSidebarRendererStateStoreForTests();
  });

  test("does not let a late bootstrap overwrite a newer live snapshot", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: mocks.invoke,
        on: (channel: string, handler: (payload: unknown) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    });
    let resolveBootstrap: ((snapshot: BrowserSidebarRuntimeSnapshot) => void) | undefined;
    mocks.invoke.mockReturnValue(
      new Promise<BrowserSidebarRuntimeSnapshot>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );

    const stop = startBrowserSidebarRendererStateStore();
    const liveState = {
      tabs: [{ browserTabId: "live-page" }],
    } as unknown as BrowserSidebarStateSnapshot;
    handlers.get("browser-sidebar-state")?.(liveState);

    resolveBootstrap?.({
      state: {
        tabs: [{ browserTabId: "stale-page" }],
      } as unknown as BrowserSidebarStateSnapshot,
      browserUseState: {
        tabs: [],
        activeBrowserTabIdsByConversationScope: {},
        cursors: [],
      },
      presentationRequests: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(browserSidebarRendererStateStore.getSnapshot().state).toBe(liveState);
    stop();
  });
});
