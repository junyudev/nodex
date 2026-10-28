import { describe, expect, test } from "vite-plus/test";
import { parseDatabaseId } from "../database-identities";

import {
  createDefaultWorkbenchLayoutSnapshotV3,
  createDefaultWorkbenchLayoutSnapshotV4,
  createDefaultWorkbenchLayoutSnapshotV6,
  createDefaultWorkbenchLayoutSnapshotV7,
  createDefaultWorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshot,
  type WorkbenchLayoutSnapshotV7,
} from "../workbench-layout";
import {
  createEmptyWorkbenchSessionView,
  materializeInitialWorkbenchSessionView,
} from "../workbench-session-view";
import {
  LIBRARY_SCENE_OWNER,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
} from "../workbench-scene";
import {
  WorkbenchLayoutSnapshotSchema,
  WorkbenchLayoutSnapshotV3Schema,
  WorkbenchLayoutSnapshotV4Schema,
  WorkbenchLayoutSnapshotV5Schema,
  WorkbenchLayoutSnapshotV7Schema,
} from "./workbench-layout";

describe("WorkbenchLayoutSnapshotSchema", () => {
  test("round-trips Session side and full view with Chat selected without a version change", () => {
    const scene = patchWorkbenchScenePanel(
      materializeInitialWorkbenchScene({ kind: "session", sessionId: "session-1" }),
      "right",
      { side: "left", collapsed: true, size: { fullWidth: true } },
    );
    const layout = {
      ...createDefaultWorkbenchLayoutSnapshot(),
      scenesByOwnerKey: { "session:session-1": scene },
    };
    const restored = WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(layout)));
    expect(restored.scenesByOwnerKey["session:session-1"]).toEqual(scene);
  });

  test("migrates the v1 Card navigation vocabulary to Page coordinates", () => {
    const current = createDefaultWorkbenchLayoutSnapshotV3();
    const legacyBase: Record<string, unknown> = { ...current };
    delete legacyBase.activePagesTabId;
    delete legacyBase.recentPageSessions;
    delete legacyBase.pageStage;
    const parsed = WorkbenchLayoutSnapshotV3Schema.parse({
      ...legacyBase,
      version: 1,
      focusedStage: "cards",
      activeCardsTabId: "session:legacy",
      recentCardSessions: [
        {
          id: "legacy",
          projectId: "project-1",
          cardId: "page-1",
          titleSnapshot: "Legacy Page",
          lastOpenedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      cardStage: {
        open: true,
        projectId: "project-1",
        cardId: "page-1",
      },
      dock: {
        width: 560,
        tree: {
          type: "leaf",
          id: "legacy-leaf",
          tabs: [{ id: "cardstage", kind: "cardstage", title: "Page" }],
          activeTabId: "cardstage",
        },
      },
    });

    expect(parsed).toMatchObject({
      version: 3,
      focusedStage: "pages",
      activePagesTabId: "session:legacy",
      recentPageSessions: [{ pageId: "page-1" }],
      pageStage: { pageId: "page-1" },
      dock: {
        tree: {
          tabs: [{ id: "pagestage", kind: "pagestage" }],
          activeTabId: "pagestage",
        },
      },
    });
  });

  test("migrates the v2 Space order key to Project order", () => {
    const current = createDefaultWorkbenchLayoutSnapshotV3();
    const legacy: Record<string, unknown> = { ...current };
    delete legacy.projectOrder;

    const parsed = WorkbenchLayoutSnapshotV3Schema.parse({
      ...legacy,
      version: 2,
      spaceOrder: ["ops", "default"],
    });

    expect(parsed.projectOrder).toEqual(["ops", "default"]);
    expect(parsed.version).toBe(3);
    expect(parsed.sessionViewsBySessionId).toEqual({});
    expect("spaceOrder" in parsed).toBe(false);
  });

  test("drops retired top-level sidebar section preferences", () => {
    const current = createDefaultWorkbenchLayoutSnapshotV3();
    const parsed = WorkbenchLayoutSnapshotV3Schema.parse({
      ...current,
      sidebar: {
        ...current.sidebar,
        topLevelSectionOrder: ["recents", "pages", "threads", "files"],
        topLevelSections: {
          recents: { visible: false, itemLimit: 5 },
        },
      },
    });

    expect("topLevelSectionOrder" in parsed.sidebar).toBe(false);
    expect("topLevelSections" in parsed.sidebar).toBe(false);
  });
});

