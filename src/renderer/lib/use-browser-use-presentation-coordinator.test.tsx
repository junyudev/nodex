import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { makeWorkbenchPanelLayout } from "../../shared/workbench-panel-layout";
import type {
  BrowserSidebarTabSnapshot,
  BrowserUsePresentationRequest,
  BrowserUseTabState,
} from "../../shared/browser-sidebar";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { WorkbenchTabCreateInput, WorkbenchTabProjection } from "./types";
import { useBrowserUsePresentationCoordinator } from "./use-browser-use-presentation-coordinator";
import { makeSessionSceneFixture } from "../components/workbench/workbench-testkit/session-scene-fixture";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  invoke: vi.fn(async (...args: unknown[]) => {
    void args;
    return { ok: true };
  }),
  runtime: {
    state: { tabs: [] as BrowserSidebarTabSnapshot[] },
    browserUseState: {
      tabs: [] as BrowserUseTabState[],
      activeBrowserTabIdsByConversationScope: {},
      cursors: [],
    },
    presentationRequests: [] as BrowserUsePresentationRequest[],
  },
}));

vi.mock("@/features/browser-sidebar/browser-sidebar-renderer-state-store", () => ({
  consumeBrowserUsePresentationRequest: mocks.consume,
  useBrowserSidebarRendererState: () => mocks.runtime,
}));

