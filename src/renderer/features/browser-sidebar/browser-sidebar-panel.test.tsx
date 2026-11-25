import { afterEach, beforeAll, beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act } from "@testing-library/react";
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
import { openLink } from "@/lib/link-opening";

let BrowserSidebarPanel: (typeof import("./browser-sidebar-panel"))["BrowserSidebarPanel"];
let invokeCalls: unknown[][] = [];
let apiListeners = new Map<string, Set<(payload: unknown) => void>>();

vi.mock("@/lib/link-opening", () => ({
  openLink: vi.fn(async () => true),
}));

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
  vi.mocked(openLink).mockClear();
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
  test.each(["file:///tmp/page.html", "data:text/html,hello"])(
    "preserves the trusted initial URL %s when registering and mounting the tab",
    async (url) => {
      const tab = { ...loadedBrowserTab, config: { ...loadedBrowserTab.config, url } };
      const view = render(
        <BrowserSidebarPanel
          tab={tab}
          activeSession={{ ...activeSession, tabs: [tab] }}
          browserViewScopeId="window-session-1"
          isVisible
          onRefreshSessions={async () => []}
        />,
      );
      await settleAsyncRender();

      const input = view.getByPlaceholderText("Search or enter a URL") as HTMLInputElement;
      expect(input.value).toBe(url);
      expect(readBrowserCommandCalls("register-tab")).toEqual([
        expect.objectContaining({ initialUrl: url }),
      ]);
      expect(document.body.querySelector("webview")?.getAttribute("src")).toBe(url);
    },
  );

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
  activityAt: 0,
  managed: false,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  wokeAt: null,
  pageTurn: null,
  canManage: true,
  canStop: true,
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
