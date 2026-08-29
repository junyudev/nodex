import { describe, expect, test } from "vite-plus/test";
import { WorkbenchSceneSnapshotSchema } from "./schemas/workbench-scene";
import {
  flattenWorkbenchPanelTabIds,
  getWorkbenchPanelActiveLeaf,
  moveWorkbenchPanelTab,
} from "./workbench-panel-layout";
import {
  WORKBENCH_SCENE_MAX_PANEL_SURFACES,
  activateWorkbenchSceneSurface,
  cloneWorkbenchSceneLayoutForNewWindow,
  collectWorkbenchScenePresentedPageIds,
  createWorkbenchSceneSurface,
  enforceWorkbenchSessionReviewEligibility,
  getWorkbenchSurfaceReuseKey,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  mergeWorkbenchSceneLeaf,
  migrateWorkbenchSceneV1ToV4,
  migrateWorkbenchSceneV2ToV4,
  migrateWorkbenchSceneV3ToV4,
  migrateWorkbenchSceneV4ToV5,
  moveWorkbenchSceneSurface,
  patchWorkbenchScenePanel,
  removeWorkbenchSceneSurface,
  reorderWorkbenchSceneSurfaces,
  splitWorkbenchSceneLeaf,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneIdentityFactory,
  type WorkbenchSceneSnapshot,
  type WorkbenchSceneSnapshotV1,
  type WorkbenchSceneSnapshotV2,
  type WorkbenchSceneSnapshotV4,
  type WorkbenchSurfaceDescriptor,
  type WorkbenchSurfaceDescriptorV3,
} from "./workbench-scene";

function identityFactory(prefix: string): WorkbenchSceneIdentityFactory {
  let next = 0;
  return {
    createId(kind) {
      next += 1;
      return `${prefix}:${kind}:${next}`;
    },
  };
}

function projectScene(): WorkbenchSceneSnapshot {
  return materializeInitialWorkbenchScene(
    { kind: "project", projectId: "project-1" },
    {
      identityFactory: identityFactory("project"),
      touchedAt: "2026-07-31T00:00:00.000Z",
    },
  );
}

function browserSurface(id = "browser-surface"): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "browser",
    titleSnapshot: "Browser",
    config: {
      browserTabId: "browser-runtime-1",
      browserStorageId: "browser-storage-1",
      url: "https://example.com",
    },
    stateKey: 0,
    state: null,
  };
}

function protectedPrimary(scene: WorkbenchSceneSnapshot): WorkbenchSurfaceDescriptor {
  if (!scene.primary) throw new Error("Expected a protected Scene primary");
  return scene.primary;
}

function sceneV2Fields(
  scene: WorkbenchSceneSnapshot,
): Omit<WorkbenchSceneSnapshotV2, "version" | "agentDock"> {
  if (scene.owner.kind === "pages") {
    throw new Error("Pages Scenes did not exist in Scene v2");
  }
  return {
    owner: scene.owner,
    primary: toLegacySurface(protectedPrimary(scene)),
    panelSurfacesById: Object.fromEntries(
      Object.entries(scene.panelSurfacesById).map(([surfaceId, surface]) => [
        surfaceId,
        toLegacySurface(surface),
      ]),
    ),
    panels: scene.panels,
    lastFocusedPanelId: scene.lastFocusedPanelId,
    touchedAt: scene.touchedAt,
  };
}

function toLegacySurface(surface: WorkbenchSurfaceDescriptor): WorkbenchSurfaceDescriptorV3 {
  if (surface.kind === "image_editor") {
    throw new Error("Image editor surfaces did not exist in legacy Scenes");
  }
  if (
    surface.kind !== "db_view" &&
    surface.kind !== "page_stage" &&
    surface.kind !== "canvas_stage"
  ) {
    return surface;
  }
  if (surface.config.accessContext.kind !== "project") {
    throw new Error("Legacy Scenes only carried Project resource surfaces");
  }
  const { accessContext, ...config } = surface.config;
  return {
    ...surface,
    config: {
      ...config,
      projectId: accessContext.projectId,
      ...(surface.kind === "db_view" ? { view: "board" as const } : {}),
    },
  } as WorkbenchSurfaceDescriptorV3;
}

