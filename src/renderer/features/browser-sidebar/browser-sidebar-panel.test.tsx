import { afterEach, beforeAll, beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import type { MotionValue } from "motion/react";
import type {
  BrowserSidebarBrowserUseStateSnapshot,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarTabSnapshot,
  BrowserUseCursorState,
  BrowserUseTabState,
} from "../../../shared/browser-sidebar";
import type { WorkbenchTabProjection } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { render, settleAsyncRender } from "../../test/dom";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

let BrowserSidebarPanel: (typeof import("./browser-sidebar-panel"))["BrowserSidebarPanel"];
let invokeCalls: unknown[][] = [];
let apiListeners = new Map<string, Set<(payload: unknown) => void>>();

vi.mock("@/lib/api", () => ({
  invoke: async (channel: string, ...args: unknown[]) => {
    invokeCalls.push([channel, ...args]);
    if (channel === "browser-downloads-list") return { downloads: [] };
    return { ok: true };
  },
  subscribeBoardChanges: () => () => undefined,
  subscribeProjectSessionChanges: () => () => undefined,
  subscribeProjectChanges: () => () => undefined,
  subscribeCodexHostMessages: () => () => undefined,
  subscribeDesktopNotificationActions: () => () => undefined,
  subscribeAppUpdateStatus: () => () => undefined,
  getWindowFocusState: async () => true,
  subscribeWindowFocusChanges: () => () => undefined,
}));

vi.mock("@/lib/use-theme", () => ({
  useTheme: () => ({
    theme: "dark",
    resolved: "dark",
    setTheme: () => undefined,
  }),
}));

beforeAll(async () => {
  const module = await import("./browser-sidebar-panel");
  BrowserSidebarPanel = module.BrowserSidebarPanel;
});

beforeEach(() => {
  invokeCalls = [];
  apiListeners = new Map();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push([channel, ...args]);
        if (channel === "browser-downloads-list") return { downloads: [] };
        return { ok: true };
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        const listeners = apiListeners.get(channel) ?? new Set();
        listeners.add(listener);
        apiListeners.set(channel, listeners);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
});

afterEach(async () => {
  await act(async () => {
    browserSidebarRendererWebviewManager.disposeAll();
    await Promise.resolve();
  });
});

describe("BrowserSidebarPanel chrome", () => {
  test("renders address input inside a no-drag island within the draggable toolbar", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={browserTab}
        activeSession={activeSession}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [activeSession]}
      />,
    );

    const input = view.container.querySelector<HTMLInputElement>(
      "[data-browser-sidebar-address-input='true']",
    );
    expect(input === null).toBe(false);

    const toolbarRow = input?.closest(".draggable");
    expect(toolbarRow === null).toBe(false);

    const noDragIsland = input?.closest(".no-drag");
    expect(noDragIsland === null).toBe(false);

    const addressShell = input?.closest(".group\\/address-bar");
    expect(addressShell === null).toBe(false);
    await settleAsyncRender();
  });

  test("does not close the browser guest when the React panel unmounts", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
      />,
    );

    await settleAsyncRender();
    view.unmount();
    await settleAsyncRender();

    const commandTypes = invokeCalls
      .filter((call) => call[0] === "browser-sidebar-command")
      .map((call) => (call[1] as { type?: string } | undefined)?.type)
      .join(",");
    expect(commandTypes.includes("unregister-tab")).toBe(false);
    expect(commandTypes.includes("close-tab")).toBe(false);
  });

  test("reveals active Profile downloads and opens their management page", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [
          {
            ...activeSession,
            tabs: [loadedBrowserTab],
          },
        ]}
      />,
    );
    await settleAsyncRender();

    await emitApiEvent("browser-downloads-state", {
      downloads: [
        {
          id: "download-1",
          browserConversationId: "session-1",
          browserViewScopeId: "window-session-1",
          browserTabId: "tab-browser",
          fileName: "artifact.zip",
          savePath: "/tmp/artifact.zip",
          sourceOrigin: "https://example.com",
          status: "progressing",
          receivedBytes: 512,
          totalBytes: 1_024,
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    });

    const indicator = view.getByLabelText("1 active download");
    fireEvent.click(indicator);
    expect(view.getByText("Downloads") === null).toBe(false);
    expect(view.getByText("artifact.zip") === null).toBe(false);
  });

  test("accepts browser events only for the complete Window Session tab identity", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
      />,
    );
    await settleAsyncRender();

    const addressInput = view.container.querySelector<HTMLInputElement>(
      "[data-browser-sidebar-address-input='true']",
    );
    if (!addressInput) throw new Error("Expected Browser address input");
    const initialAddress = addressInput.value;

    await emitApiEvent("browser-sidebar-state", {
      tabs: [
        makeBrowserSnapshot("window-session-2", {
          url: "https://wrong-window.example/",
          isLoading: true,
        }),
      ],
    });

    expect(addressInput.value).toBe(initialAddress);
    expect(view.queryByLabelText("Stop") === null).toBe(true);

    await emitApiEvent("browser-sidebar-state", {
      tabs: [
        makeBrowserSnapshot("window-session-1", {
          url: "https://exact-window.example/",
          isLoading: true,
        }),
      ],
    });

    expect(addressInput.value).toBe("exact-window.example");
    expect(view.queryByLabelText("Stop") === null).toBe(false);

    await emitApiEvent(
      "browser-sidebar-browser-use-state",
      makeBrowserUseStateSnapshot({
        scopeId: "window-session-2",
        activeScopeId: "window-session-1",
        title: "Wrong window agent",
        cursorVisible: true,
      }),
    );
    await emitApiEvent(
      "browser-sidebar-browser-use-cursor-state",
      makeBrowserUseCursor("window-session-2", { visible: true }),
    );
    await emitApiEvent(
      "browser-sidebar-browser-use-viewport",
      makeBrowserUseViewport("window-session-2", {
        viewportSize: { width: 777, height: 333 },
      }),
    );

    expect(view.queryByTestId("browser-agent-cursor-overlay") === null).toBe(true);
    expect(view.queryByText("Wrong window agent") === null).toBe(true);
    expect(view.queryByText("777x333") === null).toBe(true);

    await emitApiEvent(
      "browser-sidebar-browser-use-state",
      makeBrowserUseStateSnapshot({
        scopeId: "window-session-1",
        activeScopeId: "window-session-1",
        title: "Exact window agent",
        cursorVisible: true,
      }),
    );

    expect(view.queryByTestId("browser-agent-cursor-overlay") === null).toBe(false);
    expect(view.queryByTestId("browser-agent-cursor-asset") === null).toBe(false);
    expect(view.queryByText("Exact window agent") === null).toBe(true);

    await emitApiEvent("browser-sidebar-browser-use-state", {
      tabs: [],
      activeBrowserTabIdsByConversationScope: {
        "session-1\0window-session-1": "tab-browser",
      },
      cursors: [],
    } satisfies BrowserSidebarBrowserUseStateSnapshot);

    expect(view.queryByTestId("browser-agent-cursor-overlay") === null).toBe(true);

    await emitApiEvent(
      "browser-sidebar-browser-use-cursor-state",
      makeBrowserUseCursor("window-session-1", { visible: true }),
    );

    expect(view.queryByTestId("browser-agent-cursor-overlay") === null).toBe(true);
    expect(view.queryByText("777x333") === null).toBe(true);

    await emitApiEvent(
      "browser-sidebar-browser-use-viewport",
      makeBrowserUseViewport("window-session-1", {
        viewportSize: { width: 800, height: 600 },
      }),
    );

    expect(view.queryByTestId("browser-agent-cursor-overlay") === null).toBe(false);
    expect(view.queryByText("800x600") === null).toBe(true);
  });

  test("remounts the visible panel without recreating or reparenting the webview", async () => {
    const first = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
      />,
    );
    await settleAsyncRender();
    const firstRoot = document.body.querySelector("[data-browser-sidebar-webview-manager-root]");
    const firstWebview = firstRoot?.querySelector("webview");
    const firstParent = firstWebview?.parentElement;

    first.unmount();
    await settleAsyncRender();

    const second = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
      />,
    );
    await settleAsyncRender();
    const secondRoot = document.body.querySelector("[data-browser-sidebar-webview-manager-root]");
    const secondWebview = secondRoot?.querySelector("webview");

    expect(secondRoot === firstRoot).toBe(true);
    expect(secondWebview === firstWebview).toBe(true);
    expect(secondWebview?.parentElement === firstParent).toBe(true);
    expect(secondWebview?.getAttribute("src")).toBe("https://www.google.com/");
    second.unmount();
  });

  test("registers an auto-materialized tab once when persisted viewport state exists", async () => {
    const autoMaterializedTab = {
      ...loadedBrowserTab,
      id: "tab:browser-use:runtime-page",
      browserTabId: "browser-use:runtime-page",
      config: {
        ...loadedBrowserTab.config,
        browserStorageId: "browser:use:runtime-page",
        deviceToolbarVisible: false,
        deviceToolbarState: makeBrowserSnapshot("window-session-1").deviceToolbarState,
      },
    } satisfies WorkbenchTabProjection;
    const loadedSession = {
      ...activeSession,
      tabs: [autoMaterializedTab],
    };
    const view = render(
      <BrowserSidebarPanel
        tab={autoMaterializedTab}
        activeSession={loadedSession}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [loadedSession]}
      />,
    );
    await settleAsyncRender();

    expect(readBrowserCommandCalls("register-tab")).toHaveLength(1);
    expect(
      document.body
        .querySelector("[data-browser-sidebar-webview-manager-root]")
        ?.getAttribute("data-browser-sidebar-webview-host-kind"),
    ).toBe("panel");
    view.unmount();
  });

  test("registers a Project Scene Browser without inventing a Codex Session", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        surfaceContext={{
          browserConversationId: "project:alpha",
          codexSessionId: null,
        }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => []}
      />,
    );
    await settleAsyncRender();

    const [registerCommand] = readBrowserCommandCalls("register-tab");
    expect(registerCommand).toMatchObject({
      browserConversationId: "project:alpha",
      browserViewScopeId: "window-session-1",
    });
    expect(registerCommand).not.toHaveProperty("codexSessionId");
    view.unmount();
  });

  test("mounts an about:blank guest when Browser Use presents a tab before navigation", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={browserTab}
        activeSession={activeSession}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [activeSession]}
      />,
    );
    await settleAsyncRender();
    expect(document.body.querySelector("[data-browser-sidebar-webview-manager-root]")).toBe(null);

    await emitApiEvent("browser-sidebar-browser-use-state", {
      tabs: [
        makeBrowserUseTab("window-session-1", {
          title: "New tab",
          url: "about:blank",
          webContentsId: null,
        }),
      ],
      activeBrowserTabIdsByConversationScope: {
        "session-1\0window-session-1": "tab-browser",
      },
      cursors: [],
    } satisfies BrowserSidebarBrowserUseStateSnapshot);
    await settleAsyncRender();

    const root = document.body.querySelector("[data-browser-sidebar-webview-manager-root]");
    expect(root?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe("panel");
    expect(root?.querySelector("webview")?.getAttribute("src")).toBe("about:blank");
    expect(readBrowserCommandCalls("register-host")).toHaveLength(1);
    view.unmount();
  });

  test("resyncs the body-attached webview bounds from panel motion ticks", async () => {
    const boundsSyncTrigger = createBoundsSyncTrigger();
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
        boundsSyncTrigger={boundsSyncTrigger}
      />,
    );
    await settleAsyncRender();

    const host = view.container.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-host-root]",
    );
    expect(host === null).toBe(false);
    setElementRect(host as HTMLElement, { left: 24, top: 48, width: 320, height: 240 });
    await emitBoundsSync(boundsSyncTrigger);

    const managerRoot = document.body.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-manager-root]",
    );
    expect(managerRoot === null).toBe(false);
    expect(managerRoot?.style.left).toBe("24px");
    expect(managerRoot?.style.top).toBe("48px");
    expect(managerRoot?.style.width).toBe("320px");
    expect(managerRoot?.style.height).toBe("240px");

    setElementRect(host as HTMLElement, { left: 96, top: 52, width: 512, height: 260 });
    await emitBoundsSync(boundsSyncTrigger);

    expect(managerRoot?.style.left).toBe("96px");
    expect(managerRoot?.style.top).toBe("52px");
    expect(managerRoot?.style.width).toBe("512px");
    expect(managerRoot?.style.height).toBe("260px");
    view.unmount();
  });

  test("hides the guest immediately when the animated panel becomes logically closed", async () => {
    const boundsSyncTrigger = createBoundsSyncTrigger();
    const loadedSession = {
      ...activeSession,
      tabs: [loadedBrowserTab],
    };
    const onRefreshSessions = async () => [loadedSession];
    const renderPanel = (isVisible: boolean) => (
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={loadedSession}
        browserViewScopeId="window-session-1"
        isVisible={isVisible}
        onRefreshSessions={onRefreshSessions}
        boundsSyncTrigger={boundsSyncTrigger}
      />
    );
    const view = render(renderPanel(true));
    await settleAsyncRender();

    const reactHost = view.container.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-host-root]",
    );
    if (!reactHost) throw new Error("Expected Browser webview host");
    setElementRect(reactHost, {
      left: 24,
      top: 48,
      width: 320,
      height: 240,
    });
    await emitBoundsSync(boundsSyncTrigger);

    const managerRoot = document.body.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-manager-root]",
    );
    expect(managerRoot?.getAttribute("data-browser-sidebar-webview-visible")).toBe("true");
    const registerHostCount = readBrowserCommandCalls("register-host").length;

    view.rerender(renderPanel(false));
    await settleAsyncRender();

    expect(managerRoot?.getAttribute("data-browser-sidebar-webview-visible")).toBe("false");
    expect(managerRoot?.style.left).toBe("-10000px");
    expect(managerRoot?.style.visibility).toBe("hidden");
    expect(readBrowserCommandCalls("register-host")).toHaveLength(registerHostCount);
    expect(readBrowserCommandCalls("sync-host").at(-1)).toMatchObject({
      presented: false,
      visible: false,
    });
  });

  test("renders browser options above the body-attached webview layer", async () => {
    const view = render(
      <BrowserSidebarPanel
        tab={loadedBrowserTab}
        activeSession={{ ...activeSession, tabs: [loadedBrowserTab] }}
        browserViewScopeId="window-session-1"
        isVisible
        onRefreshSessions={async () => [{ ...activeSession, tabs: [loadedBrowserTab] }]}
      />,
    );
    await settleAsyncRender();

    const trigger = view.getByLabelText("Browser options");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settleAsyncRender();

    const menu = document.body.querySelector<HTMLElement>("[role='menu']");
    expect(menu === null).toBe(false);
    expect(menu?.style.zIndex).toBe("2147483647");
  });
});