describe("WorkbenchLayoutSnapshotV4Schema", () => {
  test("migrates v3 selection and preserves only live window state", () => {
    const legacy = createDefaultWorkbenchLayoutSnapshotV3();
    const sessionView = createEmptyWorkbenchSessionView("session:alpha");
    const parsed = WorkbenchLayoutSnapshotV4Schema.parse({
      ...legacy,
      activeProjectSessionId: "session:alpha",
      dbProjectId: "alpha",
      searchByProject: {
        alpha: "owner:me",
      },
      sessionViewsBySessionId: {
        "session:alpha": sessionView,
      },
      focusedStage: "files",
      projectOrder: ["alpha"],
      recentPageSessions: [
        {
          id: "recent",
          projectId: "alpha",
          pageId: "page:one",
          titleSnapshot: "Page",
          lastOpenedAt: "2026-07-28T00:00:00.000Z",
        },
      ],
    });

    expect(parsed).toEqual({
      version: 4,
      location: {
        kind: "session",
        activeProjectId: "alpha",
        sessionId: "session:alpha",
      },
      databaseSearchByProject: {
        alpha: "owner:me",
      },
      sessionViewsBySessionId: {
        "session:alpha": sessionView,
      },
    });
    expect("focusedStage" in parsed).toBe(false);
    expect("projectOrder" in parsed).toBe(false);
    expect("recentPageSessions" in parsed).toBe(false);
  });

  test("keeps invalid selected session identity for catalog reconciliation", () => {
    const parsed = WorkbenchLayoutSnapshotV4Schema.parse({
      ...createDefaultWorkbenchLayoutSnapshotV4(),
      location: {
        kind: "session",
        activeProjectId: "alpha",
        sessionId: "session:not-in-catalog",
      },
    });

    expect(parsed.location).toEqual({
      kind: "session",
      activeProjectId: "alpha",
      sessionId: "session:not-in-catalog",
    });
  });

  test("folds a transient pending worktree route to its return location", () => {
    const parsed = WorkbenchLayoutSnapshotV4Schema.parse({
      ...createDefaultWorkbenchLayoutSnapshotV4(),
      location: {
        kind: "pending-worktree",
        clientThreadId: "client:one",
        returnTo: {
          kind: "session",
          activeProjectId: null,
          sessionId: "session:projectless",
        },
      },
    });

    expect(parsed.location).toEqual({
      kind: "session",
      activeProjectId: null,
      sessionId: "session:projectless",
    });
  });

  test("round trips deterministically", () => {
    const input = {
      version: 4,
      location: {
        kind: "library",
        target: {
          kind: "view",
          viewId: "view:alpha",
          projectId: "alpha",
        },
        returnTo: {
          kind: "empty",
          activeProjectId: "alpha",
        },
      },
      databaseSearchByProject: {
        alpha: "status:open",
      },
      sessionViewsBySessionId: {},
    } as const;

    const first = WorkbenchLayoutSnapshotV4Schema.parse(input);
    const second = WorkbenchLayoutSnapshotV4Schema.parse(JSON.parse(JSON.stringify(first)));

    expect(second).toEqual(first);
  });
});

