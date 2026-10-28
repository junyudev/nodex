import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import { WorkbenchSceneSnapshotSchema } from "../../shared/schemas/workbench-scene";
import { openWorkbenchSceneFile } from "./workbench-scene-file-opener";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import { createWorkbenchSceneCommands } from "./workbench-scene-commands";
import { createWorkbenchSceneSurfacePresenter } from "./workbench-scene-surface-presenter";
import {
  listWorkbenchScenePreviewEntries,
  makeWorkbenchScenePreviewSlotKey,
} from "./workbench-scene-preview";
import {
  findNearestWorkbenchPanelLeafToRight,
  findWorkbenchPanelLeafForTab,
  listWorkbenchPanelLeaves,
} from "../../shared/workbench-panel-layout";
import {
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../shared/workbench-scene";
import {
  createWorkbenchSceneNavigator,
  type WorkbenchScenePreviewEntry,
  type WorkbenchSceneNavigatorPort,
} from "./workbench-scene-navigator";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function createHarness(
  options: {
    readonly sessionHasConversation?: boolean;
    readonly prepareReplace?: NonNullable<WorkbenchSceneNavigatorPort["preview"]>["prepareReplace"];
  } = {},
) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const windowOwner = getWorkbenchWindowOwner(
    createScopeHandle(getMaitaiRootView(store)),
    createDefaultWorkbenchLayoutSnapshot(),
  );
  windowOwner.initialize();
  let layoutRevision = 0;
  windowOwner.registerPersistenceCommit(async (snapshot) => ({
    ...snapshot,
    sessionId: "test-window",
    layoutRevision: ++layoutRevision,
  }));
  const executor = createWorkbenchSceneCommands(windowOwner, {
    prepareClose: async () => true,
    close: async () => {},
  });
  const selectLocation: WorkbenchSceneNavigatorPort["selectLocation"] = vi.fn((location) =>
    windowOwner.navigate(location),
  );
  const setSceneAndSelect: WorkbenchSceneNavigatorPort["setSceneAndSelect"] = vi.fn(
    (owner, update, location) => {
      windowOwner.setSceneAndNavigate(owner, update, location);
    },
  );
  const port: WorkbenchSceneNavigatorPort = {
    getScene: (owner) =>
      windowOwner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(owner)],
    presentDurable: createWorkbenchSceneSurfacePresenter(windowOwner, executor),
    hasConversation: () => options.sessionHasConversation ?? true,
    setScene(owner, update) {
      windowOwner.setScene(owner, update);
    },
    selectLocation,
    setSceneAndSelect,
    preview: {
      prepareReplace: options.prepareReplace,
      list(owner) {
        const state = windowOwner.read();
        const scene = state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(owner)];
        return scene
          ? listWorkbenchScenePreviewEntries(scene, state.ephemeralPanels.previewSurfacesByPanel)
          : [];
      },
      set(owner, panelId, leafId, surface) {
        const key = makeWorkbenchScenePreviewSlotKey(owner, panelId, leafId);
        windowOwner.dispatchEphemeral({
          type: "update",
          field: "previewSurfacesByPanel",
          update: (current) => {
            const next = { ...current };
            if (surface) next[key] = surface;
            else delete next[key];
            return next;
          },
        });
      },
    },
  };
  let nextId = 0;
  const navigator = createWorkbenchSceneNavigator(port, {
    createId(kind) {
      return `${kind}:${++nextId}`;
    },
  });
  return {
    navigator,
    windowOwner,
    get previews(): Record<string, WorkbenchScenePreviewEntry> {
      const state = windowOwner.read();
      return Object.fromEntries(
        Object.values(state.windowState.scenesByOwnerKey).flatMap((scene) =>
          listWorkbenchScenePreviewEntries(scene, state.ephemeralPanels.previewSurfacesByPanel).map(
            (entry) => [
              makeWorkbenchScenePreviewSlotKey(scene.owner, entry.panelId, entry.leafId),
              entry,
            ],
          ),
        ),
      );
    },
    get scenes() {
      return windowOwner.read().windowState.scenesByOwnerKey;
    },
    selectLocation,
    setSceneAndSelect,
  };
}

