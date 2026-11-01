import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkbenchLinkPresenter, linkBrowserOwner } from "./workbench-link-opening";
import { createWorkbenchSceneNavigator } from "@/lib/workbench-scene-navigator";
import { createWorkbenchSceneSurfacePresenter } from "@/lib/workbench-scene-surface-presenter";
import { createWorkbenchSceneCommands } from "@/lib/workbench-scene-commands";
import { getWorkbenchWindowOwner } from "@/lib/workbench-window-owner";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "@/lib/maitai/maitai-store";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import { findWorkbenchPanelLeafForTab } from "../../../shared/workbench-panel-layout";
import type { ResolvedLinkOpenRequest } from "../../../shared/link-opening";

const url = "https://example.com/";
const request = (patch: Partial<ResolvedLinkOpenRequest> = {}): ResolvedLinkOpenRequest => ({
  url,
  initiator: "test",
  target: "in-app-browser",
  disposition: "default",
  download: false,
  ...patch,
});
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function fixture(owner: WorkbenchSceneOwner = { kind: "session", sessionId: "session-a" }) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const windowOwner = getWorkbenchWindowOwner(
    createScopeHandle(getMaitaiRootView(store)),
    createDefaultWorkbenchLayoutSnapshot(),
  );
  windowOwner.initialize();
  let revision = 0;
  windowOwner.registerPersistenceCommit(async (snapshot) => ({
    ...snapshot,
    sessionId: "test-window",
    layoutRevision: ++revision,
  }));
  const readScene = () =>
    windowOwner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(owner)] ??
    materializeInitialWorkbenchScene(owner);
  const updateScene = (update: (scene: WorkbenchSceneSnapshot) => WorkbenchSceneSnapshot) =>
    windowOwner.setScene(owner, (scene) =>
      update(scene ?? materializeInitialWorkbenchScene(owner)),
    );
  const executor = createWorkbenchSceneCommands(windowOwner, {
    prepareClose: async () => true,
    close: async () => {},
  });
  let nextId = 0;
  const tabs: { browserTabId: string; url: string; pendingUrl?: string }[] = [];
  let agentActiveTabId: string | undefined;
  const openWindow = vi.fn(async () => true);
  const add = (
    id: string,
    committed = url,
    pendingUrl?: string,
    panelId: "right" | "bottom" = "right",
    browserTabId = id,
  ) => {
    const surface: WorkbenchSurfaceDescriptor = {
      id,
      kind: "browser",
      titleSnapshot: id,
      config: { browserTabId, url: committed },
      state: null,
      stateKey: 0,
    };
    updateScene((scene) => createWorkbenchSceneSurface(scene, { panelId, surface }));
    tabs.push({ browserTabId, url: committed, pendingUrl });
  };
  const navigator = createWorkbenchSceneNavigator(
    {
      getScene: readScene,
      presentDurable: createWorkbenchSceneSurfacePresenter(windowOwner, executor),
      hasConversation: () => true,
      setScene: (_owner, update) => {
        updateScene(update);
      },
      selectLocation: () => undefined,
      setSceneAndSelect: (_owner, update) => {
        updateScene(update);
      },
    },
    { createId: (kind) => `${kind}-${++nextId}` },
  );
  const open = createWorkbenchLinkPresenter({
    getOwner: () => owner,
    getScene: readScene,
    updateScene: (_owner, update) => updateScene(update),
    getBrowserState: () => ({ tabs, agentActiveTabId }),
    navigator,
    openWindow,
  });
  const active = () => {
    const scene = readScene();
    const panel = scene.panels.right;
    return findWorkbenchPanelLeafForTab(
      panel.layout,
      Object.keys(scene.panelSurfacesById).at(-1) ?? "",
    )?.activeTabId;
  };
  return {
    open,
    add,
    openWindow,
    scene: readScene,
    windowState: () => windowOwner.read(),
    active,
    setAgent: (id: string) => {
      agentActiveTabId = id;
    },
  };
}