describe("WorkbenchLayoutSnapshotV5Schema", () => {
  test("migrates a Session view to an owner Scene without changing panel geometry", () => {
    let next = 0;
    const legacyView = materializeInitialWorkbenchSessionView(
      {
        id: "session:alpha",
        projectId: "alpha",
        databaseViewId: "view:alpha",
      },
      {
        identityFactory: {
          createId(kind) {
            next += 1;
            return `${kind}:${next}`;
          },
        },
        touchedAt: "2026-07-31T00:00:00.000Z",
      },
    );
    const legacy = {
      ...createDefaultWorkbenchLayoutSnapshotV4(),
      location: {
        kind: "session",
        activeProjectId: "alpha",
        sessionId: "session:alpha",
      },
      databaseSearchByProject: { alpha: "status:open" },
      sessionViewsBySessionId: {
        "session:alpha": legacyView,
      },
    } as const;

    const migrated = WorkbenchLayoutSnapshotV5Schema.parse(legacy);
    const scene = migrated.scenesByOwnerKey["session:session:alpha"];

    expect(migrated.location).toEqual({
      kind: "session",
      sessionId: "session:alpha",
      projectContextId: "alpha",
    });
    expect(migrated.databaseSearchByProject).toEqual({
      alpha: "status:open",
    });
    expect(scene?.primary).toMatchObject({
      id: "primary",
      kind: "conversation",
      config: { sessionId: "session:alpha" },
    });
    expect(Object.values(scene?.panelSurfacesById ?? {})).toEqual([
      expect.objectContaining({
        kind: "db_view",
        config: {
          projectId: "alpha",
          target: {
            kind: "database-view",
            databaseViewId: "view:alpha",
          },
          view: "board",
        },
      }),
    ]);
    expect(scene?.panels).toEqual(legacyView.panels);
    expect(scene?.panels.right.size.fullWidth).toBe(true);
    expect(WorkbenchLayoutSnapshotV5Schema.parse(migrated)).toEqual(migrated);
  });

  test("promotes selected Project context to a first-class Project location", () => {
    const migrated = WorkbenchLayoutSnapshotV5Schema.parse({
      ...createDefaultWorkbenchLayoutSnapshotV4(),
      location: {
        kind: "library",
        target: { kind: "home" },
        returnTo: {
          kind: "empty",
          activeProjectId: "alpha",
        },
      },
    });

    expect(migrated.location).toEqual({
      kind: "library",
      target: { kind: "home" },
      returnTo: {
        kind: "project",
        projectId: "alpha",
      },
    });
    expect(migrated.scenesByOwnerKey).toEqual({});
  });

  test("folds pending routes and rejects non-canonical Scene map keys", () => {
    const projectScene = {
      version: 3,
      owner: { kind: "project", projectId: "alpha" },
      primary: {
        id: "primary",
        kind: "db_view",
        titleSnapshot: "Database",
        config: {
          projectId: "alpha",
          target: { kind: "project-default" },
          view: "board",
        },
        stateKey: 0,
        state: null,
      },
      panelSurfacesById: {},
      panels: createEmptyWorkbenchSessionView("legacy").panels,
      lastFocusedPanelId: null,
      composerOverlay: { visible: true },
      agentDock: {
        binding: { kind: "new" },
        newDraftId: "agent-draft:primary",
      },
      touchedAt: "2026-07-31T00:00:00.000Z",
    } as const;
    const input = {
      version: 5,
      location: {
        kind: "pending-worktree",
        clientThreadId: "client:one",
        returnTo: { kind: "project", projectId: "alpha" },
      },
      databaseSearchByProject: {},
      scenesByOwnerKey: {
        "project:alpha": projectScene,
      },
    } as const;

    expect(WorkbenchLayoutSnapshotV5Schema.parse(input).location).toEqual({
      kind: "project",
      projectId: "alpha",
    });
    expect(() =>
      WorkbenchLayoutSnapshotV5Schema.parse({
        ...input,
        location: input.location.returnTo,
        scenesByOwnerKey: { wrong: projectScene },
      }),
    ).toThrow();
  });
});

