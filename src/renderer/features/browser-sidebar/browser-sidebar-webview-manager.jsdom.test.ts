import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX,
  BROWSER_SIDEBAR_WEBVIEW_LAYER_Z_INDEX,
  BrowserSidebarRendererWebviewManager,
  type BrowserSidebarWebviewElement,
} from "./browser-sidebar-webview-manager";
import type {
  BrowserSidebarWebviewDestroyed,
  BrowserSidebarWebviewHostCreated,
} from "../../../shared/browser-sidebar";
import { parseBrowserSidebarHostRoutePartition } from "../../../shared/browser-sidebar";

let activeManagers: BrowserSidebarRendererWebviewManager[] = [];

afterEach(() => {
  for (const manager of activeManagers) manager.disposeAll();
  activeManagers = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
  Object.defineProperty(window, "api", { configurable: true, value: undefined });
});

function createManager() {
  const manager = new BrowserSidebarRendererWebviewManager();
  activeManagers.push(manager);
  return manager;
}

function installWebContentsId(webview: Element, webContentsId: number) {
  (webview as BrowserSidebarWebviewElement).getWebContentsId = () => webContentsId;
  (webview as BrowserSidebarWebviewElement).getTitle = () => "Example";
  (webview as BrowserSidebarWebviewElement).getURL = () => "https://example.com/";
}

const visibleBounds = { x: 10, y: 20, width: 320, height: 240 };

const retainedClaim = {
  browserConversationId: "session-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-use:runtime-page",
  browserStorageId: "browser:use:browser-use:runtime-page",
  projectId: "alpha",
  hostKind: "retained" as const,
  initialUrl: "https://example.com",
  pagePersistence: "browser-use" as const,
  tabRegistration: "ensure" as const,
  presentation: {
    bounds: { height: 720, width: 1_280, x: -10_000, y: 0 },
    isVisible: false,
    shouldPaint: true,
  },
  themeVariant: "dark" as const,
};

function installBrowserCommandHandler(
  handler: (command: Record<string, unknown>) => Promise<unknown> | unknown,
): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      invoke: async (_channel: string, command: Record<string, unknown>) => await handler(command),
    },
  });
}