type TestBoundsSyncTrigger = MotionValue<number> & {
  emit: () => void;
};

function createBoundsSyncTrigger(): TestBoundsSyncTrigger {
  const listeners = new Set<(latest: number) => void>();
  return {
    on: (eventName: string, listener: (latest: number) => void) => {
      if (eventName === "change") listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) listener(Date.now());
    },
  } as unknown as TestBoundsSyncTrigger;
}

async function emitBoundsSync(boundsSyncTrigger: TestBoundsSyncTrigger) {
  await act(async () => {
    boundsSyncTrigger.emit();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function emitApiEvent(channel: string, payload: unknown) {
  await act(async () => {
    for (const listener of apiListeners.get(channel) ?? []) {
      listener(payload);
    }
    await Promise.resolve();
  });
}

function readBrowserCommandCalls(type: string): Array<Record<string, unknown>> {
  return invokeCalls.flatMap((call) => {
    if (call[0] !== "browser-sidebar-command") return [];
    const command = call[1] as Record<string, unknown> | undefined;
    return command?.type === type ? [command] : [];
  });
}

function setElementRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      toJSON: () => rect,
    }),
  });
}

const browserTab: WorkbenchTabProjection & { preview: true } = {
  id: "tab-browser",
  sessionId: "session-1",
  browserTabId: "tab-browser",
  projectId: "alpha",
  panelId: "right",
  kind: "browser",
  title: "Browser",
  order: 0,
  config: {
    projectId: "alpha",
    url: "about:blank",
  },
  stateKey: 0,
  state: null,
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
  preview: true,
};

