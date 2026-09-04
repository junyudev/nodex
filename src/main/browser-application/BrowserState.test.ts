import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";
import type {
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarTabIdentity,
  BrowserSidebarTabSnapshot,
  BrowserUsePresentationRequest,
} from "../../shared/browser-sidebar";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
} from "../../shared/workbench-scene";
import type { BrowserPageRuntime, BrowserSerializedPage } from "../browser/browser-page-store";
import type { BrowserSidebarEvent } from "../browser/BrowserSidebarEventHub";
import { makeBrowserRuntimeRegistry } from "../browser/browser-runtime-registry";
import { makeBrowserPageEmulationRuntimeUnsafe } from "../browser/browser-page-emulation";
import { makeBrowserEarlyPageRestoreRuntime } from "../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserWebContentsListenerRuntime } from "../browser/BrowserWebContentsListenerRuntime";
import type { BrowserWebContentsLike } from "../platform/electron/BrowserElectronPlatform";
import { BrowserForkTransferError, makeBrowserForkTransfer } from "./BrowserForkTransfer";
import { BrowserState } from "./BrowserState";

const identity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "scope-1",
  browserTabId: "tab-1",
} as const;

class FakeWebContents extends EventEmitter {
  readonly id = 101;
  readonly debugger = {
    attach: () => undefined,
    detach: () => undefined,
    isAttached: () => true,
    sendCommand: async () => undefined,
  };
  readonly loadUrls: string[] = [];
  destroyed = false;
  loading = false;
  title = "New tab";
  url = "about:blank";
  loadPromise: Promise<void> | null = null;
  restorePromise: Promise<void> | null = null;
  restoredHistory: BrowserSerializedPage["navigation"] | null = null;
  historyEntries: BrowserSerializedPage["navigation"]["entries"] = [
    { title: "New tab", url: "about:blank" },
  ];
  historyActiveIndex = 0;
  readonly navigationHistory = {
    clear: () => undefined,
    getActiveIndex: () => this.historyActiveIndex,
    getAllEntries: () => this.historyEntries,
    restore: async (options: {
      entries: BrowserSerializedPage["navigation"]["entries"];
      index?: number;
    }) => {
      if (this.restorePromise) await this.restorePromise;
      const currentIndex = options.index ?? options.entries.length - 1;
      this.restoredHistory = { currentIndex, entries: options.entries };
      this.historyEntries = options.entries;
      this.historyActiveIndex = currentIndex;
      const active = options.entries[currentIndex];
      if (!active) return;
      this.url = active.url;
      this.title = active.title;
    },
  };
  readonly session = {
    fetch: async () =>
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
  };

  canGoBack() {
    return false;
  }
  canGoForward() {
    return false;
  }
  capturePage() {
    return Promise.resolve({ toDataURL: () => "data:image/png;base64,test" });
  }
  executeJavaScript() {
    return Promise.resolve(undefined);
  }
  getTitle() {
    return this.title;
  }
  getURL() {
    return this.url;
  }
  goBack() {}
  goForward() {}
  inspectElement() {}
  isDestroyed() {
    return this.destroyed;
  }
  isLoading() {
    return this.loading;
  }
  loadURL(url: string) {
    this.loadUrls.push(url);
    this.url = url;
    return this.loadPromise ?? Promise.resolve();
  }
  reload() {}
  reloadIgnoringCache() {}
  send() {}
  setWindowOpenHandler() {}
  setZoomFactor() {}
  stop() {}
}

function makeMemoryPages(initial: readonly BrowserSerializedPage[] = []): {
  readonly pages: Map<string, BrowserSerializedPage>;
  readonly runtime: BrowserPageRuntime;
} {
  const pages = new Map(initial.map((page) => [page.browserStorageId, page]));
  return {
    pages,
    runtime: {
      clear: Effect.sync(() => pages.clear()),
      delete: (browserStorageId) => Effect.sync(() => void pages.delete(browserStorageId)),
      get: (browserStorageId) => Effect.sync(() => pages.get(browserStorageId) ?? null),
      reassociate: (sourceStorageId, targetStorageId) =>
        Effect.sync(() => {
          const page = pages.get(sourceStorageId);
          if (!page) return;
          pages.delete(sourceStorageId);
          pages.set(targetStorageId, { ...page, browserStorageId: targetStorageId });
        }),
      set: (page) => Effect.sync(() => void pages.set(page.browserStorageId, page)),
    },
  };
}