describe("Workbench link presentation", () => {
  it("reuses normalized committed or pending URLs, preferring the Agent-active match", async () => {
    const f = fixture();
    f.add("first");
    f.add("last", "https://pending.example", "https://example.com");
    expect(await f.open(request())).toBe(true);
    expect(f.active()).toBe("last");
    f.setAgent("first");
    expect(await f.open(request())).toBe(true);
    expect(f.active()).toBe("first");
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(2);
  });
  it("creates distinct foreground and background tabs without stealing the active tab", async () => {
    const f = fixture();
    f.add("original");
    const initial = f.active();
    await f.open(request({ disposition: "new-background-tab" }));
    expect(f.active()).toBe(initial);
    expect(f.scene().panels.right.collapsed).toBe(false);
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(2);
    await f.open(request({ disposition: "new-tab" }));
    expect(f.active()).not.toBe(initial);
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(3);
  });
  it("reveals an initially collapsed panel for background links", async () => {
    const f = fixture();
    await f.open(request({ disposition: "new-background-tab" }));
    expect(f.scene().panels.right.collapsed).toBe(false);
    expect(f.active()).toBeTruthy();
  });
  it("projects full view and split onto the owning Browser panel", async () => {
    const f = fixture();
    await f.open(request({ presentationIntent: "full-width" }));
    expect(f.scene().panels.right.size.fullWidth).toBe(true);
    await f.open(request({ presentationIntent: "split" }));
    expect(f.scene().panels.right.size.fullWidth).toBe(false);
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(1);
  });
  it("brings a matching bottom-panel Browser into the right panel for full view", async () => {
    const f = fixture();
    f.add("bottom", url, undefined, "bottom");
    await f.open(request({ presentationIntent: "full-width" }));
    expect(findWorkbenchPanelLeafForTab(f.scene().panels.bottom.layout, "bottom")).toBeNull();
    expect(findWorkbenchPanelLeafForTab(f.scene().panels.right.layout, "bottom")?.activeTabId).toBe(
      "bottom",
    );
    expect(f.scene().panels.right.size.fullWidth).toBe(true);
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(1);
  });
  it("uses detached windows without creating an extra tab", async () => {
    const f = fixture();
    expect(await f.open(request({ presentationIntent: "new-window" }))).toBe(true);
    expect(f.openWindow).toHaveBeenCalledWith(url);
    expect(Object.keys(f.scene().panelSurfacesById)).toHaveLength(0);
  });
  for (const owner of [
    { kind: "session", sessionId: "session-a" },
    { kind: "project", projectId: "project-a" },
  ] as const) {
    for (const panelId of ["right", "bottom"] as const) {
      it.each([false, true])(
        `inserts a popup after its opener in the ${owner.kind}'s ${panelId} panel (background: %s)`,
        async (background) => {
          const f = fixture(owner);
          f.add("before", "https://before.example/", undefined, panelId);
          f.add("opener", url, undefined, panelId, "opener-runtime");
          f.add("selected", "https://selected.example/", undefined, panelId);
          const before = findWorkbenchPanelLeafForTab(f.scene().panels[panelId].layout, "opener")!;
          const existingIds = new Set(Object.keys(f.scene().panelSurfacesById));
          const location = f.windowState().windowState.location;
          const focus = f.windowState().focusedPanelGroup;

          expect(
            await f.open(
              request({
                source: "manual",
                initiator: "window_open",
                disposition: background ? "new-background-tab" : "new-tab",
              }),
              "opener-runtime",
            ),
          ).toBe(true);

          const scene = f.scene();
          const child = Object.values(scene.panelSurfacesById).find(
            (surface) => !existingIds.has(surface.id),
          )!;
          const leaf = findWorkbenchPanelLeafForTab(scene.panels[panelId].layout, child.id)!;
          expect(leaf.id).toBe(before.id);
          const expectedOrder = [...before.tabIds];
          expectedOrder.splice(expectedOrder.indexOf("opener") + 1, 0, child.id);
          expect(leaf.tabIds).toEqual(expectedOrder);
          expect(leaf.activeTabId).toBe(background ? "selected" : child.id);
          expect(child.kind === "browser" && child.config.browserTabId).not.toBe("opener-runtime");
          expect(scene.panels[panelId].collapsed).toBe(false);
          expect(f.windowState().windowState.location).toEqual(location);
          if (background) {
            expect(leaf.mruTabIds.filter((id) => id !== child.id)).toEqual(before.mruTabIds);
            expect(f.windowState().focusedPanelGroup).toEqual(focus);
          }
        },
      );
    }
  }
  it("opens a Browser request in a detached window without adding a tab", async () => {
    const f = fixture();
    f.add("opener", url, undefined, "bottom", "opener-runtime");
    const before = f.scene();
    expect(await f.open(request({ presentationIntent: "new-window" }), "opener-runtime")).toBe(
      true,
    );
    expect(f.openWindow).toHaveBeenCalledWith(url);
    expect(f.scene()).toBe(before);
  });
  it("ignores requests whose opener no longer belongs to the owner", async () => {
    const f = fixture();
    f.add("unrelated");
    const before = f.scene();
    expect(await f.open(request({ disposition: "new-tab" }), "missing-runtime")).toBe(false);
    expect(await f.open(request({ presentationIntent: "new-window" }), "missing-runtime")).toBe(
      false,
    );
    expect(f.openWindow).not.toHaveBeenCalled();
    expect(f.scene()).toBe(before);
  });
  it("uses Settings' originating scene and declines owners without Browser capability", () => {
    expect(
      linkBrowserOwner({
        kind: "settings",
        path: "/browser",
        returnTo: { kind: "session", sessionId: "a", projectContextId: null },
      }),
    ).toEqual({ kind: "session", sessionId: "a" });
    expect(linkBrowserOwner({ kind: "project", projectId: "p" })).toEqual({
      kind: "project",
      projectId: "p",
    });
    expect(linkBrowserOwner({ kind: "library" })).toBeNull();
    expect(linkBrowserOwner({ kind: "inbox" })).toBeNull();
  });
});