describe("WorkbenchLayoutSnapshotV6Schema", () => {
  test("folds the retired Library route and migrates Scene resource access", () => {
    const currentScene = materializeInitialWorkbenchScene({
      kind: "project",
      projectId: "alpha",
    });
    if (!currentScene.primary) throw new Error("Expected a Project Home");
    // Before v8 a Project's Home was its default Database View.
    const legacyScene = {
      ...currentScene,
      version: 3,
      primary: {
        ...currentScene.primary,
        kind: "db_view",
        titleSnapshot: "Database",
        config: {
          projectId: "alpha",
          target: { kind: "project-default" },
          view: "board",
        },
      },
    } as const;

    const migrated = WorkbenchLayoutSnapshotSchema.parse({
      version: 5,
      location: {
        kind: "library",
        target: { kind: "home" },
        returnTo: { kind: "project", projectId: "alpha" },
      },
      databaseSearchByProject: { alpha: "owner:me" },
      scenesByOwnerKey: { "project:alpha": legacyScene },
    });

    expect(migrated).toMatchObject({
      version: 9,
      location: { kind: "project", projectId: "alpha" },
      databaseSearchByProject: { alpha: "owner:me" },
    });
    // The old Home becomes the Project's Inbox in the same place.
    expect(migrated.scenesByOwnerKey["project:alpha"]?.primary).toMatchObject({
      id: currentScene.primary.id,
      kind: "inbox",
      config: { scope: { kind: "project", projectId: "alpha" } },
    });
  });

  test("migrates the active standalone Resource Scene into the Library Scene", () => {
    const root = {
      kind: "database" as const,
      databaseId: parseDatabaseId("database:alpha"),
    };
    const seed = materializeInitialWorkbenchScene({
      kind: "project",
      projectId: "legacy",
    });
    if (!seed.primary) throw new Error("Expected seed primary");
    const primary = {
      ...seed.primary,
      kind: "db_view" as const,
      titleSnapshot: "Library Database",
      config: {
        routingContext: { kind: "library" as const },
        target: { kind: "database-default" as const, databaseId: root.databaseId },
        view: "board" as const,
      },
    };
    const rightRoot = seed.panels.right.layout.root;
    if (rightRoot.type !== "leaf") throw new Error("Expected one right leaf");
    const scene = {
      ...seed,
      version: 4 as const,
      owner: { kind: "resource" as const, root },
      primary,
      panelSurfacesById: {
        "legacy-project-page": {
          id: "legacy-project-page",
          kind: "page_stage" as const,
          titleSnapshot: "Project Page",
          config: {
            routingContext: { kind: "project" as const, projectId: "legacy" },
            pageId: "page:project",
          },
          stateKey: 0,
          state: null,
        },
        "legacy-browser": {
          id: "legacy-browser",
          kind: "browser" as const,
          titleSnapshot: "Browser",
          config: {
            browserTabId: "browser:legacy",
            browserStorageId: "browser-storage:legacy",
          },
          stateKey: 0,
          state: null,
        },
      },
      panels: {
        ...seed.panels,
        right: {
          ...seed.panels.right,
          layout: {
            ...seed.panels.right.layout,
            root: {
              ...rightRoot,
              tabIds: [primary.id, "legacy-project-page", "legacy-browser"],
              activeTabId: "legacy-project-page",
            },
          },
        },
      },
      composerOverlay: { visible: false },
      agentDock: null,
    };
    const input = {
      ...createDefaultWorkbenchLayoutSnapshotV6(),
      location: { kind: "resource" as const, root },
      scenesByOwnerKey: { "resource:database:database:alpha": scene },
    };

    const first = WorkbenchLayoutSnapshotSchema.parse(input);
    const second = WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(first)));

    expect(second).toEqual(first);
    expect(second.location).toEqual({ kind: "library" });
    expect(second.scenesByOwnerKey.library?.primary).toBeNull();
    expect(Object.keys(second.scenesByOwnerKey.library!.panelSurfacesById)).toEqual([primary.id]);
    expect(Object.values(second.scenesByOwnerKey.library!.panelSurfacesById)[0]).toMatchObject({
      kind: "db_view",
      config: {
        routingContext: { kind: "library" },
        target: {
          kind: "database-default",
          databaseId: "database:alpha",
        },
      },
    });

    expect(() =>
      WorkbenchLayoutSnapshotSchema.parse({
        ...input,
        scenesByOwnerKey: {
          "resource:database:database:alpha": {
            ...scene,
            primary: {
              ...scene.primary,
              config: {
                ...scene.primary.config,
                target: {
                  kind: "database-default" as const,
                  databaseId: parseDatabaseId("database:other"),
                },
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  test("deterministically materializes a missing long-id Resource Scene", () => {
    const root = {
      kind: "page" as const,
      pageId: `page:${"x".repeat(500)}`,
    };
    const input = {
      ...createDefaultWorkbenchLayoutSnapshotV6(),
      location: { kind: "resource" as const, root },
      scenesByOwnerKey: {},
    };

    const first = WorkbenchLayoutSnapshotSchema.parse(input);
    const second = WorkbenchLayoutSnapshotSchema.parse(input);
    const surface = Object.values(first.scenesByOwnerKey.library?.panelSurfacesById ?? {})[0];

    expect(second).toEqual(first);
    expect(surface?.id.length).toBeLessThanOrEqual(160);
    expect(surface).toMatchObject({
      kind: "page_stage",
      config: {
        routingContext: { kind: "library" },
        pageId: root.pageId,
      },
    });
  });
});

describe("WorkbenchLayoutSnapshotSchema v9", () => {
  test("a v8 window keeps Space's tabs under `library` and opens the Inbox as its own Scene", () => {
    const library = materializeInitialWorkbenchScene(LIBRARY_SCENE_OWNER);
    const v8 = {
      version: 8,
      location: { kind: "inbox", returnTo: { kind: "pages" } },
      homeLocation: { kind: "inbox", returnTo: { kind: "project", projectId: "alpha" } },
      databaseSearchByProject: {},
      scenesByOwnerKey: { pages: { ...library, version: 8, owner: { kind: "pages" } } },
    };

    const parsed = WorkbenchLayoutSnapshotSchema.parse(v8);

    expect(parsed.version).toBe(9);
    expect(parsed.location).toEqual({ kind: "inbox" });
    expect(parsed.homeLocation).toEqual({ kind: "inbox" });
    expect(parsed.scenesByOwnerKey).toEqual({ library });
    expect(WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test("Settings and Scheduled keep returning to Space", () => {
    const parsed = WorkbenchLayoutSnapshotSchema.parse({
      ...createDefaultWorkbenchLayoutSnapshotV7(),
      version: 8,
      homeLocation: { kind: "empty" },
      location: {
        kind: "settings",
        path: "/settings/general",
        returnTo: { kind: "automations", path: "/automations/new", returnTo: { kind: "pages" } },
      },
    });
    expect(parsed.location).toEqual({
      kind: "settings",
      path: "/settings/general",
      returnTo: { kind: "automations", path: "/automations/new", returnTo: { kind: "library" } },
    });
  });

  test("rejects a Scene stored under another owner's key", () => {
    expect(
      WorkbenchLayoutSnapshotSchema.safeParse({
        ...createDefaultWorkbenchLayoutSnapshot(),
        scenesByOwnerKey: { inbox: materializeInitialWorkbenchScene(LIBRARY_SCENE_OWNER) },
      }).success,
    ).toBe(false);
  });
});

describe("WorkbenchLayoutSnapshotSchema locations", () => {
  test.each([
    { returnTo: { kind: "inbox" as const }, home: "origin" },
    {
      returnTo: {
        kind: "automations" as const,
        path: "/automations/edit/a",
        returnTo: { kind: "library" as const },
      },
      home: "unchanged",
    },
  ])("round trips Settings with its stable $returnTo.kind origin", ({ returnTo, home }) => {
    const parsed = WorkbenchLayoutSnapshotSchema.parse({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "settings", path: "/settings/general", returnTo },
    });
    expect(parsed.location).toEqual({ kind: "settings", path: "/settings/general", returnTo });
    expect(parsed.homeLocation).toEqual(home === "origin" ? returnTo : { kind: "empty" });
    expect(WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(
      WorkbenchLayoutSnapshotV7Schema.safeParse({
        ...createDefaultWorkbenchLayoutSnapshotV7(),
        location: parsed.location,
      }).success,
    ).toBe(false);
  });

  test.each([
    { kind: "settings", path: "/settings/appearance", returnTo: { kind: "empty" } },
    { kind: "pending-worktree", clientThreadId: "pending-a", returnTo: { kind: "empty" } },
  ])("rejects a transient or nested Settings origin: $kind", (returnTo) => {
    expect(
      WorkbenchLayoutSnapshotSchema.safeParse({
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "settings", path: "/settings/general", returnTo },
      }).success,
    ).toBe(false);
  });

  test.each<{
    readonly legacy: WorkbenchLayoutSnapshotV7["location"];
    readonly current: WorkbenchLayoutSnapshot["homeLocation"];
  }>([
    {
      legacy: { kind: "project", projectId: "alpha" },
      current: { kind: "project", projectId: "alpha" },
    },
    {
      legacy: { kind: "session", sessionId: "session-a", projectContextId: "alpha" },
      current: { kind: "session", sessionId: "session-a", projectContextId: "alpha" },
    },
    { legacy: { kind: "inbox", returnTo: { kind: "pages" } }, current: { kind: "inbox" } },
  ])(
    "derives the Home checkpoint from an active legacy Home route: $legacy.kind",
    ({ legacy, current }) => {
      const parsed = WorkbenchLayoutSnapshotSchema.parse({
        ...createDefaultWorkbenchLayoutSnapshotV7(),
        location: legacy,
      });
      expect(parsed.version).toBe(9);
      expect(parsed.location).toEqual(current);
      expect(parsed.homeLocation).toEqual(current);
      expect(WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
    },
  );

  test("legacy Space starts with an empty Home checkpoint and Settings retains its Scene", () => {
    const legacy = createDefaultWorkbenchLayoutSnapshotV7();
    const space = WorkbenchLayoutSnapshotSchema.parse({ ...legacy, location: { kind: "pages" } });
    expect(space.location).toEqual({ kind: "library" });
    expect(space.homeLocation).toEqual({ kind: "empty" });
    expect(
      WorkbenchLayoutSnapshotSchema.parse({
        ...legacy,
        location: {
          kind: "settings",
          path: "/settings/general",
          returnTo: { kind: "project", projectId: "alpha" },
        },
      }).homeLocation,
    ).toEqual({ kind: "project", projectId: "alpha" });
  });

  test("legacy Scheduled starts Home from the route Scheduled returns to", () => {
    const location = {
      kind: "automations",
      path: "/automations/edit/a",
      returnTo: { kind: "project", projectId: "alpha" },
    } as const;
    const parsed = WorkbenchLayoutSnapshotSchema.parse({
      ...createDefaultWorkbenchLayoutSnapshotV7(),
      location,
    });
    expect(parsed.location).toEqual(location);
    expect(parsed.homeLocation).toEqual(location.returnTo);
  });

  test.each([
    {
      returnTo: { kind: "session", sessionId: "session-a", projectContextId: null },
      home: "origin",
    },
    { returnTo: { kind: "pages" }, home: "empty" },
  ] as const)(
    "decodes a saved Scheduled Home checkpoint from its $returnTo.kind origin",
    ({ returnTo, home }) => {
      const parsed = WorkbenchLayoutSnapshotSchema.parse({
        ...createDefaultWorkbenchLayoutSnapshot(),
        version: 8,
        location: { kind: "pages" },
        homeLocation: { kind: "automations", path: "/automations", returnTo },
      });
      expect(parsed.homeLocation).toEqual(home === "origin" ? returnTo : { kind: "empty" });
    },
  );

  test("retains the saved Home route through Space and Settings restoration", () => {
    const homeLocation = { kind: "inbox" } as const;
    const space = {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: { kind: "library" as const },
      homeLocation,
    };
    expect(WorkbenchLayoutSnapshotSchema.parse(JSON.parse(JSON.stringify(space)))).toEqual(space);
    const settings = {
      ...space,
      location: { kind: "settings" as const, path: "/settings/general", returnTo: space.location },
    };
    expect(WorkbenchLayoutSnapshotSchema.parse(settings).homeLocation).toEqual(homeLocation);
  });

  test("normalizes the checkpoint when a targeted window opens a different Home route", () => {
    const location = { kind: "session", sessionId: "session-a", projectContextId: null } as const;
    const parsed = WorkbenchLayoutSnapshotSchema.parse({
      ...createDefaultWorkbenchLayoutSnapshot(),
      location,
      homeLocation: { kind: "project", projectId: "alpha" },
    });
    expect(parsed.homeLocation).toEqual(location);
  });

  test.each([
    { kind: "library" },
    { kind: "automations", path: "/automations", returnTo: { kind: "empty" } },
    { kind: "settings", path: "/settings/general", returnTo: { kind: "empty" } },
    { kind: "pending-worktree", clientThreadId: "pending-a", returnTo: { kind: "empty" } },
  ])("rejects a non-Home checkpoint: $kind", (homeLocation) => {
    expect(
      WorkbenchLayoutSnapshotSchema.safeParse({
        ...createDefaultWorkbenchLayoutSnapshot(),
        location: { kind: "library" },
        homeLocation,
      }).success,
    ).toBe(false);
  });
});