const makeFixture = (
  options: {
    readonly contents?: FakeWebContents;
    readonly page?: BrowserSerializedPage;
  } = {},
) =>
  Effect.gen(function* () {
    const contents = options.contents ?? new FakeWebContents();
    const events: BrowserSidebarEvent[] = [];
    const pages = makeMemoryPages(options.page ? [options.page] : []);
    const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
    const runtimeRegistry = makeBrowserRuntimeRegistry();
    const state = new BrowserState({
      earlyPageRestores: yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>(),
      electron: {
        sessionFromPartition: (() => ({
          clearCache: async () => undefined,
          clearData: async () => undefined,
        })) as never,
        openExternal: async () => undefined,
        presentContextMenu: () => undefined,
        webContentsFromId: (webContentsId) =>
          webContentsId === contents.id ? (contents as unknown as BrowserWebContentsLike) : null,
      },
      clipboard: { writeImage: () => Effect.void, writeText: () => Effect.void },
      events: { publish: (event) => events.push(event) },
      fork: (effect) => void runBackground(effect),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      pageEmulation: makeBrowserPageEmulationRuntimeUnsafe(),
      pageStore: pages.runtime,
      runtimeRegistry,
      saveBrowserImage: () => {
        throw new Error("Unexpected browser image save");
      },
      siteStatus: { cachedCommentModeBlocked: () => null },
      webContentsListeners: yield* makeBrowserWebContentsListenerRuntime,
    });
    return { contents, events, pages: pages.pages, runtimeRegistry, state };
  });

const registerTab = (state: BrowserState, browserStorageId = "browser:durable") =>
  state.handleCommand({
    type: "register-tab",
    ...identity,
    browserStorageId,
    projectId: "project-1",
    initialUrl: "about:blank",
    title: "Browser",
  });

function readTab(state: BrowserState, tabIdentity: BrowserSidebarTabIdentity = identity) {
  const tab = state
    .getStateSnapshot()
    .tabs.find(
      (candidate) =>
        candidate.browserConversationId === tabIdentity.browserConversationId &&
        candidate.browserViewScopeId === tabIdentity.browserViewScopeId &&
        candidate.browserTabId === tabIdentity.browserTabId,
    );
  if (!tab) throw new Error("Missing Browser tab");
  return tab;
}

const hostCreated = (state: BrowserState, ownerWebContentsId?: number) =>
  state.handleWebviewHostCreated(
    {
      ...identity,
      browserStorageId: "browser:durable",
      projectId: "project-1",
      hostKind: "panel",
      mountGeneration: 2,
      webContentsId: 101,
      initialUrl: "about:blank",
    },
    ownerWebContentsId,
  );

function sourceScene() {
  const empty = materializeInitialWorkbenchScene(
    { kind: "session", sessionId: identity.browserConversationId },
    {
      touchedAt: "2026-07-23T00:00:00.000Z",
      identityFactory: { createId: (kind) => `${kind}:seed` },
    },
  );
  const withTab = createWorkbenchSceneSurface(empty, {
    panelId: "right",
    surface: {
      id: "view-browser",
      kind: "browser",
      titleSnapshot: "Docs",
      config: { browserTabId: identity.browserTabId, url: "https://example.com/fallback" },
      stateKey: 0,
      state: null,
    },
  });
  const visible = patchWorkbenchScenePanel(withTab, "right", { collapsed: false });
  return activateWorkbenchSceneSurface(
    visible,
    "right",
    visible.panels.right.layout.activeLeafId,
    "view-browser",
  );
}