describe("WorkbenchSceneNavigator", () => {
  test("materializes and deduplicates a Project resource without creating a Session", async () => {
    const harness = createHarness();
    const owner = { kind: "project" as const, projectId: "alpha" };
    const input = {
      owner,
      request: {
        kind: "page_stage" as const,
        config: {
          routingContext: { kind: "project" as const, projectId: "alpha" },
          pageId: "page:one",
        },
        titleSnapshot: "Page One",
      },
      target: { panelId: "right" as const },
      mode: "durable" as const,
      navigation: "background" as const,
    };

    const first = await harness.navigator.presentPanelSurface(input);
    const second = await harness.navigator.presentPanelSurface(input);

    expect(first).toMatchObject({ status: "presented", reused: false });
    expect(second).toMatchObject({
      status: "presented",
      reused: true,
      surfaceId: first.status === "presented" ? first.surfaceId : "",
    });
    const scene = harness.scenes[makeWorkbenchSceneKey(owner)];
    expect(scene.primary?.kind).toBe("inbox");
    expect(scene.panels.right.collapsed).toBe(false);
    expect(Object.values(scene.panelSurfacesById)).toHaveLength(1);
  });

  test("keeps Scene previews ephemeral, replaces them per leaf, and promotes the same identity", async () => {
    const harness = createHarness();
    const owner = { kind: "project" as const, projectId: "alpha" };
    const present = (pageId: string, mode: "preview" | "durable" = "preview") =>
      harness.navigator.presentPanelSurface({
        owner,
        request: {
          kind: "page_stage" as const,
          config: {
            routingContext: { kind: "project" as const, projectId: "alpha" },
            pageId,
          },
          titleSnapshot: pageId,
        },
        target: { panelId: "right" as const },
        mode,
        navigation: "background" as const,
      });

    const first = await present("page:one");
    const second = await present("page:two");
    const sceneBeforePin = harness.scenes[makeWorkbenchSceneKey(owner)];
    const previewBeforePin = Object.values(harness.previews)[0];

    expect(first).toMatchObject({ status: "presented", reused: false });
    expect(second).toMatchObject({ status: "presented", reused: false });
    expect(Object.values(sceneBeforePin.panelSurfacesById)).toEqual([]);
    expect(Object.values(harness.previews)).toHaveLength(1);
    expect(previewBeforePin?.surface).toMatchObject({
      id: second.status === "presented" ? second.surfaceId : "",
      kind: "page_stage",
      config: { pageId: "page:two" },
    });

    const pinned = await present("page:two", "durable");
    const sceneAfterPin = harness.scenes[makeWorkbenchSceneKey(owner)];

    expect(pinned).toMatchObject({
      status: "presented",
      reused: true,
      surfaceId: previewBeforePin?.surface.id,
    });
    expect(harness.previews).toEqual({});
    expect(sceneAfterPin.panelSurfacesById[previewBeforePin!.surface.id]).toMatchObject({
      kind: "page_stage",
      config: { pageId: "page:two" },
    });

    await present("page:two", "preview");
    expect(harness.previews).toEqual({});
    expect(Object.values(sceneAfterPin.panelSurfacesById)).toHaveLength(1);
  });

  test("pins and closes a Scene preview through the explicit preview commands", async () => {
    const harness = createHarness();
    const owner = { kind: "library" as const };
    const result = await harness.navigator.presentPanelSurface({
      owner,
      request: {
        kind: "page_stage",
        config: {
          routingContext: { kind: "library" },
          pageId: "page:one",
        },
      },
      target: { panelId: "right" },
      mode: "preview",
      navigation: "background",
    });
    if (result.status !== "presented") throw new Error("Expected preview");
    const entry = Object.values(harness.previews)[0];
    if (!entry) throw new Error("Expected preview entry");

    expect(
      harness.navigator.clearPreview({
        owner,
        panelId: entry.panelId,
        leafId: entry.leafId,
        surfaceId: "another-surface",
      }),
    ).toBe(false);
    expect(
      harness.navigator.pinPreview({
        owner,
        panelId: entry.panelId,
        leafId: entry.leafId,
        surfaceId: result.surfaceId,
      }),
    ).toBe(true);
    expect(harness.previews).toEqual({});
    expect(harness.scenes.library?.panelSurfacesById[result.surfaceId]).toMatchObject({
      kind: "page_stage",
    });
  });

  test("rejects Conversation panel surfaces for every Scene owner", async () => {
    const harness = createHarness();
    const owners = [
      { kind: "project" as const, projectId: "alpha" },
      { kind: "session" as const, sessionId: "session-1" },
    ];

    for (const owner of owners) {
      await expect(
        harness.navigator.presentPanelSurface({
          owner,
          request: {
            kind: "conversation",
            sessionId: "session-1",
          },
          target: { panelId: "right" },
          mode: "durable",
          navigation: "background",
        }),
      ).resolves.toEqual({
        status: "unavailable",
        reason: "Conversation is the Session Scene primary, not a panel surface",
      });
    }
    expect(harness.scenes).toEqual({});
  });

  test("rejects Review surfaces in a Project Scene", async () => {
    const harness = createHarness();

    await expect(
      harness.navigator.presentPanelSurface({
        owner: { kind: "project", projectId: "alpha" },
        request: {
          kind: "review",
          config: { projectId: "alpha" },
        },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "background",
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Review requires an attached Session",
    });
    expect(harness.scenes).toEqual({});
  });

  test("rejects Review surfaces in a threadless Session Scene", async () => {
    const harness = createHarness({ sessionHasConversation: false });

    await expect(
      harness.navigator.presentPanelSurface({
        owner: { kind: "session", sessionId: "session-1" },
        request: {
          kind: "review",
          config: { projectId: "alpha" },
        },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "background",
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "Review requires a started conversation",
    });
    expect(harness.scenes).toEqual({});
  });

  test("opens Project Home database pages in an adjacent right group", async () => {
    const harness = createHarness();
    const owner = { kind: "project" as const, projectId: "alpha" };
    const ownerKey = makeWorkbenchSceneKey(owner);
    let nextSeedId = 0;
    const initial = materializeInitialWorkbenchScene(owner, {
      identityFactory: {
        createId(kind) {
          nextSeedId += 1;
          return `seed:${kind}:${nextSeedId}`;
        },
      },
    });
    harness.windowOwner.setScene(initial.owner, initial);
    if (!initial.primary) throw new Error("Expected Project primary");
    const primaryId = initial.primary.id;
    const sourceLeaf = findWorkbenchPanelLeafForTab(initial.panels.right.layout, primaryId);
    if (!sourceLeaf) throw new Error("Expected Project Home source leaf");

    const presentPage = (pageId: string) =>
      harness.navigator.presentPanelSurface({
        owner,
        request: {
          kind: "page_stage",
          config: {
            routingContext: { kind: "project", projectId: "alpha" },
            pageId,
          },
          titleSnapshot: pageId,
        },
        target: {
          panelId: "right",
          placement: {
            kind: "adjacent-right",
            sourceSurfaceId: primaryId,
          },
        },
        mode: "durable",
        navigation: "background",
      });

    const first = await presentPage("page:one");
    expect(first).toMatchObject({ status: "presented", reused: false });
    const afterFirst = harness.scenes[ownerKey];
    const afterFirstLeaves = listWorkbenchPanelLeaves(afterFirst.panels.right.layout);
    expect(afterFirstLeaves).toHaveLength(2);
    const firstSurface = Object.values(afterFirst.panelSurfacesById).find(
      (surface) => surface.kind === "page_stage" && surface.config.pageId === "page:one",
    );
    if (!firstSurface) throw new Error("Expected first Page surface");
    const firstPageLeaf = findWorkbenchPanelLeafForTab(
      afterFirst.panels.right.layout,
      firstSurface.id,
    );
    expect(firstPageLeaf?.id).toBe(
      findNearestWorkbenchPanelLeafToRight(afterFirst.panels.right.layout, sourceLeaf.id),
    );

    await presentPage("page:two");
    const afterSecond = harness.scenes[ownerKey];
    expect(listWorkbenchPanelLeaves(afterSecond.panels.right.layout)).toHaveLength(2);
    const secondSurface = Object.values(afterSecond.panelSurfacesById).find(
      (surface) => surface.kind === "page_stage" && surface.config.pageId === "page:two",
    );
    if (!secondSurface) throw new Error("Expected second Page surface");
    const secondPageLeaf = findWorkbenchPanelLeafForTab(
      afterSecond.panels.right.layout,
      secondSurface.id,
    );
    expect(secondPageLeaf?.id).toBe(firstPageLeaf?.id);
    expect(secondPageLeaf?.tabIds).toEqual([firstSurface.id, secondSurface.id]);
  });

  test("keeps source-relative Page navigation in the source tab group", async () => {
    const harness = createHarness();
    const owner = { kind: "library" as const };
    const request = (pageId: string) => ({
      kind: "page_stage" as const,
      config: {
        routingContext: { kind: "library" as const },
        pageId,
      },
      titleSnapshot: pageId,
    });
    const source = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:source"),
      target: { panelId: "right" },
      mode: "durable",
      navigation: "background",
    });
    if (source.status !== "presented") throw new Error("Expected source Page");
    const distractor = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:distractor"),
      target: {
        panelId: "right",
        placement: {
          kind: "adjacent-right",
          sourceSurfaceId: source.surfaceId,
        },
      },
      mode: "durable",
      navigation: "background",
    });
    if (distractor.status !== "presented") throw new Error("Expected distractor Page");

    const child = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:child"),
      target: {
        panelId: "right",
        placement: {
          kind: "same-group",
          sourceSurfaceId: source.surfaceId,
        },
      },
      mode: "durable",
      navigation: "background",
    });
    if (child.status !== "presented") throw new Error("Expected child Page");

    const scene = harness.scenes.library!;
    const sourceLeaf = findWorkbenchPanelLeafForTab(scene.panels.right.layout, source.surfaceId);
    const distractorLeaf = findWorkbenchPanelLeafForTab(
      scene.panels.right.layout,
      distractor.surfaceId,
    );
    const childLeaf = findWorkbenchPanelLeafForTab(scene.panels.right.layout, child.surfaceId);
    expect(sourceLeaf?.id).not.toBe(distractorLeaf?.id);
    expect(childLeaf?.id).toBe(sourceLeaf?.id);
    expect(childLeaf?.tabIds).toEqual([source.surfaceId, child.surfaceId]);
  });

  test("resolves same-group navigation from an ephemeral Page preview", async () => {
    const harness = createHarness();
    const owner = { kind: "library" as const };
    const request = (pageId: string) => ({
      kind: "page_stage" as const,
      config: {
        routingContext: { kind: "library" as const },
        pageId,
      },
      titleSnapshot: pageId,
    });
    const anchor = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:anchor"),
      target: { panelId: "right" },
      mode: "durable",
      navigation: "background",
    });
    if (anchor.status !== "presented") throw new Error("Expected anchor Page");
    const other = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:other"),
      target: {
        panelId: "right",
        placement: { kind: "adjacent-right", sourceSurfaceId: anchor.surfaceId },
      },
      mode: "durable",
      navigation: "background",
    });
    if (other.status !== "presented") throw new Error("Expected other Page");
    const sceneBeforePreview = harness.scenes.library!;
    const anchorLeaf = findWorkbenchPanelLeafForTab(
      sceneBeforePreview.panels.right.layout,
      anchor.surfaceId,
    );
    if (!anchorLeaf) throw new Error("Expected anchor leaf");
    const preview = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:preview"),
      target: { panelId: "right", leafId: anchorLeaf.id },
      mode: "preview",
      navigation: "background",
    });
    if (preview.status !== "presented") throw new Error("Expected preview Page");

    const child = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:child"),
      target: {
        panelId: "right",
        placement: { kind: "same-group", sourceSurfaceId: preview.surfaceId },
      },
      mode: "durable",
      navigation: "background",
    });
    if (child.status !== "presented") throw new Error("Expected child Page");

    const scene = harness.scenes.library!;
    expect(findWorkbenchPanelLeafForTab(scene.panels.right.layout, child.surfaceId)?.id).toBe(
      anchorLeaf.id,
    );
    expect(findWorkbenchPanelLeafForTab(scene.panels.right.layout, other.surfaceId)?.id).not.toBe(
      anchorLeaf.id,
    );
  });

  test("preserves Project context when selecting a Session owner", () => {
    const harness = createHarness();

    harness.navigator.openSession({ id: "session:one", projectId: "alpha" });

    expect(harness.windowOwner.read().windowState.location).toEqual({
      kind: "session",
      sessionId: "session:one",
      projectContextId: "alpha",
    });
  });

  test("presents a Page in a selected Session owner without creating a Thread", async () => {
    const harness = createHarness();
    const owner = { kind: "session" as const, sessionId: "session:one" };
    const input = {
      owner,
      request: {
        kind: "page_stage" as const,
        config: {
          routingContext: { kind: "project" as const, projectId: "alpha" },
          pageId: "page:one",
        },
        titleSnapshot: "Page One",
      },
      target: { panelId: "right" as const },
      mode: "durable" as const,
      navigation: "select-owner" as const,
    };

    const first = await harness.navigator.presentPanelSurface(input);
    const second = await harness.navigator.presentPanelSurface(input);
    const scene = harness.scenes[makeWorkbenchSceneKey(owner)];

    expect(first).toMatchObject({ status: "presented", reused: false });
    expect(second).toMatchObject({
      status: "presented",
      reused: true,
      surfaceId: first.status === "presented" ? first.surfaceId : "",
    });
    expect(scene.primary?.kind).toBe("conversation");
    expect(scene.panels.right.collapsed).toBe(false);
    expect(scene.panels.right.size.fullWidth).toBe(false);
    expect(Object.values(scene.panelSurfacesById)).toHaveLength(1);
    expect(harness.windowOwner.read().windowState.location).toEqual({
      kind: "session",
      sessionId: "session:one",
      projectContextId: null,
    });
  });

  test("puts Pages beside another Session in order, the first active, without leaving", async () => {
    const harness = createHarness();
    harness.navigator.openLibrary();
    const owner = { kind: "session" as const, sessionId: "session:new" };
    const present = (pageId: string, tab: "activate" | "background") =>
      harness.navigator.presentPanelSurface({
        owner,
        request: {
          kind: "page_stage",
          config: { routingContext: { kind: "library" }, pageId },
          titleSnapshot: pageId,
        },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "background",
        tab,
      });

    const first = await present("page:first", "activate");
    const second = await present("page:second", "background");
    const scene = harness.scenes[makeWorkbenchSceneKey(owner)];
    const [leaf] = listWorkbenchPanelLeaves(scene.panels.right.layout);

    expect([first.status, second.status]).toEqual(["presented", "presented"]);
    expect(leaf.tabIds.map((id) => scene.panelSurfacesById[id].titleSnapshot)).toEqual([
      "page:first",
      "page:second",
    ]);
    expect(scene.panelSurfacesById[leaf.activeTabId!].titleSnapshot).toBe("page:first");
    expect(scene.panels.right.collapsed).toBe(false);
    expect(harness.windowOwner.read().windowState.location).toEqual({ kind: "library" });
  });

  test("opens the singleton Library Scene", () => {
    const harness = createHarness();

    harness.navigator.openLibrary();

    expect(harness.windowOwner.read().windowState.location).toEqual({
      kind: "library",
    });
  });

  test("opens and focuses Library targets in one Library tablist", async () => {
    const harness = createHarness();
    const owner = { kind: "library" as const };
    const present = (pageId: string) =>
      harness.navigator.presentPanelSurface({
        owner,
        request: {
          kind: "page_stage" as const,
          config: {
            routingContext: { kind: "library" as const },
            pageId,
          },
          titleSnapshot: pageId,
        },
        target: { panelId: "right" as const },
        mode: "durable" as const,
        navigation: "select-owner" as const,
      });

    const first = await present("page:one");
    await present("page:two");
    const reused = await present("page:one");

    expect(first).toMatchObject({ status: "presented", reused: false });
    expect(reused).toMatchObject({ status: "presented", reused: true });
    expect(Object.keys(harness.scenes)).toEqual(["library"]);
    expect(Object.values(harness.scenes.library!.panelSurfacesById)).toHaveLength(2);
    expect(harness.windowOwner.read().windowState.location).toEqual({ kind: "library" });
    expect(harness.windowOwner.read().windowState.history.backStack.length).toBeGreaterThan(0);
  });

  test("keeps nested Library navigation with a bottom-panel source", async () => {
    const harness = createHarness();
    const owner = { kind: "library" as const };
    const request = (pageId: string) => ({
      kind: "page_stage" as const,
      config: {
        routingContext: { kind: "library" as const },
        pageId,
      },
      titleSnapshot: pageId,
    });
    const first = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:parent"),
      target: { panelId: "bottom" },
      mode: "durable",
      navigation: "background",
    });
    if (first.status !== "presented") throw new Error("Expected parent Page");

    const second = await harness.navigator.presentPanelSurface({
      owner,
      request: request("page:child"),
      target: {
        panelId: "right",
        placement: { kind: "same-group", sourceSurfaceId: first.surfaceId },
      },
      mode: "durable",
      navigation: "background",
    });
    if (second.status !== "presented") throw new Error("Expected child Page");

    const scene = harness.scenes.library!;
    expect(
      findWorkbenchPanelLeafForTab(scene.panels.bottom.layout, second.surfaceId)?.tabIds,
    ).toEqual([first.surfaceId, second.surfaceId]);
    expect(findWorkbenchPanelLeafForTab(scene.panels.right.layout, second.surfaceId)).toBeNull();
  });

  test("rejects execution-only surfaces in the Library Scene", async () => {
    const harness = createHarness();
    const owner = {
      kind: "library" as const,
    };

    await expect(
      harness.navigator.presentPanelSurface({
        owner,
        request: {
          kind: "terminal",
          config: {},
        },
        target: { panelId: "right" },
        mode: "durable",
        navigation: "background",
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "This surface requires a Project or chat",
    });
    expect(harness.scenes).toEqual({});
  });
});