async function settleHostReconciliation(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function getManagerRoot(
  browserTabId = "tab-browser",
  browserConversationId?: string,
  browserViewScopeId?: string,
) {
  const conversationSelector =
    browserConversationId === undefined
      ? ""
      : `[data-browser-sidebar-conversation-id='${browserConversationId}']`;
  const scopeSelector =
    browserViewScopeId === undefined
      ? ""
      : `[data-browser-sidebar-view-scope-id='${browserViewScopeId}']`;
  return document.body.querySelector<HTMLElement>(
    `[data-browser-sidebar-webview-manager-root]${conversationSelector}${scopeSelector}[data-browser-sidebar-browser-tab-id='${browserTabId}']`,
  );
}

describe("BrowserSidebarRendererWebviewManager", () => {
  test("retries a rejected host registration without another lease update", async () => {
    vi.useFakeTimers();
    const commands: Record<string, unknown>[] = [];
    let registrationAttempts = 0;
    installBrowserCommandHandler((command) => {
      commands.push(command);
      if (command.type !== "register-host") return { ok: true };
      registrationAttempts += 1;
      return registrationAttempts === 1
        ? { ok: false, message: "renderer session is settling" }
        : { ok: true };
    });
    const manager = createManager();

    manager.claimHost(retainedClaim);
    await settleHostReconciliation();

    expect(registrationAttempts).toBe(1);
    expect(getManagerRoot(retainedClaim.browserTabId)).toBeNull();

    await vi.advanceTimersByTimeAsync(100);
    await settleHostReconciliation();

    expect(registrationAttempts).toBe(2);
    expect(getManagerRoot(retainedClaim.browserTabId)).not.toBeNull();
    expect(commands.filter((command) => command.type === "sync-host")).toHaveLength(1);
  });

  test("backs off after a transport rejection instead of spinning", async () => {
    vi.useFakeTimers();
    let registrationAttempts = 0;
    installBrowserCommandHandler((command) => {
      if (command.type !== "register-host") return { ok: true };
      registrationAttempts += 1;
      throw new Error("preload bridge is restarting");
    });
    const manager = createManager();

    manager.claimHost(retainedClaim);
    await settleHostReconciliation();
    await vi.advanceTimersByTimeAsync(49);
    await settleHostReconciliation();
    expect(registrationAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settleHostReconciliation();
    expect(registrationAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(99);
    await settleHostReconciliation();
    expect(registrationAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await settleHostReconciliation();
    expect(registrationAttempts).toBe(3);
  });

  test("reasserts host ownership when Main rejects a presentation sync", async () => {
    vi.useFakeTimers();
    let registrationAttempts = 0;
    let syncAttempts = 0;
    installBrowserCommandHandler((command) => {
      if (command.type === "register-host") registrationAttempts += 1;
      if (command.type !== "sync-host") return { ok: true };
      syncAttempts += 1;
      return syncAttempts === 1 ? { ok: false, message: "host-missing" } : { ok: true };
    });
    const manager = createManager();

    manager.claimHost(retainedClaim);
    await settleHostReconciliation();
    expect(registrationAttempts).toBe(1);
    expect(syncAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    await settleHostReconciliation();

    expect(registrationAttempts).toBe(2);
    expect(syncAttempts).toBe(2);
  });

  test("reasserts a preestablished panel host without registering its tab again", async () => {
    vi.useFakeTimers();
    const commands: Record<string, unknown>[] = [];
    let hostRegistrationAttempts = 0;
    installBrowserCommandHandler((command) => {
      commands.push(command);
      if (command.type !== "register-host") return { ok: true };
      hostRegistrationAttempts += 1;
      return hostRegistrationAttempts === 1
        ? { ok: false, message: "renderer session is settling" }
        : { ok: true };
    });
    const manager = createManager();

    manager.claimHost({
      ...retainedClaim,
      hostKind: "panel",
      tabRegistration: "preestablished",
      presentation: {
        bounds: visibleBounds,
        isVisible: true,
        shouldPaint: true,
      },
    });
    await settleHostReconciliation();
    await vi.advanceTimersByTimeAsync(50);
    await settleHostReconciliation();

    expect(commands.filter((command) => command.type === "register-renderer-session")).toHaveLength(
      2,
    );
    expect(commands.filter((command) => command.type === "register-tab")).toEqual([]);
    expect(commands.filter((command) => command.type === "register-host")).toHaveLength(2);
    expect(commands.filter((command) => command.type === "sync-host")).toHaveLength(1);
  });

  test("re-registers a claimed host with fresh generations after Main destroys its guest", async () => {
    const commands: Record<string, unknown>[] = [];
    installBrowserCommandHandler((command) => {
      commands.push(command);
      return { ok: true };
    });
    const manager = createManager();
    const lease = manager.claimHost(retainedClaim);
    await settleHostReconciliation();
    const originalWebview = getManagerRoot(retainedClaim.browserTabId)?.querySelector("webview");
    const firstRegistration = commands.find((command) => command.type === "register-host");
    if (!firstRegistration) throw new Error("Expected initial host registration");

    manager.destroyWebviewAtHostRequest(
      {
        browserConversationId: retainedClaim.browserConversationId,
        browserViewScopeId: retainedClaim.browserViewScopeId,
        browserTabId: retainedClaim.browserTabId,
        mountGeneration: firstRegistration.mountGeneration as number,
        reason: "reset",
        teardownId: "reset-1",
      },
      () => undefined,
    );
    expect(getManagerRoot(retainedClaim.browserTabId)).toBeNull();

    lease.update({ ...retainedClaim, title: "Navigated again" });
    await settleHostReconciliation();

    const registrations = commands.filter((command) => command.type === "register-host");
    expect(registrations).toHaveLength(2);
    expect(registrations[1]?.hostGeneration).toBe(2);
    expect(registrations[1]?.mountGeneration).toBe(2);
    expect(getManagerRoot(retainedClaim.browserTabId)?.querySelector("webview")).not.toBe(
      originalWebview,
    );
  });

  test("creates one managed webview host and reports a mount generation once", () => {
    const manager = createManager();
    const created: BrowserSidebarWebviewHostCreated[] = [];

    const mountGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: (event) => created.push(event),
    });

    const root = getManagerRoot();
    const webview = root?.querySelector("webview");
    expect(root !== null).toBe(true);
    expect(webview !== null).toBe(true);
    installWebContentsId(webview as Element, 101);
    webview?.dispatchEvent(new Event("did-attach"));
    webview?.dispatchEvent(new Event("dom-ready"));

    expect(root?.querySelectorAll("webview").length).toBe(1);
    expect(parseBrowserSidebarHostRoutePartition(webview?.getAttribute("partition"))).toMatchObject(
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-session-1",
        browserTabId: "tab-browser",
        hostGeneration: 1,
      },
    );
    expect(root?.style.left).toBe("10px");
    expect(root?.style.top).toBe("20px");
    expect(root?.style.width).toBe("320px");
    expect(root?.style.height).toBe("240px");
    expect(root?.style.zIndex).toBe(String(BROWSER_SIDEBAR_WEBVIEW_LAYER_Z_INDEX));
    expect(root?.parentElement === document.body).toBe(true);
    expect(created.length).toBe(1);
    expect(created[0]?.webContentsId).toBe(101);
    expect(created[0]?.mountGeneration).toBe(1);
  });

  test("reads document-bottom state from the visible guest", async () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    } as const;
    const mountGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: "alpha",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: () => undefined,
    });
    const webview = getManagerRoot()?.querySelector(
      "webview",
    ) as BrowserSidebarWebviewElement | null;
    if (!webview) throw new Error("Expected managed webview");
    webview.executeJavaScript = async () => true;

    await expect(manager.readIsAtDocumentBottom(identity)).resolves.toBe(true);
  });

  test("sends and replays the active annotation design preview", () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    } as const;
    const mountGeneration = manager.claimMountGeneration(identity);
    const syncInput = {
      ...identity,
      projectId: "alpha",
      hostKind: "panel" as const,
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: () => undefined,
    };
    manager.syncWebview(syncInput);
    const webview = getManagerRoot()?.querySelector(
      "webview",
    ) as BrowserSidebarWebviewElement | null;
    if (!webview) throw new Error("Expected managed webview");
    const send = vi.fn();
    webview.send = send;

    manager.setAnnotationDesignPreview(
      identity,
      "annotation-session-1",
      {
        after: "rgb(1, 2, 3)",
        anchorId: "anchor-1",
        before: "rgb(4, 5, 6)",
        property: "color",
      },
      true,
    );
    expect(send).not.toHaveBeenCalled();

    webview.dispatchEvent(new Event("dom-ready"));
    expect(send).toHaveBeenLastCalledWith("browser-annotation-design-preview", {
      after: "rgb(1, 2, 3)",
      anchorId: "anchor-1",
      originalView: true,
      property: "color",
      sessionId: "annotation-session-1",
    });

    send.mockClear();
    manager.syncWebview(syncInput);
    expect(send).toHaveBeenCalledWith("browser-annotation-design-preview", {
      after: "rgb(1, 2, 3)",
      anchorId: "anchor-1",
      originalView: true,
      property: "color",
      sessionId: "annotation-session-1",
    });
  });

  test("partitions equal browser tab ids by window view scope", () => {
    const manager = createManager();
    const browserTabId = "browser:shared";
    const firstIdentity = {
      browserConversationId: "conversation/one",
      browserViewScopeId: "window-session-1",
      browserTabId,
    } as const;
    const secondIdentity = {
      browserConversationId: "conversation/one",
      browserViewScopeId: "window-session-2",
      browserTabId,
    } as const;

    const firstGeneration = manager.claimMountGeneration(firstIdentity);
    const secondGeneration = manager.claimMountGeneration(secondIdentity);
    manager.syncWebview({
      ...firstIdentity,
      projectId: "alpha",
      hostKind: "background",
      initialUrl: "https://one.example",
      bounds: null,
      mountGeneration: firstGeneration,
      onHostCreated: () => undefined,
    });
    manager.syncWebview({
      ...secondIdentity,
      projectId: null,
      hostKind: "background",
      initialUrl: "https://two.example",
      bounds: null,
      mountGeneration: secondGeneration,
      onHostCreated: () => undefined,
    });

    const firstRoot = getManagerRoot(
      browserTabId,
      firstIdentity.browserConversationId,
      firstIdentity.browserViewScopeId,
    );
    const secondRoot = getManagerRoot(
      browserTabId,
      secondIdentity.browserConversationId,
      secondIdentity.browserViewScopeId,
    );
    expect(firstGeneration).toBe(1);
    expect(secondGeneration).toBe(1);
    expect(firstRoot === secondRoot).toBe(false);
    expect(
      parseBrowserSidebarHostRoutePartition(
        firstRoot?.querySelector("webview")?.getAttribute("partition"),
      ),
    ).toMatchObject(firstIdentity);
    expect(
      parseBrowserSidebarHostRoutePartition(
        secondRoot?.querySelector("webview")?.getAttribute("partition"),
      ),
    ).toMatchObject(secondIdentity);
  });

  test("keeps retained visible hosts on the retained webview layer", () => {
    const manager = createManager();

    const mountGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-retained",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-retained",
      hostKind: "retained",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      isVisible: true,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });

    const root = getManagerRoot("tab-retained");
    expect(root?.style.zIndex).toBe(String(BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX));
    expect(root?.parentElement === document.body).toBe(true);
  });

  test("keeps one connected guest when a retained Browser Use page becomes the visible panel", () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "browser-use:runtime-page",
    } as const;
    const retainedGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: "alpha",
      hostKind: "retained",
      initialUrl: "https://example.com",
      bounds: { height: 720, width: 1_280, x: -10_000, y: 0 },
      mountGeneration: retainedGeneration,
      isVisible: false,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });

    const retainedRoot = getManagerRoot(identity.browserTabId);
    const retainedWebview = retainedRoot?.querySelector("webview");
    const retainedCursorHost = retainedRoot?.querySelector(
      "[data-browser-sidebar-cursor-overlay-host]",
    );
    const stableParent = retainedRoot?.parentElement;

    const panelGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: "alpha",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration: panelGeneration,
      isVisible: true,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });

    const panelRoot = getManagerRoot(identity.browserTabId);
    expect(panelRoot).toBe(retainedRoot);
    expect(panelRoot?.parentElement).toBe(stableParent);
    expect(panelRoot?.parentElement).toBe(document.body);
    expect(panelRoot?.querySelector("webview")).toBe(retainedWebview);
    expect(panelRoot?.querySelector("[data-browser-sidebar-cursor-overlay-host]")).toBe(
      retainedCursorHost,
    );
    expect((retainedWebview as HTMLElement).isConnected).toBe(true);
    expect(panelRoot?.getAttribute("data-browser-sidebar-webview-host-kind")).toBe("panel");
    expect(panelRoot?.style.zIndex).toBe(String(BROWSER_SIDEBAR_WEBVIEW_LAYER_Z_INDEX));
  });

  test("temporarily paints the current visible guest on the Browser Use capture surface", () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    } as const;
    const mountGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: null,
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: () => undefined,
    });
    const root = getManagerRoot();
    const webview = root?.querySelector("webview");

    manager.setBrowserUseCaptureSurface({
      ...identity,
      surfaceSize: { height: 1_200, width: 900 },
    });

    expect(getManagerRoot()).toBe(root);
    expect(root?.querySelector("webview")).toBe(webview);
    expect(root?.style.left).toBe("0px");
    expect(root?.style.top).toBe("0px");
    expect(root?.style.width).toBe("900px");
    expect(root?.style.height).toBe("1200px");
    expect(root?.style.visibility).toBe("visible");
    expect(root?.style.opacity).toBe("0.001");
    expect(root?.style.pointerEvents).toBe("none");
    expect(root?.style.zIndex).toBe(String(BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX));
    expect(root?.getAttribute("data-browser-sidebar-webview-painting")).toBe("true");
    expect(root?.getAttribute("data-browser-sidebar-webview-visible")).toBe("false");

    manager.setBrowserUseCaptureSurface({
      ...identity,
      surfaceSize: null,
    });

    expect(root?.style.left).toBe("10px");
    expect(root?.style.top).toBe("20px");
    expect(root?.style.width).toBe("320px");
    expect(root?.style.height).toBe("240px");
    expect(root?.style.opacity).toBe("1");
    expect(root?.style.pointerEvents).toBe("auto");
    expect(root?.getAttribute("data-browser-sidebar-webview-visible")).toBe("true");
  });

  test("keeps active hidden retained guests on a transparent paint surface", () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-retained",
    } as const;
    const mountGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: null,
      hostKind: "retained",
      initialUrl: "https://example.com",
      bounds: { height: 720, width: 1_280, x: -10_000, y: 0 },
      mountGeneration,
      isVisible: false,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });

    const root = getManagerRoot("tab-retained");
    expect(root?.style.left).toBe("0px");
    expect(root?.style.top).toBe("0px");
    expect(root?.style.width).toBe("1280px");
    expect(root?.style.height).toBe("720px");
    expect(root?.style.visibility).toBe("visible");
    expect(root?.style.opacity).toBe("0.001");
    expect(root?.style.pointerEvents).toBe("none");
    expect(root?.style.zIndex).toBe(String(BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX));
    expect(root?.style.contain).toBe("layout paint size style");
    expect(root?.getAttribute("data-browser-sidebar-webview-painting")).toBe("true");
  });

  test("does not destroy the current visible host for a stale non-close generation request", () => {
    const manager = createManager();
    const destroyed: BrowserSidebarWebviewDestroyed[] = [];

    const firstGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration: firstGeneration,
      onHostCreated: () => undefined,
    });
    const secondGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration: secondGeneration,
      onHostCreated: () => undefined,
    });

    manager.destroyWebviewAtHostRequest(
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-session-1",
        browserTabId: "tab-browser",
        mountGeneration: firstGeneration,
        reason: "unmounted",
        teardownId: "stale",
      },
      (event) => destroyed.push(event),
    );

    expect(getManagerRoot()?.querySelector("webview") !== null).toBe(true);
    expect(destroyed.length).toBe(1);
    expect(destroyed[0]?.mountGeneration).toBe(firstGeneration);
  });

  test("backgrounds a detached visible host without reparenting the guest webview", async () => {
    const manager = createManager();

    const mountGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      isVisible: true,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });
    const root = getManagerRoot();
    const webview = root?.querySelector("webview");
    const originalParent = webview?.parentElement;
    expect(webview !== null).toBe(true);

    manager.detachWebview(
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-session-1",
        browserTabId: "tab-browser",
      },
      mountGeneration,
    );
    await Promise.resolve();

    expect(getManagerRoot() === root).toBe(true);
    expect(webview?.parentElement === originalParent).toBe(true);
    expect(root?.style.left).toBe("-10000px");
    expect(root?.style.visibility).toBe("hidden");
    expect((webview as HTMLElement).isConnected).toBe(true);
  });

  test("preserves one navigated guest across visible A to hidden B to visible A claims", () => {
    const manager = createManager();

    const firstGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com/first",
      bounds: visibleBounds,
      mountGeneration: firstGeneration,
      isVisible: true,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });
    const root = getManagerRoot();
    const webview = root?.querySelector("webview");
    const originalParent = webview?.parentElement;
    expect(webview !== null).toBe(true);
    (webview as BrowserSidebarWebviewElement).getURL = () => "https://example.com/navigated";

    const secondGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "background",
      initialUrl: "https://example.com/second",
      bounds: null,
      mountGeneration: secondGeneration,
      isVisible: false,
      shouldPaint: false,
      onHostCreated: () => undefined,
    });

    expect(getManagerRoot() === root).toBe(true);
    expect(webview?.parentElement === originalParent).toBe(true);
    expect(webview?.getAttribute("src")).toBe("https://example.com/first");

    const thirdGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com/stale-durable-url",
      bounds: visibleBounds,
      mountGeneration: thirdGeneration,
      isVisible: true,
      shouldPaint: true,
      onHostCreated: () => undefined,
    });

    expect(getManagerRoot() === root).toBe(true);
    expect(root?.querySelector("webview") === webview).toBe(true);
    expect((webview as BrowserSidebarWebviewElement).getURL?.()).toBe(
      "https://example.com/navigated",
    );
    expect(webview?.getAttribute("src")).toBe("https://example.com/first");
  });

  test("does not call through readiness-sensitive webview methods before attach is available", () => {
    const manager = createManager();
    const created: BrowserSidebarWebviewHostCreated[] = [];

    const mountGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: (event) => created.push(event),
    });
    const webview = getManagerRoot()?.querySelector(
      "webview",
    ) as BrowserSidebarWebviewElement | null;
    if (!webview) throw new Error("Expected managed webview");
    webview.getWebContentsId = () => {
      throw new Error(
        "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
      );
    };

    webview.dispatchEvent(new Event("did-attach"));
    webview.dispatchEvent(new Event("dom-ready"));

    expect(created.length).toBe(0);
  });

  test("removes listeners and host after an accepted destroy request", () => {
    const manager = createManager();
    const created: BrowserSidebarWebviewHostCreated[] = [];
    const destroyed: BrowserSidebarWebviewDestroyed[] = [];

    const mountGeneration = manager.claimMountGeneration({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    });
    manager.syncWebview({
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      projectId: "alpha",
      browserTabId: "tab-browser",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: (event) => created.push(event),
    });
    const root = getManagerRoot();
    const webview = root?.querySelector("webview");
    installWebContentsId(webview as Element, 101);
    webview?.dispatchEvent(new Event("did-attach"));

    manager.destroyWebviewAtHostRequest(
      {
        browserConversationId: "session-1",
        browserViewScopeId: "window-session-1",
        browserTabId: "tab-browser",
        mountGeneration,
        reason: "closed",
        teardownId: "current",
      },
      (event) => destroyed.push(event),
    );
    webview?.dispatchEvent(new Event("did-attach"));

    expect(root?.isConnected).toBe(false);
    expect(created.length).toBe(1);
    expect(destroyed.length).toBe(1);
    expect(destroyed[0]?.webContentsId).toBe(101);
  });

  test("destroys an explicitly closed runtime host at most once", () => {
    const manager = createManager();
    const identity = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-session-1",
      browserTabId: "tab-browser",
    } as const;
    const mountGeneration = manager.claimMountGeneration(identity);
    manager.syncWebview({
      ...identity,
      projectId: "alpha",
      hostKind: "panel",
      initialUrl: "https://example.com",
      bounds: visibleBounds,
      mountGeneration,
      onHostCreated: () => undefined,
    });
    const root = getManagerRoot();
    if (!root) throw new Error("Expected managed Browser host");
    const remove = root.remove.bind(root);
    let removeCount = 0;
    root.remove = () => {
      removeCount += 1;
      remove();
    };
    const request = {
      ...identity,
      mountGeneration,
      reason: "closed",
      teardownId: "explicit-close",
    } as const;

    manager.destroyWebviewAtHostRequest(request, () => undefined);
    manager.destroyWebviewAtHostRequest(request, () => undefined);

    expect(removeCount).toBe(1);
    expect(root.isConnected).toBe(false);
  });
});