describe("WorkbenchScene", () => {
  test("materializes Project and Session owner-root primary surfaces", () => {
    const project = projectScene();
    const session = materializeInitialWorkbenchScene(
      { kind: "session", sessionId: "session-1" },
      {
        identityFactory: identityFactory("session"),
        touchedAt: "2026-07-31T00:00:00.000Z",
      },
    );

    expect(project.primary).toMatchObject({
      kind: "db_view",
      config: {
        accessContext: { kind: "project", projectId: "project-1" },
        target: { kind: "project-default" },
      },
    });
    expect(session.primary).toMatchObject({
      kind: "conversation",
      config: { sessionId: "session-1" },
    });
    expect(project.panels.right.collapsed).toBe(false);
    expect(project.panels.right.size.fullWidth).toBe(true);
    expect(project.panels.right.layout.root).toMatchObject({
      type: "leaf",
      tabIds: [protectedPrimary(project).id],
      activeTabId: protectedPrimary(project).id,
    });
    expect(project.composerOverlay).toEqual({ visible: true });
    expect(session.composerOverlay).toEqual({ visible: true });
    expect(project.agentDock).toMatchObject({ binding: { kind: "new" } });
    expect(session.panels.right.collapsed).toBe(true);
    expect(session.agentDock).toBeNull();
    expect(project.panels.bottom.collapsed).toBe(true);
    expect(makeWorkbenchSceneKey(project.owner)).toBe("project:project-1");
    expect(makeWorkbenchSceneKey(session.owner)).toBe("session:session-1");
    const pages = materializeInitialWorkbenchScene({ kind: "pages" });
    expect(pages.primary).toBeNull();
    expect(pages.panelSurfacesById).toEqual({});
    expect(pages.panels.right.collapsed).toBe(false);
    expect(pages.panels.right.size.fullWidth).toBe(true);
    expect(pages.composerOverlay.visible).toBe(false);
    expect(pages.agentDock).toBeNull();
    expect(makeWorkbenchSceneKey(pages.owner)).toBe("pages");
    expect(WorkbenchSceneSnapshotSchema.parse(project)).toEqual(project);
    expect(WorkbenchSceneSnapshotSchema.parse(session)).toEqual(session);
    expect(WorkbenchSceneSnapshotSchema.parse(pages)).toEqual(pages);
  });

  test("owns each panel surface exactly once and never allows closing primary", () => {
    const initial = projectScene();
    const withBrowser = createWorkbenchSceneSurface(initial, {
      panelId: "right",
      surface: browserSurface(),
    });

    expect(withBrowser.panelSurfacesById["browser-surface"]).toEqual(browserSurface());
    expect(withBrowser.panels.right.layout.root).toMatchObject({
      type: "leaf",
      tabIds: [protectedPrimary(initial).id, "browser-surface"],
    });
    expect(WorkbenchSceneSnapshotSchema.parse(withBrowser)).toEqual(withBrowser);
    expect(
      createWorkbenchSceneSurface(withBrowser, {
        panelId: "bottom",
        surface: browserSurface(),
      }),
    ).toBe(withBrowser);
  });

  test("persists an exact Database View target on the protected Project primary", () => {
    const initial = projectScene();
    const primary = protectedPrimary(initial);
    const exact = updateWorkbenchSceneSurface(initial, primary.id, {
      titleSnapshot: "List",
      config: {
        accessContext: { kind: "project", projectId: "project-1" },
        target: { kind: "database-view", databaseViewId: "view-list" },
      },
    });

    expect(WorkbenchSceneSnapshotSchema.parse(exact).primary).toMatchObject({
      titleSnapshot: "List",
      config: { target: { kind: "database-view", databaseViewId: "view-list" } },
    });
  });

  test("persists image editors only through stable asset locators", () => {
    const session = materializeInitialWorkbenchScene({
      kind: "session",
      sessionId: "session-image",
    });
    const imageSurface = {
      id: "image-editor-surface",
      kind: "image_editor",
      titleSnapshot: "User attachment",
      config: {
        availableImageCount: 1,
        composerTarget: {
          channelId: "AppScope:app/ThreadScope:session:session-image::root",
          placement: "root",
        },
        entrypoint: "image_click",
        imageSource: "uploaded",
        images: [
          {
            id: "attachment-1",
            alt: "User attachment",
            source: "uploaded",
            attachmentId: "attachment-1",
            locator: {
              kind: "managed",
              source: "nodex://assets/image-1",
            },
          },
        ],
        initialImageId: "attachment-1",
        initialPlaygroundTool: "navigate",
        initialView: "single",
        projectId: null,
        threadId: null,
        tooltip: "User attachment",
      },
      stateKey: 0,
      state: null,
    };
    const durable = createWorkbenchSceneSurface(session, {
      panelId: "right",
      surface: imageSurface as WorkbenchSurfaceDescriptor,
    });

    expect(WorkbenchSceneSnapshotSchema.parse(durable)).toEqual(durable);
    expect(getWorkbenchSurfaceReuseKey(imageSurface as WorkbenchSurfaceDescriptor)).toBeNull();

    const unsafe = structuredClone(durable) as unknown as Record<string, unknown>;
    const unsafeSurface = (unsafe.panelSurfacesById as Record<string, Record<string, unknown>>)[
      imageSurface.id
    ]!;
    const unsafeConfig = unsafeSurface.config as Record<string, unknown>;
    const unsafeImages = unsafeConfig.images as Array<Record<string, unknown>>;
    unsafeImages[0] = {
      ...unsafeImages[0],
      locator: { kind: "remote", url: "data:image/png;base64,AA==" },
    };
    expect(() => WorkbenchSceneSnapshotSchema.parse(unsafe)).toThrow();

    const malformedManaged = structuredClone(durable) as unknown as Record<string, unknown>;
    const malformedSurface = (
      malformedManaged.panelSurfacesById as Record<string, Record<string, unknown>>
    )[imageSurface.id]!;
    const malformedConfig = malformedSurface.config as Record<string, unknown>;
    const malformedImages = malformedConfig.images as Array<Record<string, unknown>>;
    malformedImages[0] = {
      ...malformedImages[0],
      locator: { kind: "managed", source: "nodex://assets/folder/image.png" },
    };
    expect(() => WorkbenchSceneSnapshotSchema.parse(malformedManaged)).toThrow();
  });

  test("treats every Pages surface as ordinary and permits an empty tablist", () => {
    const pages = materializeInitialWorkbenchScene(
      { kind: "pages" },
      {
        identityFactory: identityFactory("pages"),
      },
    );
    const withPage = createWorkbenchSceneSurface(pages, {
      panelId: "right",
      surface: {
        id: "library-page",
        kind: "page_stage",
        titleSnapshot: "Library Page",
        config: {
          accessContext: { kind: "library" },
          pageId: "page:library",
        },
        stateKey: 0,
        state: null,
      },
    });

    expect(withPage.primary).toBeNull();
    expect(withPage.panelSurfacesById["library-page"]).toBeDefined();
    expect(WorkbenchSceneSnapshotSchema.parse(withPage)).toEqual(withPage);

    const empty = removeWorkbenchSceneSurface(withPage, "library-page");
    expect(empty.panelSurfacesById).toEqual({});
    expect(WorkbenchSceneSnapshotSchema.parse(empty)).toEqual(empty);
  });

  test("keeps Scene close selection at the active tab's physical index", () => {
    const withMiddle = createWorkbenchSceneSurface(projectScene(), {
      panelId: "right",
      surface: browserSurface("middle-browser"),
    });
    const withRight = createWorkbenchSceneSurface(withMiddle, {
      panelId: "right",
      surface: {
        id: "right-page",
        kind: "page_stage",
        titleSnapshot: "Right Page",
        config: {
          accessContext: { kind: "project", projectId: "project-1" },
          pageId: "page:right",
        },
        stateKey: 0,
        state: null,
      },
    });
    const leafId = withRight.panels.right.layout.activeLeafId;
    const middleActive = activateWorkbenchSceneSurface(
      withRight,
      "right",
      leafId,
      "middle-browser",
    );

    const removed = removeWorkbenchSceneSurface(middleActive, "middle-browser");

    expect(getWorkbenchPanelActiveLeaf(removed.panels.right.layout).activeTabId).toBe("right-page");
  });

  test("collects Page presence only from visible active Scene tabs", () => {
    const pageSurface: WorkbenchSurfaceDescriptor = {
      id: "visible-page",
      kind: "page_stage",
      titleSnapshot: "Visible Page",
      config: {
        accessContext: { kind: "project", projectId: "project-1" },
        pageId: "page:visible",
      },
      stateKey: 0,
      state: null,
    };
    const withPage = createWorkbenchSceneSurface(projectScene(), {
      panelId: "bottom",
      surface: pageSurface,
    });

    expect([...collectWorkbenchScenePresentedPageIds(withPage)]).toEqual(["page:visible"]);

    const withBackgroundPage = createWorkbenchSceneSurface(withPage, {
      panelId: "bottom",
      surface: browserSurface(),
    });
    expect([...collectWorkbenchScenePresentedPageIds(withBackgroundPage)]).toEqual([]);

    const collapsed = patchWorkbenchScenePanel(withPage, "bottom", {
      collapsed: true,
    });
    expect([...collectWorkbenchScenePresentedPageIds(collapsed)]).toEqual([]);
  });

  test("keeps a migrated Resource primary when the Pages surface cap is full", () => {
    const seed = projectScene();
    const primary = protectedPrimary(seed);
    const surfaces = Object.fromEntries(
      Array.from({ length: WORKBENCH_SCENE_MAX_PANEL_SURFACES }, (_, index) => {
        const id = String(index + 1);
        return [
          id,
          {
            id,
            kind: "page_stage" as const,
            titleSnapshot: `Page ${index}`,
            config: {
              accessContext: { kind: "library" as const },
              pageId: `page:${index}`,
            },
            stateKey: 0,
            state: null,
          },
        ];
      }),
    );
    const root = seed.panels.right.layout.root;
    if (root.type !== "leaf") throw new Error("Expected one right panel leaf");
    const legacy: WorkbenchSceneSnapshotV4 = {
      ...seed,
      version: 4,
      owner: {
        kind: "resource",
        root: { kind: "page", pageId: "page:root" },
      },
      primary: {
        ...primary,
        id: "library-root",
        kind: "page_stage",
        config: {
          accessContext: { kind: "library" },
          pageId: "page:root",
        },
      },
      panelSurfacesById: surfaces,
      panels: {
        ...seed.panels,
        right: {
          ...seed.panels.right,
          layout: {
            ...seed.panels.right.layout,
            root: {
              ...root,
              tabIds: ["library-root", ...Object.keys(surfaces)],
              activeTabId: "library-root",
            },
          },
        },
      },
      composerOverlay: { visible: false },
      agentDock: null,
    };

    const migrated = migrateWorkbenchSceneV4ToV5(legacy);

    expect(Object.keys(migrated.panelSurfacesById)).toHaveLength(
      WORKBENCH_SCENE_MAX_PANEL_SURFACES,
    );
    expect(migrated.panelSurfacesById["library-root"]).toBeDefined();
    expect(flattenWorkbenchPanelTabIds(migrated.panels.right.layout)).toContain("library-root");
    expect(WorkbenchSceneSnapshotSchema.parse(migrated)).toEqual(migrated);
  });

  test("drops Resource surfaces that cannot be authorized by Pages", () => {
    const seed = projectScene();
    const primary = protectedPrimary(seed);
    const root = seed.panels.right.layout.root;
    if (root.type !== "leaf") throw new Error("Expected one right panel leaf");
    const legacy: WorkbenchSceneSnapshotV4 = {
      ...seed,
      version: 4,
      owner: {
        kind: "resource",
        root: { kind: "page", pageId: "page:root" },
      },
      primary: {
        ...primary,
        id: "library-root",
        kind: "page_stage",
        config: {
          accessContext: { kind: "library" },
          pageId: "page:root",
        },
      },
      panelSurfacesById: {
        "project-page": {
          id: "project-page",
          kind: "page_stage",
          titleSnapshot: "Project Page",
          config: {
            accessContext: { kind: "project", projectId: "legacy" },
            pageId: "page:project",
          },
          stateKey: 0,
          state: null,
        },
        browser: browserSurface("browser"),
      },
      panels: {
        ...seed.panels,
        right: {
          ...seed.panels.right,
          layout: {
            ...seed.panels.right.layout,
            root: {
              ...root,
              tabIds: ["library-root", "project-page", "browser"],
              activeTabId: "project-page",
            },
          },
        },
      },
      composerOverlay: { visible: false },
      agentDock: null,
    };

    const migrated = migrateWorkbenchSceneV4ToV5(legacy);

    expect(Object.keys(migrated.panelSurfacesById)).toEqual(["library-root"]);
    expect(flattenWorkbenchPanelTabIds(migrated.panels.right.layout)).toEqual(["library-root"]);
    expect(WorkbenchSceneSnapshotSchema.parse(migrated)).toEqual(migrated);
  });

  test("rejects owner-root primary mismatches and duplicate placement", () => {
    const project = projectScene();
    const mismatched = {
      ...project,
      owner: { kind: "project", projectId: "project-2" },
    };
    expect(() => WorkbenchSceneSnapshotSchema.parse(mismatched)).toThrow();

    const withBrowser = createWorkbenchSceneSurface(project, {
      panelId: "right",
      surface: browserSurface(),
    });
    const duplicated = {
      ...withBrowser,
      panels: {
        ...withBrowser.panels,
        bottom: {
          ...withBrowser.panels.bottom,
          layout: withBrowser.panels.right.layout,
        },
      },
    };
    expect(() => WorkbenchSceneSnapshotSchema.parse(duplicated)).toThrow();
  });

  test("keeps a Project right surface stack open and full width", () => {
    const project = projectScene();
    const maximized = patchWorkbenchScenePanel(project, "right", {
      collapsed: false,
      size: { fullWidth: true },
    });
    const collapsed = patchWorkbenchScenePanel(maximized, "right", {
      collapsed: true,
    });

    expect(maximized.panels.right.size.fullWidth).toBe(true);
    expect(collapsed.panels.right.collapsed).toBe(false);
    expect(collapsed.panels.right.size.fullWidth).toBe(true);
  });

  test("protects the Project root surface through panel mutations", () => {
    const initial = createWorkbenchSceneSurface(projectScene(), {
      panelId: "right",
      surface: browserSurface(),
    });
    const rootLeafId = initial.panels.right.layout.activeLeafId;

    expect(removeWorkbenchSceneSurface(initial, protectedPrimary(initial).id)).toBe(initial);
    expect(
      moveWorkbenchSceneSurface(initial, {
        surfaceId: protectedPrimary(initial).id,
        targetPanelId: "bottom",
      }),
    ).toBe(initial);
    expect(
      splitWorkbenchSceneLeaf(initial, {
        panelId: "right",
        leafId: rootLeafId,
        side: "right",
        surfaceId: protectedPrimary(initial).id,
      }),
    ).toBe(initial);
    expect(
      mergeWorkbenchSceneLeaf(initial, {
        panelId: "right",
        leafId: rootLeafId,
      }),
    ).toBe(initial);

    const reordered = reorderWorkbenchSceneSurfaces(initial, {
      panelId: "right",
      leafId: rootLeafId,
      orderedSurfaceIds: ["browser-surface", protectedPrimary(initial).id],
    });
    expect(reordered.panels.right.layout.root).toMatchObject({
      type: "leaf",
      tabIds: [protectedPrimary(initial).id, "browser-surface"],
    });
    expect(WorkbenchSceneSnapshotSchema.parse(reordered)).toEqual(reordered);
  });

  test("migrates an active Project Conversation surface into Agent Dock", () => {
    const current = projectScene();
    if (current.panels.right.layout.root.type !== "leaf") {
      throw new Error("Expected a single Project root leaf");
    }
    const withoutDock = sceneV2Fields(current);
    const legacy: WorkbenchSceneSnapshotV1 = {
      ...withoutDock,
      version: 1,
      panelSurfacesById: {
        "conversation-1": {
          id: "conversation-1",
          kind: "conversation",
          titleSnapshot: "Investigate",
          config: { sessionId: "session-1" },
          stateKey: 0,
          state: null,
        },
      },
      panels: {
        ...current.panels,
        right: {
          ...current.panels.right,
          collapsed: true,
          size: { ...current.panels.right.size, fullWidth: false },
          layout: {
            ...current.panels.right.layout,
            root: {
              ...current.panels.right.layout.root,
              tabIds: ["conversation-1"],
              activeTabId: "conversation-1",
              mruTabIds: ["conversation-1"],
            },
          },
        },
      },
    };

    const canonical = migrateWorkbenchSceneV1ToV4(legacy);

    expect(canonical.version).toBe(4);
    expect(canonical.composerOverlay).toEqual({ visible: true });
    expect(canonical.agentDock).toEqual({
      binding: { kind: "session", sessionId: "session-1" },
      newDraftId: `agent-draft:${canonical.primary.id}`,
    });
    const currentSnapshot = WorkbenchSceneSnapshotSchema.parse(canonical);
    expect(currentSnapshot.version).toBe(7);
    expect(WorkbenchSceneSnapshotSchema.parse(legacy)).toEqual(currentSnapshot);
  });

  test("migrates v2 composer visibility into the shared Scene presentation", () => {
    const project = projectScene();
    const legacyProject: WorkbenchSceneSnapshotV2 = {
      ...sceneV2Fields(project),
      version: 2,
      agentDock: {
        ...project.agentDock!,
        visible: false,
      },
    };
    const session = materializeInitialWorkbenchScene({
      kind: "session",
      sessionId: "session-1",
    });
    const legacySession: WorkbenchSceneSnapshotV2 = {
      ...sceneV2Fields(session),
      version: 2,
      agentDock: null,
    };

    expect(migrateWorkbenchSceneV2ToV4(legacyProject).composerOverlay).toEqual({ visible: false });
    expect(migrateWorkbenchSceneV2ToV4(legacySession).composerOverlay).toEqual({ visible: true });
  });

  test("migrates v3 resource configs to explicit Project access", () => {
    const current = projectScene();
    if (current.owner.kind === "pages") {
      throw new Error("Expected a legacy-compatible Project Scene");
    }
    const legacy = {
      ...current,
      version: 3 as const,
      owner: current.owner,
      primary: toLegacySurface(protectedPrimary(current)),
      panelSurfacesById: Object.fromEntries(
        Object.entries(current.panelSurfacesById).map(([id, surface]) => [
          id,
          toLegacySurface(surface),
        ]),
      ),
    };

    const migrated = migrateWorkbenchSceneV3ToV4(legacy);

    expect(migrated.primary).toMatchObject({
      kind: "db_view",
      config: {
        accessContext: { kind: "project", projectId: "project-1" },
      },
    });
    expect(WorkbenchSceneSnapshotSchema.parse(legacy)).toEqual(
      WorkbenchSceneSnapshotSchema.parse(migrated),
    );
  });

  test("removes the v5 synthetic Database layout from Scene identity", () => {
    const current = projectScene();
    const primary = protectedPrimary(current);
    if (primary.kind !== "db_view") throw new Error("Expected Database primary");
    const legacy = {
      ...current,
      version: 5,
      primary: {
        ...primary,
        config: { ...primary.config, view: "calendar" },
      },
    };

    const migrated = WorkbenchSceneSnapshotSchema.parse(legacy);

    expect(migrated.version).toBe(7);
    expect(migrated.primary?.config).not.toHaveProperty("view");
    expect(WorkbenchSceneSnapshotSchema.parse(migrated)).toEqual(migrated);
  });

  test("new-window clone remints presentation and Browser identities", () => {
    const original = createWorkbenchSceneSurface(
      {
        ...projectScene(),
        composerOverlay: { visible: false },
      },
      {
        panelId: "right",
        surface: browserSurface(),
      },
    );
    const clone = cloneWorkbenchSceneLayoutForNewWindow(
      {
        scenesByOwnerKey: {
          [makeWorkbenchSceneKey(original.owner)]: original,
        },
      },
      identityFactory("clone"),
    ).scenesByOwnerKey["project:project-1"]!;
    const clonedBrowser = Object.values(clone.panelSurfacesById)[0];

    expect(clone.owner).toEqual(original.owner);
    expect(protectedPrimary(clone).id).not.toBe(protectedPrimary(original).id);
    expect(clone.agentDock?.newDraftId).not.toBe(original.agentDock?.newDraftId);
    expect(clone.composerOverlay).toEqual({ visible: false });
    expect(clonedBrowser?.id).not.toBe("browser-surface");
    expect(clonedBrowser?.kind).toBe("browser");
    if (clonedBrowser?.kind !== "browser") {
      throw new Error("Expected cloned Browser surface");
    }
    expect(clonedBrowser.config.browserTabId).not.toBe("browser-runtime-1");
    expect(clonedBrowser.config.browserStorageId).not.toBe("browser-storage-1");
    expect(WorkbenchSceneSnapshotSchema.parse(clone)).toEqual(clone);
  });

  test("keeps Project runtime surfaces but refuses Session-only Review", () => {
    const withTerminal = createWorkbenchSceneSurface(projectScene(), {
      panelId: "bottom",
      surface: {
        id: "terminal-surface",
        kind: "terminal",
        titleSnapshot: "Terminal",
        config: {
          terminalSessionId: "terminal-runtime-1",
          context: { kind: "project", projectId: "project-1" },
        },
        stateKey: 0,
        state: null,
      },
    });
    const withReview = createWorkbenchSceneSurface(withTerminal, {
      panelId: "right",
      surface: {
        id: "review-surface",
        kind: "review",
        titleSnapshot: "Review",
        config: { projectId: "project-1" },
        stateKey: 0,
        state: null,
      },
    });

    expect(withReview).toBe(withTerminal);
    expect(WorkbenchSceneSnapshotSchema.parse(withReview)).toEqual(withTerminal);
    expect(withReview.panelSurfacesById["terminal-surface"]?.config).toMatchObject({
      context: { kind: "project", projectId: "project-1" },
    });
    expect(withReview.panelSurfacesById["review-surface"]).toBeUndefined();
  });

  test("drops legacy Project Review surfaces while preserving the rest of the Scene", () => {
    const scene = projectScene();
    const reviewId = "legacy-project-review";
    const invalidPersistedScene = {
      ...scene,
      panelSurfacesById: {
        ...scene.panelSurfacesById,
        [reviewId]: {
          id: reviewId,
          kind: "review" as const,
          titleSnapshot: "Review",
          config: {
            projectId: "project-1",
            context: { kind: "project" as const, projectId: "project-1" },
          },
          stateKey: 0,
          state: null,
        },
      },
      panels: {
        ...scene.panels,
        right: {
          ...scene.panels.right,
          layout: moveWorkbenchPanelTab(scene.panels.right.layout, {
            tabId: reviewId,
            targetLeafId: scene.panels.right.layout.activeLeafId,
          }),
        },
      },
    };

    const recovered = WorkbenchSceneSnapshotSchema.parse(invalidPersistedScene);

    expect(recovered.panelSurfacesById[reviewId]).toBeUndefined();
    expect(flattenWorkbenchPanelTabIds(recovered.panels.right.layout)).not.toContain(reviewId);
    expect(recovered.primary).toEqual(scene.primary);
  });

  test("derives stable semantic reuse keys only for singleton resources", () => {
    const conversation = materializeInitialWorkbenchScene(
      { kind: "session", sessionId: "session-1" },
      { identityFactory: identityFactory("reuse") },
    );
    const databaseScene = projectScene();

    expect(getWorkbenchSurfaceReuseKey(protectedPrimary(conversation))).toBe(
      "conversation:session-1",
    );
    expect(getWorkbenchSurfaceReuseKey(protectedPrimary(databaseScene))).toBe(
      "db:project:project-1:default",
    );
    expect(
      getWorkbenchSurfaceReuseKey({
        id: "library-page",
        kind: "page_stage",
        titleSnapshot: "Page",
        config: {
          accessContext: { kind: "library" },
          pageId: "page-1",
        },
        stateKey: 0,
        state: null,
      }),
    ).toBe("page:library:page-1");
    expect(
      getWorkbenchSurfaceReuseKey({
        id: "review-session",
        kind: "review",
        titleSnapshot: "Review",
        config: { projectId: "project-1" },
        stateKey: 0,
        state: null,
      }),
    ).toBe("review");
    expect(
      getWorkbenchSurfaceReuseKey({
        id: "review-projectless-session",
        kind: "review",
        titleSnapshot: "Review",
        config: { projectId: null },
        stateKey: 0,
        state: null,
      }),
    ).toBe("review");
    expect(getWorkbenchSurfaceReuseKey(browserSurface())).toBeNull();
  });

  test("prunes persisted Review surfaces when a Session no longer has a Thread", () => {
    const session = materializeInitialWorkbenchScene(
      { kind: "session", sessionId: "session-1" },
      {
        identityFactory: identityFactory("threadless"),
        touchedAt: "2026-08-26T00:00:00.000Z",
      },
    );
    const withReview = createWorkbenchSceneSurface(session, {
      panelId: "right",
      surface: {
        id: "review-session",
        kind: "review",
        titleSnapshot: "Review",
        config: { projectId: "project-1" },
        stateKey: 0,
        state: null,
      },
    });

    expect(enforceWorkbenchSessionReviewEligibility(withReview, true)).toBe(withReview);
    const eligible = enforceWorkbenchSessionReviewEligibility(withReview, false);
    expect(eligible.panelSurfacesById["review-session"]).toBeUndefined();
    expect(flattenWorkbenchPanelTabIds(eligible.panels.right.layout)).not.toContain(
      "review-session",
    );
    expect(eligible.touchedAt).toBe(withReview.touchedAt);
  });
});