test("opens host files in Project, Library, and Inbox Scenes without a Session", async () => {
  for (const owner of [
    { kind: "project" as const, projectId: "alpha" },
    { kind: "library" as const },
    { kind: "inbox" as const },
  ]) {
    const harness = createHarness();
    const opened = await openWorkbenchSceneFile({
      owner,
      navigator: harness.navigator,
      projects: [],
      input: {
        hostId: "remote",
        path: "/work/src/code.ts",
        title: "code.ts",
        panelId: "bottom",
        workspaceRoot: "/work",
        location: { line: 12, column: 8 },
      },
    });
    expect(opened).toBe(true);
    expect(Object.keys(harness.scenes)).toEqual([makeWorkbenchSceneKey(owner)]);
    const preview = Object.values(harness.previews)[0]!;
    expect(preview.panelId).toBe("bottom");
    expect(preview.surface).toMatchObject({
      kind: "files",
      config: {
        hostId: "remote",
        path: "/work/src/code.ts",
        projectId: owner.kind === "project" ? "alpha" : null,
      },
      state: { pendingReveal: { line: 12, column: 8 } },
    });
    expect(harness.scenes[makeWorkbenchSceneKey(owner)]!.primary?.kind).not.toBe("conversation");
  }
});

test("reuses a file preview and durable tab while delivering each precise reveal", async () => {
  const harness = createHarness();
  const owner = { kind: "library" as const };
  const open = (line: number, mode: "preview" | "durable" = "preview") =>
    openWorkbenchSceneFile({
      owner,
      navigator: harness.navigator,
      projects: [],
      input: {
        path: "/work/file.ts",
        title: "file.ts",
        panelId: "right",
        mode,
        location: { line, column: 3, endLine: line, endColumn: 7 },
      },
    });
  expect(await open(10)).toBe(true);
  const first = Object.values(harness.previews)[0]!.surface;
  expect(await open(20)).toBe(true);
  const second = Object.values(harness.previews)[0]!.surface;
  expect(second.id).toBe(first.id);
  expect(second.stateKey).toBeGreaterThan(first.stateKey);
  expect(second.state).toMatchObject({
    pendingReveal: { line: 20, column: 3, endLine: 20, endColumn: 7 },
  });
  expect(await open(30, "durable")).toBe(true);
  expect(harness.previews).toEqual({});
  const third = harness.scenes.library!.panelSurfacesById[first.id]!;
  expect(third.state).toMatchObject({ pendingReveal: { line: 30, column: 3 } });
  expect(await open(40)).toBe(true);
  const final = harness.scenes.library!;
  expect(Object.keys(final.panelSurfacesById)).toEqual([first.id]);
  expect(final.panelSurfacesById[first.id]!.state).toMatchObject({
    pendingReveal: { line: 40, column: 3 },
  });
  expect(WorkbenchSceneSnapshotSchema.parse(JSON.parse(JSON.stringify(final)))).toEqual(final);
});

test("a failed save or revoked file opening cannot replace the current Scene preview", async () => {
  const prepareReplace = vi
    .fn<NonNullable<NonNullable<WorkbenchSceneNavigatorPort["preview"]>["prepareReplace"]>>()
    .mockResolvedValue(false);
  const harness = createHarness({ prepareReplace });
  const owner = { kind: "inbox" as const };
  const open = (path: string, isCurrent?: () => boolean) =>
    openWorkbenchSceneFile({
      owner,
      navigator: harness.navigator,
      projects: [],
      input: { path, title: path, panelId: "right", isCurrent },
    });
  expect(await open("/work/first.ts")).toBe(true);
  await expect(open("/work/second.ts")).rejects.toThrow("Save pending changes");
  expect(Object.values(harness.previews)[0]!.surface).toMatchObject({
    config: { path: "/work/first.ts" },
  });
  let finish!: (result: boolean) => void;
  prepareReplace.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let current = true;
  const pending = open("/work/third.ts", () => current);
  await Promise.resolve();
  current = false;
  finish(true);
  expect(await pending).toBe(false);
  expect(Object.values(harness.previews)[0]!.surface).toMatchObject({
    config: { path: "/work/first.ts" },
  });
});