const activeSession: WorkbenchSessionRenderProjection = {
  id: "session-1",
  projectId: "alpha",
  noThreadFallbackTitle: "Session",
  displayTitle: "Session",
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  panels: {
    right: {
      collapsed: false,
      layout: {
        version: 2,
        root: {
          type: "leaf",
          id: "right-root",
          tabIds: ["tab-browser"],
          activeTabId: "tab-browser",
          mruTabIds: ["tab-browser"],
        },
        activeLeafId: "right-root",
        mruLeafIds: ["right-root"],
      },
      size: {},
    },
    bottom: {
      collapsed: true,
      layout: {
        version: 2,
        root: { type: "leaf", id: "bottom-root", tabIds: [], activeTabId: null, mruTabIds: [] },
        activeLeafId: "bottom-root",
        mruLeafIds: ["bottom-root"],
      },
      size: {},
    },
  },
  thread: null,
  tabs: [browserTab],
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

const loadedBrowserTab = {
  id: browserTab.id,
  sessionId: browserTab.sessionId,
  browserTabId: browserTab.browserTabId,
  projectId: browserTab.projectId,
  panelId: browserTab.panelId,
  kind: browserTab.kind,
  title: browserTab.title,
  order: browserTab.order,
  config: {
    projectId: "alpha",
    url: "https://www.google.com/",
    title: "Google",
  },
  stateKey: browserTab.stateKey,
  state: browserTab.state,
  createdAt: browserTab.createdAt,
  updatedAt: browserTab.updatedAt,
} satisfies WorkbenchTabProjection;

function makeBrowserSnapshot(
  browserViewScopeId: string,
  overrides: Partial<BrowserSidebarTabSnapshot> = {},
): BrowserSidebarTabSnapshot {
  return {
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId: "tab-browser",
    projectId: "alpha",
    webContentsId: 42,
    mountGeneration: 1,
    url: "https://www.google.com/",
    title: "Google",
    isLoading: false,
    isWaitingForResponse: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    deviceToolbarVisible: false,
    viewport: {
      width: 390,
      height: 844,
      zoomPercent: 100,
      presetId: "responsive",
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
    updatedAt: 1,
    ...overrides,
  };
}

function makeBrowserUseStateSnapshot({
  scopeId,
  activeScopeId,
  title,
  cursorVisible,
}: {
  scopeId: string;
  activeScopeId: string;
  title: string;
  cursorVisible: boolean;
}): BrowserSidebarBrowserUseStateSnapshot {
  return {
    tabs: [makeBrowserUseTab(scopeId, { title })],
    activeBrowserTabIdsByConversationScope: {
      [`session-1\0${activeScopeId}`]: "tab-browser",
    },
    cursors: [makeBrowserUseCursor(scopeId, { visible: cursorVisible })],
  };
}

function makeBrowserUseTab(
  browserViewScopeId: string,
  overrides: Partial<BrowserUseTabState> = {},
): BrowserUseTabState {
  return {
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId: "tab-browser",
    codexSessionId: "thread-1",
    projectId: "alpha",
    title: "Browser agent",
    url: "https://www.google.com/",
    webContentsId: 42,
    viewport: {
      width: 390,
      height: 844,
      zoomPercent: 100,
      presetId: "responsive",
    },
    captureActive: true,
    released: false,
    updatedAt: 1,
    ...overrides,
  };
}

function makeBrowserUseCursor(
  browserViewScopeId: string,
  overrides: Partial<BrowserUseCursorState> = {},
): BrowserUseCursorState {
  return {
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId: "tab-browser",
    moveSequence: 1,
    x: 20,
    y: 30,
    visible: false,
    updatedAt: 1,
    ...overrides,
  };
}

function makeBrowserUseViewport(
  browserViewScopeId: string,
  overrides: Partial<BrowserSidebarBrowserUseViewportEvent> = {},
): BrowserSidebarBrowserUseViewportEvent {
  return {
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId: "tab-browser",
    viewportSize: null,
    ...overrides,
  };
}