describe("BrowserState semantic capability", () => {
  it.effect("binds durable history to one storage identity and rejects unsafe navigation", () =>
    Effect.gen(function* () {
      const page: BrowserSerializedPage = {
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId: "browser:durable",
        identity,
        title: "Restored",
        url: "https://example.com/restored",
        updatedAt: 1,
        navigation: {
          currentIndex: 0,
          entries: [{ title: "Restored", url: "https://example.com/restored" }],
        },
      };
      const { contents, state } = yield* makeFixture({ page });
      const registered = yield* registerTab(state);
      expect(registered).toMatchObject({
        ok: true,
        snapshot: { browserStorageId: "browser:durable", url: page.url },
      });

      expect(yield* registerTab(state, "browser:forged")).toEqual({
        ok: false,
        message: "Browser storage identity does not match the registered tab",
      });
      expect(
        yield* state.handleCommand({
          type: "navigate",
          ...identity,
          url: "javascript:alert(document.cookie)",
        }),
      ).toEqual({ ok: false, message: "This URL is not allowed in the built-in Browser" });
      assert.deepEqual(contents.loadUrls, []);
    }),
  );

  it.effect("fences a late durable history restore when its guest generation is released", () =>
    Effect.gen(function* () {
      let finishRestore!: () => void;
      const contents = new FakeWebContents();
      contents.restorePromise = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      const page: BrowserSerializedPage = {
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId: "browser:durable",
        identity,
        title: "Restored",
        url: "https://example.com/restored",
        updatedAt: 1,
        navigation: {
          currentIndex: 0,
          entries: [{ title: "Restored", url: "https://example.com/restored" }],
        },
      };
      const { state } = yield* makeFixture({ contents, page });
      yield* registerTab(state);
      state.prepareAttachedWebviewHistoryRestore(
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 2,
        },
        contents.id,
      );
      const attached = yield* Effect.forkChild(hostCreated(state), { startImmediately: true });
      contents.destroyed = true;
      contents.emit("destroyed");
      const released = readTab(state);
      finishRestore();

      expect(yield* Fiber.join(attached)).toEqual({
        ok: false,
        message: "Browser webview was released during history restoration",
      });
      expect(readTab(state)).toEqual(released);
      assert.isNull(readTab(state).webContentsId);
    }),
  );

  it.effect("authorizes a guest only for its exact Electron owner", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      state.registerAttachedWebviewOwnership(7, 101, identity, "browser:durable");

      expect(yield* hostCreated(state, 8)).toEqual({
        ok: false,
        message: "Browser webview does not belong to the requesting window",
      });
      assert.isNull(readTab(state).webContentsId);
      expect(yield* hostCreated(state, 7)).toMatchObject({
        ok: true,
        snapshot: { webContentsId: 101 },
      });
    }),
  );

  it.effect("rejects a presentation sync that no longer owns the physical host generation", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      const context = { ownerWebContentsId: 7 };
      yield* state.handleCommand(
        {
          type: "register-renderer-session",
          browserViewScopeId: identity.browserViewScopeId,
          rendererInstanceId: "renderer-1",
        },
        context,
      );
      yield* state.handleCommand(
        {
          type: "register-host",
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 3,
          hostKind: "retained",
          pagePersistence: "durable",
          themeVariant: "dark",
        },
        context,
      );

      const result = yield* state.handleCommand(
        {
          type: "sync-host",
          ...identity,
          rendererInstanceId: "renderer-1",
          hostGeneration: 2,
          mountGeneration: 3,
          hostKind: "retained",
          presented: false,
          themeVariant: "dark",
          visible: false,
        },
        context,
      );

      expect(result).toMatchObject({ ok: false });
    }),
  );

  it.effect("rejects a late host-created acknowledgement from a superseded presentation", () =>
    Effect.gen(function* () {
      const { runtimeRegistry, state } = yield* makeFixture();
      yield* registerTab(state);
      runtimeRegistry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      expect(
        runtimeRegistry.registerHost(7, {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
          hostKind: "retained",
          pagePersistence: "durable",
        }).ok,
      ).toBe(true);
      state.registerAttachedWebviewOwnership(
        7,
        101,
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
        },
        "browser:durable",
      );
      expect(
        runtimeRegistry.registerHost(7, {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 2,
          hostKind: "panel",
          pagePersistence: "durable",
        }).ok,
      ).toBe(true);

      const late = yield* state.handleWebviewHostCreated(
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
          projectId: "project-1",
          hostKind: "retained",
          webContentsId: 101,
          initialUrl: "about:blank",
        },
        7,
      );
      expect(late).toEqual({
        ok: false,
        message: "Browser webview does not belong to the requesting window",
      });
      assert.isNull(readTab(state).webContentsId);

      expect(
        yield* state.handleWebviewHostCreated(
          {
            ...identity,
            browserStorageId: "browser:durable",
            rendererInstanceId: "renderer-1",
            hostGeneration: 1,
            mountGeneration: 2,
            projectId: "project-1",
            hostKind: "panel",
            webContentsId: 101,
            initialUrl: "about:blank",
          },
          7,
        ),
      ).toMatchObject({ ok: true, snapshot: { mountGeneration: 2, webContentsId: 101 } });
    }),
  );

  it.effect("ignores stale destroy acknowledgements and releases the exact mount generation", () =>
    Effect.gen(function* () {
      const { contents, events, state } = yield* makeFixture();
      contents.url = "https://example.com";
      yield* registerTab(state);
      yield* hostCreated(state);
      yield* state.handleCommand({ type: "navigate", ...identity, url: "about:blank" });
      const request = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "destroyWebview" }> =>
          event.kind === "destroyWebview",
      )?.value;
      if (!request) return yield* Effect.die("Missing destroy request");

      yield* state.handleWebviewDestroyed({
        ...identity,
        mountGeneration: 1,
        reason: "reset",
        teardownId: "stale",
        disposition: "destroyed",
        webContentsId: contents.id,
      });
      assert.strictEqual(readTab(state).webContentsId, contents.id);

      yield* state.handleWebviewDestroyed({
        ...(request satisfies BrowserSidebarDestroyWebviewRequest),
        disposition: "destroyed",
        webContentsId: contents.id,
      });
      assert.isNull(readTab(state).webContentsId);
      assert.strictEqual(contents.listenerCount("did-start-loading"), 0);
      assert.strictEqual(contents.listenerCount("destroyed"), 0);
    }),
  );

  it.effect("projects waiting, loading, committed, and settled navigation in causal order", () =>
    Effect.gen(function* () {
      const contents = new FakeWebContents();
      let finishLoad!: () => void;
      contents.loadPromise = new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
      const { state } = yield* makeFixture({ contents });
      yield* registerTab(state);
      yield* hostCreated(state);

      yield* state.handleCommand({ type: "navigate", ...identity, url: "https://example.com" });
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: true });
      contents.loading = true;
      contents.emit("did-start-loading");
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: true });
      contents.url = "https://example.com/";
      contents.emit("did-navigate", {}, contents.url);
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: false });
      contents.loading = false;
      contents.emit("did-stop-loading");
      expect(readTab(state)).toMatchObject({ isLoading: false, isWaitingForResponse: false });
      finishLoad();
    }),
  );

  it.effect("keeps Browser presentation admission separate from active control", () =>
    Effect.gen(function* () {
      const { events, state } = yield* makeFixture();
      const route = {
        browserConversationId: identity.browserConversationId,
        browserViewScopeId: identity.browserViewScopeId,
        codexSessionId: "thread-1",
        ownerWebContentsId: 7,
        projectId: "project-1",
      };
      yield* state.handleCommand({
        type: "browser-use-upsert-tab",
        tab: {
          ...identity,
          codexSessionId: route.codexSessionId,
          projectId: route.projectId,
          title: "Browser",
          url: "https://example.com",
          webContentsId: null,
          viewport: { width: 1280, height: 720, zoomPercent: 100, presetId: "browser-use" },
          captureActive: true,
          released: false,
          updatedAt: 1,
        },
      });

      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, true);
      const visible = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "browserUsePresentationRequest" }> =>
          event.kind === "browserUsePresentationRequest",
      )?.value;
      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, false);
      const hidden = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "browserUsePresentationRequest" }> =>
          event.kind === "browserUsePresentationRequest",
      )?.value;
      assert.isFalse(state.isBrowserVisibleForBrowserUse(route, identity.browserTabId));
      assert.strictEqual(
        state.getBrowserUseStateSnapshot().activeBrowserTabIdsByConversationScope[
          `conversation-1\0scope-1`
        ],
        identity.browserTabId,
      );

      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, true);
      const current = state.listPendingBrowserUsePresentationRequests(identity.browserViewScopeId);
      state.resolveBrowserUsePresentation({
        ...identity,
        requestId: visible?.requestId ?? "missing",
        outcome: "unavailable",
      });
      expect(state.listPendingBrowserUsePresentationRequests(identity.browserViewScopeId)).toEqual(
        current,
      );
      expect(hidden).toMatchObject({
        visible: false,
      } satisfies Partial<BrowserUsePresentationRequest>);
    }),
  );

  it.effect("scopes presented Browser Use surfaces to their exact Electron owner", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      state.registerAttachedWebviewOwnership(7, 101, identity, "browser:durable");
      yield* hostCreated(state, 7);
      yield* state.handleCommand({
        type: "browser-use-upsert-tab",
        tab: {
          ...identity,
          codexSessionId: "thread-1",
          projectId: "project-1",
          title: "Browser",
          url: "https://example.com",
          webContentsId: 101,
          viewport: { width: 1280, height: 720, zoomPercent: 100, presetId: "browser-use" },
          captureActive: true,
          released: false,
          updatedAt: 1,
        },
      });

      assert.isTrue(state.hasPresentedBrowserUseSurfaceForThread("thread-1", 7));
      assert.isFalse(state.hasPresentedBrowserUseSurfaceForThread("thread-1", 8));
      assert.isTrue(state.hasPresentedBrowserUseSurfaceForThread("thread-1"));
    }),
  );

  it.effect("releases physical guest listeners with the owning Scope", () =>
    Effect.gen(function* () {
      const parent = yield* Scope.Scope;
      const scope = yield* Scope.fork(parent);
      const fixture = yield* makeFixture().pipe(Scope.provide(scope));
      yield* registerTab(fixture.state);
      yield* hostCreated(fixture.state);
      assert.isAbove(fixture.contents.listenerCount("destroyed"), 0);

      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(fixture.contents.listenerCount("destroyed"), 0);
      assert.strictEqual(fixture.contents.listenerCount("did-start-loading"), 0);
    }),
  );

  it.effect("captures the initiating scene and remints Browser identities for a fork", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      const transfer = makeBrowserForkTransfer(state);
      const captured = yield* transfer.capture(identity.browserConversationId, {
        browserViewScopeId: identity.browserViewScopeId,
        scene: sourceScene(),
      });
      const rebased = yield* transfer.rebase(captured, "session-target");
      const applied = yield* transfer.apply(rebased, {
        targetBrowserConversationId: "session-target",
        targetBrowserViewScopeId: "window-target",
        targetProjectSession: { id: "session-target", projectId: "project-target" },
      });

      expect(captured.tabs).toMatchObject([
        {
          active: true,
          browserTabId: identity.browserTabId,
          panel: "right",
          tabId: "view-browser",
        },
      ]);
      assert.notEqual(applied.tabs[0]?.browserTabId, identity.browserTabId);
      assert.notEqual(applied.tabs[0]?.tabId, "view-browser");
      expect(state.getStateSnapshot().tabs).toContainEqual(
        expect.objectContaining({
          browserConversationId: "session-target",
          browserViewScopeId: "window-target",
          browserTabId: applied.tabs[0]?.browserTabId,
          projectId: "project-target",
        }),
      );
    }),
  );

  it.effect("rejects a fork whose resolved Browser and Project Session identities diverge", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      const transfer = makeBrowserForkTransfer(state);
      const captured = yield* transfer.capture(identity.browserConversationId);
      const error = yield* Effect.flip(
        transfer.apply(captured, {
          targetBrowserConversationId: "session-target",
          targetBrowserViewScopeId: "window-target",
          targetProjectSession: { id: "session-target", projectId: "project-target" },
        }),
      );

      assert.instanceOf(error, BrowserForkTransferError);
      assert.strictEqual(error.targetBrowserConversationId, identity.browserConversationId);
      assert.strictEqual(error.targetProjectSessionId, "session-target");
    }),
  );
});