vi.mock("./api", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

function makeSession(
  tabs: WorkbenchTabProjection[] = [],
  id = "session-1",
): WorkbenchSessionRenderProjection {
  const rightTabIds = tabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
  const bottomTabIds = tabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
  return {
    id,
    projectId: "project-1",
    noThreadFallbackTitle: "Thread",
    displayTitle: "Thread",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tabs,
    panels: {
      right: {
        collapsed: true,
        layout: makeWorkbenchPanelLayout(rightTabIds, rightTabIds[0] ?? null, "right-leaf"),
        size: { widthPx: 600 },
      },
      bottom: {
        collapsed: true,
        layout: makeWorkbenchPanelLayout(bottomTabIds, bottomTabIds[0] ?? null, "bottom-leaf"),
        size: { heightPx: 280 },
      },
    },
  };
}

function makeBrowserTab(
  id: string,
  browserTabId: string,
  panelId: "right" | "bottom",
): WorkbenchTabProjection {
  return {
    id,
    sessionId: "session-1",
    projectId: "project-1",
    panelId,
    title: "Browser",
    order: 0,
    stateKey: 0,
    state: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "browser",
    browserTabId,
    config: {
      projectId: "project-1",
      url: "https://example.com",
    },
  };
}

function sceneForSession(session: WorkbenchSessionRenderProjection) {
  return makeSessionSceneFixture(session);
}

describe("useBrowserUsePresentationCoordinator", () => {
  beforeEach(() => {
    mocks.consume.mockClear();
    mocks.invoke.mockClear();
    mocks.listeners.clear();
    mocks.runtime.presentationRequests = [];
    mocks.runtime.state.tabs = [];
    mocks.runtime.browserUseState.tabs = [];
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: (...args: unknown[]) => mocks.invoke(...args),
        on: (channel: string, listener: (payload: unknown) => void) => {
          mocks.listeners.set(channel, listener);
          return () => mocks.listeners.delete(channel);
        },
      },
    });
  });

  test("materializes and opens a runtime-only Browser page with its exact identity", async () => {
    const request: BrowserUsePresentationRequest = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      browserTabId: "browser-use:one",
      requestId: "request-1",
      codexSessionId: "session-1",
      projectId: "project-1",
      visible: true,
      transition: "default",
      source: "browser-use",
    };
    mocks.runtime.presentationRequests = [request];
    const createSessionViewTab = vi.fn(
      (input: WorkbenchTabCreateInput): WorkbenchTabProjection =>
        ({
          id: input.clientTabId ?? "created",
          sessionId: input.sessionId,
          projectId: input.kind === "browser" ? input.config.projectId : "project-1",
          panelId: input.panelId,
          title: input.title,
          order: 0,
          stateKey: 0,
          state: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          kind: "browser",
          browserTabId: input.kind === "browser" ? (input.browserTabId ?? "missing") : "missing",
          config: input.kind === "browser" ? input.config : { projectId: "project-1" },
        }) as WorkbenchTabProjection,
    );
    const setActivePanelTab = vi.fn(async () => undefined);

    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: makeSession(),
        catalog: {
          findById: () => null,
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select: () => undefined,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab: vi.fn(),
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab,
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab,
        windowSessionId: "window-1",
      }),
    );

    await waitFor(() => {
      expect(createSessionViewTab).toHaveBeenCalledWith(
        expect.objectContaining({
          browserTabId: "browser-use:one",
          panelId: "right",
        }),
      );
    });
    expect(setActivePanelTab).toHaveBeenCalledWith("right", "tab:browser-use:browser-use%3Aone", {
      leafId: "right-leaf",
      openPanel: true,
    });
    expect(mocks.consume).toHaveBeenCalledWith("request-1");
  });

  test("opens a Project Dock task before selecting its Session-owned Browser", async () => {
    const request: BrowserUsePresentationRequest = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      browserTabId: "browser-use:cross-task",
      requestId: "request-cross-task",
      codexSessionId: "session-1",
      projectId: "project-1",
      visible: true,
      transition: "none",
      source: "browser-use",
    };
    mocks.runtime.presentationRequests = [request];
    const target = makeSession();
    const createTab = vi.fn();
    const patchPanel = vi.fn();
    const select = vi.fn();

    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: null,
        catalog: {
          findById: () => ({
            domain: target,
            scene: sceneForSession(target),
          }),
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            activateTab: vi.fn(),
            createTab,
            patchPanel,
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab: vi.fn(),
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab: async () => undefined,
        windowSessionId: "window-1",
      }),
    );

    await waitFor(() => {
      expect(select).toHaveBeenCalledTimes(1);
    });
    expect(createTab).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        panelId: "right",
        tab: expect.objectContaining({
          kind: "browser",
          config: expect.objectContaining({
            browserTabId: "browser-use:cross-task",
          }),
        }),
      }),
    );
    expect(patchPanel).toHaveBeenCalledWith(target, "right", { collapsed: false });
    expect(createTab.mock.invocationCallOrder[0]).toBeLessThan(
      select.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  test("hides an inactive Session Browser without navigating away", async () => {
    const browserTab = makeBrowserTab("tab-hidden", "browser-use:hidden", "right");
    const base = makeSession([browserTab]);
    const target: WorkbenchSessionRenderProjection = {
      ...base,
      panels: {
        ...base.panels,
        right: { ...base.panels.right, collapsed: false },
      },
    };
    mocks.runtime.presentationRequests = [
      {
        browserConversationId: target.id,
        browserViewScopeId: "window-1",
        browserTabId: "browser-use:hidden",
        requestId: "request-hidden",
        codexSessionId: "thread-hidden",
        projectId: "project-1",
        visible: false,
        transition: "default",
        source: "browser-use",
      },
    ];
    const patchPanel = vi.fn();
    const select = vi.fn();

    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: null,
        catalog: {
          findById: () => ({
            domain: target,
            scene: sceneForSession(target),
          }),
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab: vi.fn(),
            patchPanel,
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab: vi.fn(),
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab: async () => undefined,
        windowSessionId: "window-1",
      }),
    );

    await waitFor(() => {
      expect(patchPanel).toHaveBeenCalledWith(target, "right", { collapsed: true });
    });
    expect(select).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "browser-sidebar-command",
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "accepted",
          requestId: "request-hidden",
        }),
      }),
    );
  });

  test("reuses an existing bottom Browser tab and preserves its placement", async () => {
    const request: BrowserUsePresentationRequest = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      browserTabId: "browser-use:existing",
      requestId: "request-existing",
      codexSessionId: "session-1",
      projectId: "project-1",
      visible: true,
      transition: "default",
      source: "browser-use",
    };
    mocks.runtime.presentationRequests = [request, request];
    const createSessionViewTab = vi.fn();
    const setActivePanelTab = vi.fn(async () => undefined);

    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: makeSession([
          makeBrowserTab("tab-existing", request.browserTabId, "bottom"),
        ]),
        catalog: {
          findById: () => null,
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select: () => undefined,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab: vi.fn(),
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab,
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab,
        windowSessionId: "window-1",
      }),
    );

    await waitFor(() => {
      expect(setActivePanelTab).toHaveBeenCalledWith("bottom", "tab-existing", {
        leafId: "bottom-leaf",
        openPanel: true,
      });
    });
    expect(setActivePanelTab).toHaveBeenCalledTimes(1);
    expect(createSessionViewTab).not.toHaveBeenCalled();
  });

  test("rejects a request owned by another window scope", async () => {
    mocks.runtime.presentationRequests = [
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-other",
        browserTabId: "browser-use:other-window",
        requestId: "request-other-window",
        codexSessionId: "session-1",
        projectId: "project-1",
        visible: true,
        transition: "default",
        source: "browser-use",
      },
    ];
    const createSessionViewTab = vi.fn();

    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: makeSession(),
        catalog: {
          findById: () => null,
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select: () => undefined,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab: vi.fn(),
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab,
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab: async () => undefined,
        windowSessionId: "window-1",
      }),
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        "browser-sidebar-command",
        expect.objectContaining({
          result: expect.objectContaining({
            outcome: "stale",
            requestId: "request-other-window",
          }),
        }),
      );
    });
    expect(createSessionViewTab).not.toHaveBeenCalled();
  });

  test("opens a runtime-only page from the thread summary without acknowledging a synthetic request", async () => {
    const createSessionViewTab = vi.fn(
      (input: WorkbenchTabCreateInput): WorkbenchTabProjection =>
        ({
          id: input.clientTabId ?? "created",
          sessionId: input.sessionId,
          projectId: "project-1",
          panelId: input.panelId,
          title: input.title,
          order: 0,
          stateKey: 0,
          state: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          kind: "browser",
          browserTabId: input.kind === "browser" ? (input.browserTabId ?? "missing") : "missing",
          config: input.kind === "browser" ? input.config : { projectId: "project-1" },
        }) as WorkbenchTabProjection,
    );
    const setActivePanelTab = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: makeSession(),
        catalog: {
          findById: () => null,
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select: () => undefined,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab: vi.fn(),
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab,
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab,
        windowSessionId: "window-1",
      }),
    );

    await act(async () => {
      await result.current.presentBrowserTab("browser-use:summary");
    });

    expect(createSessionViewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTabId: "browser-use:summary",
      }),
    );
    expect(setActivePanelTab).toHaveBeenCalledWith(
      "right",
      "tab:browser-use:browser-use%3Asummary",
      {
        leafId: "right-leaf",
        openPanel: true,
      },
    );
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  test("materializes a released runtime-only page but removes a truly closed shell", async () => {
    const createSessionViewTab = vi.fn();
    const removeTab = vi.fn();
    const browserTab = makeBrowserTab("tab-browser", "browser-use:lifecycle", "right");
    mocks.runtime.state.tabs = [
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-1",
        browserTabId: "browser-use:lifecycle",
        browserStorageId: "browser:use:browser-use:lifecycle",
        projectId: "project-1",
        webContentsId: 42,
        mountGeneration: 1,
        url: "https://example.com",
        title: "Example Domain",
        isLoading: false,
        isWaitingForResponse: false,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
        deviceToolbarVisible: false,
        viewport: {
          width: 390,
          height: 844,
          presetId: "responsive",
          zoomPercent: 100,
        },
        deviceToolbarState: {
          responsiveViewportSize: null,
          toolbarState: {
            isEnabled: false,
            presetId: "responsive",
            width: 390,
            height: 844,
          },
        },
        interactionMode: "browse",
        findState: {
          open: false,
          query: "",
          activeMatchOrdinal: null,
          matchCount: null,
          caseSensitive: false,
        },
        hasBrowserPage: true,
        pageActionsDisabled: false,
        presented: false,
        visible: false,
        lastSelectedAt: 1,
        audible: false,
        mediaActive: false,
        activeDownload: false,
        lifecycleState: "live-detached",
        updatedAt: 1,
      },
    ];
    const { rerender } = renderHook(
      ({ session }) =>
        useBrowserUsePresentationCoordinator({
          activeSession: session,
          catalog: {
            findById: () => null,
            prefetch: async () => null,
            resolveScene: () => {
              throw new Error("not used");
            },
            select: () => undefined,
          },
          controller: {
            previewTabsByPanel: {},
            durable: {
              createTab: vi.fn(),
              removeTab,
            },
          } as never,
          createSessionViewTab,
          pinPreviewTab: async () => undefined,
          setActivePanelCollapsed: async () => null,
          setActivePanelTab: async () => undefined,
          windowSessionId: "window-1",
        }),
      { initialProps: { session: makeSession() } },
    );
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      browserTabId: "browser-use:lifecycle",
    };

    await act(async () => {
      mocks.listeners.get("browser-sidebar-browser-use-page-released")?.(identity);
      await Promise.resolve();
    });
    expect(createSessionViewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTabId: "browser-use:lifecycle",
        presentation: "background",
        title: "Example Domain",
      }),
    );

    rerender({ session: makeSession([browserTab]) });
    await act(async () => {
      mocks.listeners.get("browser-sidebar-browser-use-page-closed")?.({
        ...identity,
        reason: "agent",
      });
      await Promise.resolve();
    });
    expect(removeTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      "tab-browser",
    );
  });

  test("retains a released page in an inactive Session without foreground presentation", async () => {
    const target = makeSession();
    const createTab = vi.fn();
    renderHook(() =>
      useBrowserUsePresentationCoordinator({
        activeSession: null,
        catalog: {
          findById: () => ({
            domain: target,
            scene: sceneForSession(target),
          }),
          prefetch: async () => null,
          resolveScene: () => {
            throw new Error("not used");
          },
          select: () => undefined,
        },
        controller: {
          previewTabsByPanel: {},
          durable: {
            createTab,
            removeTab: vi.fn(),
          },
        } as never,
        createSessionViewTab: vi.fn(),
        pinPreviewTab: async () => undefined,
        setActivePanelCollapsed: async () => null,
        setActivePanelTab: async () => undefined,
        windowSessionId: "window-1",
      }),
    );

    await act(async () => {
      mocks.listeners.get("browser-sidebar-browser-use-page-released")?.({
        browserConversationId: target.id,
        browserViewScopeId: "window-1",
        browserTabId: "browser-use:inactive-release",
      });
      await Promise.resolve();
    });

    expect(createTab).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        panelId: "right",
        presentation: "background",
      }),
    );
  });
});
