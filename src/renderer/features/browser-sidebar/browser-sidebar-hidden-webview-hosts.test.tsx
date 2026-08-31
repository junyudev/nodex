import { afterEach, beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act } from "react";
import type {
  BrowserSidebarTabSnapshot,
  BrowserUsePresentationRequest,
  BrowserUseTabState,
} from "../../../shared/browser-sidebar";
import type { WorkbenchTabProjection } from "@/lib/types";
import { render, settleAsyncRender } from "../../test/dom";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

let BrowserSidebarHiddenWebviewHosts: (typeof import("./browser-sidebar-hidden-webview-hosts"))["BrowserSidebarHiddenWebviewHosts"];
let BrowserSidebarBrowserUseWebviewHosts: (typeof import("./browser-sidebar-hidden-webview-hosts"))["BrowserSidebarBrowserUseWebviewHosts"];
let invokeCalls: unknown[][] = [];
let apiHandlers = new Map<string, (payload: unknown) => void>();

const rendererState = vi.hoisted(() => ({
  state: { tabs: [] as BrowserSidebarTabSnapshot[] },
  browserUseState: {
    tabs: [] as BrowserUseTabState[],
    activeBrowserTabIdsByConversationScope: {},
    cursors: [],
  },
  presentationRequests: [] as BrowserUsePresentationRequest[],
}));

vi.mock("@/lib/api", () => ({
  invoke: async (channel: string, ...args: unknown[]) => {
    invokeCalls.push([channel, ...args]);
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

vi.mock("./browser-sidebar-renderer-state-store", () => ({
  useBrowserSidebarRendererState: () => rendererState,
}));

beforeEach(async () => {
  invokeCalls = [];
  apiHandlers = new Map();
  rendererState.state.tabs = [];
  rendererState.browserUseState.tabs = [];
  rendererState.browserUseState.activeBrowserTabIdsByConversationScope = {};
  rendererState.browserUseState.cursors = [];
  rendererState.presentationRequests = [];
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push([channel, ...args]);
        return { ok: true };
      },
      on: (channel: string, handler: (payload: unknown) => void) => {
        apiHandlers.set(channel, handler);
        return () => apiHandlers.delete(channel);
      },
    },
  });
  const module = await import("./browser-sidebar-hidden-webview-hosts");
  BrowserSidebarHiddenWebviewHosts = module.BrowserSidebarHiddenWebviewHosts;
  BrowserSidebarBrowserUseWebviewHosts = module.BrowserSidebarBrowserUseWebviewHosts;
});

afterEach(() => {
  browserSidebarRendererWebviewManager.disposeAll();
  document.body.innerHTML = "";
});

describe("BrowserSidebarHiddenWebviewHosts", () => {
  test("does not bootstrap blank browser tabs in the background", async () => {
    render(
      <BrowserSidebarHiddenWebviewHosts
        durableBrowserConversationId="session-1"
        browserViewScopeId="window-session-1"
        tabs={[{ ...browserTab, config: { projectId: "alpha", url: "about:blank" } }]}
        mountedTabIds={new Set()}
        visibleTabIds={new Set()}
      />,
    );
    await settleAsyncRender();

    expect(document.body.querySelector("webview") === null).toBe(true);
    expect(invokeCalls.length).toBe(0);
  });

  test("mounts inactive loaded browser tabs in an offscreen host", async () => {
    render(
      <BrowserSidebarHiddenWebviewHosts
        durableBrowserConversationId="session-1"
        browserViewScopeId="window-session-1"
        tabs={[browserTab]}
        mountedTabIds={new Set()}
        visibleTabIds={new Set()}
      />,
    );
    await settleAsyncRender();

    const host = document.body.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-manager-root][data-browser-sidebar-browser-tab-id='tab-browser']",
    );
    const reactHost = viewContainerHost();
    const webview = host?.querySelector("webview");
    const registerCommand = invokeCalls.find(
      (call) =>
        call[0] === "browser-sidebar-command" &&
        (call[1] as { type?: string } | undefined)?.type === "register-tab",
    );

    expect(host === null).toBe(false);
    expect(reactHost === null).toBe(true);
    expect(host?.hasAttribute("hidden")).toBe(false);
    expect(host?.style.position).toBe("fixed");
    expect(host?.style.left).toBe("-10000px");
    expect(webview === null).toBe(false);
    expect(webview?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe("background");
    expect(registerCommand !== undefined).toBe(true);
  });

  test("does not claim a tab while its closing panel host is still mounted", async () => {
    render(
      <BrowserSidebarHiddenWebviewHosts
        durableBrowserConversationId="session-1"
        browserViewScopeId="window-session-1"
        tabs={[browserTab]}
        mountedTabIds={new Set(["tab-browser"])}
        visibleTabIds={new Set()}
      />,
    );
    await settleAsyncRender();

    expect(document.body.querySelector("webview")).toBeNull();
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "browser-sidebar-command" &&
          (call[1] as { type?: string } | undefined)?.type === "register-host",
      ),
    ).toBe(false);
  });

  test("gives a live Browser Use tab one retained host instead of a durable background host", async () => {
    rendererState.browserUseState.tabs = [
      makeBrowserUseTab({
        browserConversationId: "session-1",
        browserTabId: "tab-browser",
      }),
    ];

    render(
      <>
        <BrowserSidebarBrowserUseWebviewHosts />
        <BrowserSidebarHiddenWebviewHosts
          durableBrowserConversationId="session-1"
          browserViewScopeId="window-session-1"
          tabs={[browserTab]}
          mountedTabIds={new Set()}
          visibleTabIds={new Set()}
        />
      </>,
    );
    await settleAsyncRender();

    const registerHostCommands = invokeCalls.filter(
      (call) =>
        call[0] === "browser-sidebar-command" &&
        (call[1] as { type?: string } | undefined)?.type === "register-host",
    );

    expect(registerHostCommands).toHaveLength(1);
    expect(registerHostCommands[0]?.[1]).toMatchObject({
      hostKind: "retained",
      pagePersistence: "browser-use",
    });
    const host = document.body.querySelector<HTMLElement>(
      '[data-browser-sidebar-webview-host-kind="retained"]',
    );
    expect(host?.dataset.browserSidebarWebviewPainting).toBe("false");

    apiHandlers.get("browser-sidebar-browser-use-capture-surface")?.({
      ...rendererState.browserUseState.tabs[0]!,
      surfaceSize: { height: 720, width: 1_280 },
    });

    expect(host?.dataset.browserSidebarWebviewPainting).toBe("true");
    expect(host?.style.opacity).toBe("0.001");
  });

  test("keeps the retained webview mounted while its live navigation projection changes", async () => {
    rendererState.browserUseState.tabs = [
      makeBrowserUseTab({
        browserConversationId: "session-1",
        browserTabId: "tab-browser",
      }),
    ];
    const view = render(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();
    const originalWebview = document.body.querySelector("webview");

    rendererState.browserUseState.tabs = [
      {
        ...rendererState.browserUseState.tabs[0]!,
        title: "Navigated page",
        url: "https://example.test/navigated",
        viewport: {
          height: 800,
          width: 1_400,
          zoomPercent: 100,
          presetId: "browser-use",
        },
      },
    ];
    view.rerender(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();

    expect(document.body.querySelector("webview")).toBe(originalWebview);
    expect(
      invokeCalls.filter(
        (call) =>
          call[0] === "browser-sidebar-command" &&
          (call[1] as { type?: string } | undefined)?.type === "register-host",
      ),
    ).toHaveLength(1);
  });

  test("forgets an ephemeral viewport when a Browser Use tab is released", async () => {
    const tab = makeBrowserUseTab();
    rendererState.browserUseState.tabs = [tab];
    rendererState.browserUseState.activeBrowserTabIdsByConversationScope = {
      [`${tab.browserConversationId}\0${tab.browserViewScopeId}`]: tab.browserTabId,
    };
    const view = render(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();

    await act(async () => {
      apiHandlers.get("browser-sidebar-browser-use-viewport")?.({
        ...tab,
        viewportSize: { height: 444, width: 333 },
      });
    });
    await settleAsyncRender();
    expect(
      document.body.querySelector<HTMLElement>("[data-browser-sidebar-webview-manager-root]")?.style
        .width,
    ).toBe("333px");

    rendererState.browserUseState.tabs = [{ ...tab, released: true }];
    view.rerender(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();
    rendererState.browserUseState.tabs = [tab];
    view.rerender(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();

    expect(
      document.body.querySelector<HTMLElement>("[data-browser-sidebar-webview-manager-root]")?.style
        .width,
    ).toBe("1280px");
  });

  test("retains live Browser Use tabs by exact conversation identity without an active scene", async () => {
    rendererState.browserUseState.tabs = [
      makeBrowserUseTab({
        browserConversationId: "agent-dock-session",
        browserTabId: "browser-use:agent-dock",
        codexSessionId: "codex-thread-agent-dock",
      }),
    ];

    render(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();

    const host = document.body.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-manager-root][data-browser-sidebar-browser-tab-id='browser-use:agent-dock']",
    );
    const webview = host?.querySelector("webview");
    const registerCommand = invokeCalls.find(
      (call) =>
        call[0] === "browser-sidebar-command" &&
        (call[1] as { type?: string } | undefined)?.type === "register-tab",
    );

    expect(host?.dataset.browserSidebarConversationId).toBe("agent-dock-session");
    expect(webview?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe("retained");
    expect(registerCommand?.[1]).toMatchObject({
      type: "register-tab",
      browserConversationId: "agent-dock-session",
      browserViewScopeId: "window-session-1",
      browserTabId: "browser-use:agent-dock",
    });
  });

  test("yields a retained identity to a panel host and reclaims it after release", async () => {
    const browserUseTab = makeBrowserUseTab();
    rendererState.browserUseState.tabs = [browserUseTab];

    render(<BrowserSidebarBrowserUseWebviewHosts />);
    await settleAsyncRender();
    const originalWebview = document.body.querySelector("webview");

    const panelLease = browserSidebarRendererWebviewManager.claimHost({
      ...browserUseTab,
      browserStorageId: `browser:use:${browserUseTab.browserTabId}`,
      hostKind: "panel",
      initialUrl: browserUseTab.url,
      pagePersistence: "browser-use",
      tabRegistration: "preestablished",
      presentation: {
        bounds: { height: 600, width: 800, x: 20, y: 30 },
        isVisible: true,
        shouldPaint: true,
      },
      themeVariant: "dark",
    });
    await settleAsyncRender();

    expect(document.body.querySelector("webview")).toBe(originalWebview);
    expect(originalWebview?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe("panel");

    panelLease.release();
    await settleAsyncRender();

    expect(document.body.querySelector("webview")).toBe(originalWebview);
    expect(originalWebview?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe(
      "retained",
    );
    const mountGenerations = invokeCalls
      .filter(
        (call) =>
          call[0] === "browser-sidebar-command" &&
          (call[1] as { type?: string } | undefined)?.type === "register-host",
      )
      .map((call) => (call[1] as { mountGeneration: number }).mountGeneration);
    expect(new Set(mountGenerations).size).toBe(1);
  });
});

function viewContainerHost() {
  return document.body.querySelector("[data-browser-sidebar-hidden-webview-host='tab-browser']");
}

const browserTab = {
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
    url: "https://www.google.com/",
    title: "Google",
  },
  stateKey: 0,
  state: null,
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
} satisfies WorkbenchTabProjection;

function makeBrowserUseTab(overrides: Partial<BrowserUseTabState> = {}): BrowserUseTabState {
  return {
    browserConversationId: "session-1",
    browserViewScopeId: "window-session-1",
    browserTabId: "browser-use:1",
    codexSessionId: "codex-thread-1",
    projectId: "alpha",
    title: "New tab",
    url: "about:blank",
    webContentsId: null,
    viewport: {
      height: 720,
      width: 1280,
      zoomPercent: 100,
      presetId: "browser-use",
    },
    captureActive: false,
    released: false,
    updatedAt: 1,
    ...overrides,
  };
}
