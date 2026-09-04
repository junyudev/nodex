import { z } from "zod";
import type {
  WorkbenchLayoutDockSnapshot,
  WorkbenchLayoutFilesStageTab,
  WorkbenchLayoutSnapshotV5,
  WorkbenchLayoutSnapshotV6,
  WorkbenchLayoutSnapshotV7,
  WorkbenchLayoutSnapshotV4,
  WorkbenchLayoutSnapshotV3,
  WorkbenchLayoutSidebarSnapshot,
  WorkbenchLayoutSnapshot,
  WorkbenchLayoutThreadsStageTab,
  WorkbenchLibraryLocationTarget,
  WorkbenchLocationV4,
  WorkbenchLocationV5,
  WorkbenchLocationV6,
  WorkbenchLocationV7,
  WorkbenchSceneLocation,
  WorkbenchSceneLocationV6,
  WorkbenchSceneLocationV5,
  WorkbenchSessionLocationV4,
} from "../workbench-layout";
import {
  WorkbenchLayoutPageStageStateSchema,
  WorkbenchRecentPageSessionSchema,
  WorkbenchStageIdSchema,
  WorkbenchStageNavDirectionSchema,
  WorkbenchViewSchema,
} from "./workbench";
import { WorkbenchSessionViewSnapshotSchema } from "./workbench-session-view";
import {
  WorkbenchSceneSnapshotSchema,
  WorkbenchSceneSnapshotV3InputSchema,
  WorkbenchSceneSnapshotV4InputSchema,
  validateWorkbenchSceneMapKey,
} from "./workbench-scene";
import {
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  migrateWorkbenchSceneV3ToV4,
  migrateWorkbenchSceneV4ToV5,
  type WorkbenchSceneSnapshotV3,
  type WorkbenchSceneSnapshotV4,
  type WorkbenchSurfaceDescriptor,
  type WorkbenchSurfaceDescriptorV3,
} from "../workbench-scene";
import type {
  WorkbenchSessionViewSnapshot,
  WorkbenchSessionViewTab,
} from "../workbench-session-view";
import { parseDatabaseId, parseDatabaseViewId } from "../database-identities";
import type { LibraryPlacedResourceTarget } from "../library-module";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

const BooleanRecordSchema = UnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, boolean>>((acc, [key, enabled]) => {
    if (typeof enabled === "boolean") acc[key] = enabled;
    return acc;
  }, {}),
);

const BooleanRecordByIdSchema = UnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, Record<string, boolean>>>((acc, [key, record]) => {
    const parsed = BooleanRecordSchema.safeParse(record);
    if (parsed.success) acc[key] = parsed.data;
    return acc;
  }, {}),
);

const StringRecordSchema = UnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, string>>((acc, [key, text]) => {
    if (typeof text === "string") acc[key] = text;
    return acc;
  }, {}),
);

export const WorkbenchSessionLocationV4Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    activeProjectId: z.string().min(1).nullable(),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("empty"),
    activeProjectId: z.string().min(1).nullable(),
  }),
]) satisfies z.ZodType<WorkbenchSessionLocationV4>;

export const WorkbenchLibraryLocationTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("home") }),
    z.object({
      kind: z.literal("page"),
      pageId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("database"),
      databaseId: z.string().min(1),
      accessProjectId: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("view"),
      viewId: z.string().min(1),
      accessProjectId: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("canvas"),
      canvasId: z.string().min(1),
      accessProjectId: z.string().min(1).optional(),
    }),
  ])
  .transform((target): WorkbenchLibraryLocationTarget => {
    if (target.kind === "database") {
      return {
        ...target,
        databaseId: parseDatabaseId(target.databaseId),
      };
    }
    if (target.kind === "view") {
      return {
        ...target,
        viewId: parseDatabaseViewId(target.viewId),
      };
    }
    return target;
  }) satisfies z.ZodType<WorkbenchLibraryLocationTarget>;

export const WorkbenchLocationV4Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSessionLocationV4Schema.options,
  z.object({
    kind: z.literal("library"),
    target: WorkbenchLibraryLocationTargetSchema,
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
  z.object({
    kind: z.literal("settings"),
    path: z.string().min(1),
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
  z.object({
    kind: z.literal("automations"),
    path: z.string().min(1),
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
  z.object({
    kind: z.literal("pending-worktree"),
    clientThreadId: z.string().min(1),
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
]) satisfies z.ZodType<WorkbenchLocationV4>;

const PersistedWorkbenchLocationSchema = z.discriminatedUnion("kind", [
  ...WorkbenchSessionLocationV4Schema.options,
  z.object({
    kind: z.literal("library"),
    target: WorkbenchLibraryLocationTargetSchema,
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
  z.object({
    kind: z.literal("settings"),
    path: z.string().min(1),
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
  z.object({
    kind: z.literal("automations"),
    path: z.string().min(1),
    returnTo: WorkbenchSessionLocationV4Schema,
  }),
]);

const NumberRecordSchema = UnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, number>>((acc, [key, number]) => {
    if (typeof number === "number" && Number.isFinite(number)) acc[key] = number;
    return acc;
  }, {}),
);

const ViewRecordSchema = UnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, z.infer<typeof WorkbenchViewSchema>>>(
    (acc, [key, view]) => {
      const parsed = WorkbenchViewSchema.safeParse(view);
      if (parsed.success) acc[key] = parsed.data;
      return acc;
    },
    {},
  ),
);

export const WorkbenchLayoutSidebarSnapshotSchema = z.object({
  collapsed: z.boolean().catch(false),
  width: z.number().finite().catch(280),
  collapsibleSections: UnknownRecordSchema.catch({}),
}) satisfies z.ZodType<WorkbenchLayoutSidebarSnapshot>;

export const WorkbenchLayoutDockSnapshotSchema = z.object({
  width: z.number().finite().catch(560),
  tree: z.unknown(),
}) satisfies z.ZodType<WorkbenchLayoutDockSnapshot>;

export const WorkbenchLayoutThreadsStageTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  preview: z.string(),
}) satisfies z.ZodType<WorkbenchLayoutThreadsStageTab>;

export const WorkbenchLayoutFilesStageTabSchema = z.object({
  id: z.literal("diff"),
  title: z.string(),
}) satisfies z.ZodType<WorkbenchLayoutFilesStageTab>;

const migratePageStageDockIdentity = (value: unknown): unknown => {
  if (value === "cardstage") return "pagestage";
  if (Array.isArray(value)) return value.map(migratePageStageDockIdentity);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, migratePageStageDockIdentity(entry)]),
  );
};

const migrateWorkbenchLayoutSnapshot = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.version === 2) {
    return {
      ...record,
      version: 3,
      projectOrder: record.projectOrder ?? record.spaceOrder ?? [],
      sessionViewsBySessionId: {},
    };
  }
  if (record.version !== 1) return value;
  const legacyPageStage = record.pageStage ?? record.cardStage;
  const pageStage =
    typeof legacyPageStage === "object" &&
    legacyPageStage !== null &&
    !Array.isArray(legacyPageStage)
      ? {
          ...legacyPageStage,
          pageId:
            (legacyPageStage as Record<string, unknown>).pageId ??
            (legacyPageStage as Record<string, unknown>).cardId ??
            null,
        }
      : legacyPageStage;
  const legacySessions = Array.isArray(record.recentPageSessions)
    ? record.recentPageSessions
    : Array.isArray(record.recentCardSessions)
      ? record.recentCardSessions
      : [];
  const recentPageSessions = legacySessions.map((session) => {
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      return session;
    }
    const sessionRecord = session as Record<string, unknown>;
    return {
      ...sessionRecord,
      pageId: sessionRecord.pageId ?? sessionRecord.cardId,
    };
  });

  return {
    ...record,
    version: 3,
    projectOrder: record.projectOrder ?? record.spaceOrder ?? [],
    focusedStage: record.focusedStage === "cards" ? "pages" : record.focusedStage,
    activePagesTabId: record.activePagesTabId ?? record.activeCardsTabId ?? "",
    recentPageSessions,
    pageStage,
    dock: migratePageStageDockIdentity(record.dock),
    sessionViewsBySessionId: {},
  };
};

export const WorkbenchLayoutSnapshotV3Schema = z.preprocess(
  migrateWorkbenchLayoutSnapshot,
  z.object({
    version: z.literal(3),
    dbProjectId: z.string().nullable(),
    activeProjectSessionId: z.string().nullable().catch(null),
    threadsProjectId: z.string().nullable(),
    viewsByProject: ViewRecordSchema,
    searchByProject: StringRecordSchema.catch({}),
    dbViewPrefsByProject: UnknownRecordSchema.catch({}),
    projectOrder: z.array(z.string()).catch([]),
    focusedStage: WorkbenchStageIdSchema,
    stageNavDirection: WorkbenchStageNavDirectionSchema,
    sidebar: WorkbenchLayoutSidebarSnapshotSchema,
    dock: WorkbenchLayoutDockSnapshotSchema,
    sidebarStageExpandedByProject: BooleanRecordByIdSchema.catch({}),
    sidebarSectionExpandedByProject: BooleanRecordByIdSchema.catch({}),
    sidebarSectionShowAllByProject: BooleanRecordByIdSchema.catch({}),
    activePagesTabId: z.string(),
    activeRecentSessionId: z.string().nullable(),
    recentPageSessions: z.array(WorkbenchRecentPageSessionSchema).catch([]),
    pageStage: WorkbenchLayoutPageStageStateSchema,
    threadsTabs: z.array(WorkbenchLayoutThreadsStageTabSchema).catch([]),
    activeThreadsTabId: z.string(),
    filesTabs: z.array(WorkbenchLayoutFilesStageTabSchema).catch([]),
    activeFilesTabId: z.string(),
    stagePanelWidths: NumberRecordSchema.catch({}),
    slidingWindowPaneCount: z.number().finite().catch(2),
    sessionViewsBySessionId: z.record(z.string(), WorkbenchSessionViewSnapshotSchema).catch({}),
  }),
) satisfies z.ZodType<WorkbenchLayoutSnapshotV3>;

const migrateWorkbenchLayoutSnapshotToV4 = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.version === 4) {
    const location = record.location;
    if (
      typeof location === "object" &&
      location !== null &&
      !Array.isArray(location) &&
      (location as Record<string, unknown>).kind === "pending-worktree"
    ) {
      return {
        ...record,
        location: (location as Record<string, unknown>).returnTo,
      };
    }
    return value;
  }

  const migratedV3 = migrateWorkbenchLayoutSnapshot(value);
  if (typeof migratedV3 !== "object" || migratedV3 === null || Array.isArray(migratedV3)) {
    return migratedV3;
  }
  const legacy = migratedV3 as Record<string, unknown>;
  if (legacy.version !== 3) return migratedV3;

  const activeProjectId =
    typeof legacy.dbProjectId === "string" && legacy.dbProjectId.length > 0
      ? legacy.dbProjectId
      : null;
  const sessionId =
    typeof legacy.activeProjectSessionId === "string" && legacy.activeProjectSessionId.length > 0
      ? legacy.activeProjectSessionId
      : null;

  return {
    version: 4,
    location: sessionId
      ? {
          kind: "session",
          activeProjectId,
          sessionId,
        }
      : {
          kind: "empty",
          activeProjectId,
        },
    databaseSearchByProject: legacy.searchByProject ?? {},
    sessionViewsBySessionId: legacy.sessionViewsBySessionId ?? {},
  };
};

export const WorkbenchLayoutSnapshotV4Schema = z.preprocess(
  migrateWorkbenchLayoutSnapshotToV4,
  z.object({
    version: z.literal(4),
    location: PersistedWorkbenchLocationSchema,
    databaseSearchByProject: StringRecordSchema.catch({}),
    sessionViewsBySessionId: z.record(z.string(), WorkbenchSessionViewSnapshotSchema).catch({}),
  }),
) satisfies z.ZodType<WorkbenchLayoutSnapshotV4>;

export const WorkbenchSceneLocationV5Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.string().min(1),
      projectContextId: z.string().min(1).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("empty") }).strict(),
]) satisfies z.ZodType<WorkbenchSceneLocationV5>;

export const WorkbenchLocationV5Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV5Schema.options,
  z
    .object({
      kind: z.literal("library"),
      target: WorkbenchLibraryLocationTargetSchema,
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending-worktree"),
      clientThreadId: z.string().min(1),
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchLocationV5>;

const PersistedWorkbenchLocationV5Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV5Schema.options,
  z
    .object({
      kind: z.literal("library"),
      target: WorkbenchLibraryLocationTargetSchema,
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV5Schema,
    })
    .strict(),
]);

function migrateWorkbenchLocationToV5(
  location: WorkbenchLocationV4,
): WorkbenchLayoutSnapshotV5["location"] {
  if (location.kind === "session") {
    return {
      kind: "session",
      sessionId: location.sessionId,
      projectContextId: location.activeProjectId,
    };
  }
  if (location.kind === "empty") {
    return location.activeProjectId
      ? { kind: "project", projectId: location.activeProjectId }
      : { kind: "empty" };
  }
  return {
    ...location,
    returnTo: migrateWorkbenchLocationToV5(location.returnTo),
  } as WorkbenchLayoutSnapshotV5["location"];
}

function deterministicPrimarySurfaceId(view: WorkbenchSessionViewSnapshot): string {
  const existing = new Set(Object.keys(view.tabsById));
  let id = "primary";
  let suffix = 0;
  while (existing.has(id)) {
    suffix += 1;
    id = `primary:${suffix}`;
  }
  return id;
}

function migrateWorkbenchSessionViewTabToSurface(
  tab: WorkbenchSessionViewTab,
): WorkbenchSurfaceDescriptorV3 {
  if (tab.kind !== "db_view") {
    return tab as WorkbenchSurfaceDescriptorV3;
  }
  return {
    ...tab,
    config: {
      projectId: tab.config.projectId,
      target: {
        kind: "database-view",
        databaseViewId: tab.config.databaseViewId,
      },
      view: "board",
    },
  };
}

function migrateWorkbenchSessionViewToScene(
  view: WorkbenchSessionViewSnapshot,
): WorkbenchSceneSnapshotV3 {
  return {
    version: 3,
    owner: { kind: "session", sessionId: view.sessionId },
    primary: {
      id: deterministicPrimarySurfaceId(view),
      kind: "conversation",
      titleSnapshot: "Conversation",
      config: { sessionId: view.sessionId },
      stateKey: 0,
      state: null,
    },
    panelSurfacesById: Object.fromEntries(
      Object.entries(view.tabsById).map(([surfaceId, tab]) => [
        surfaceId,
        migrateWorkbenchSessionViewTabToSurface(tab),
      ]),
    ),
    panels: view.panels,
    lastFocusedPanelId: view.lastFocusedPanelId,
    composerOverlay: { visible: true },
    agentDock: null,
    touchedAt: view.touchedAt,
  };
}

const migrateWorkbenchLayoutSnapshotToV5 = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.version === 5) {
    const location = record.location;
    if (
      typeof location === "object" &&
      location !== null &&
      !Array.isArray(location) &&
      (location as Record<string, unknown>).kind === "pending-worktree"
    ) {
      return {
        ...record,
        location: (location as Record<string, unknown>).returnTo,
      };
    }
    return value;
  }

  const parsedV4 = WorkbenchLayoutSnapshotV4Schema.safeParse(value);
  if (!parsedV4.success) return value;
  const legacy = parsedV4.data;
  const scenesByOwnerKey = Object.fromEntries(
    Object.values(legacy.sessionViewsBySessionId).map((view) => {
      const scene = migrateWorkbenchSessionViewToScene(view);
      return [`session:${view.sessionId}`, scene];
    }),
  );
  return {
    version: 5,
    location: migrateWorkbenchLocationToV5(legacy.location),
    databaseSearchByProject: legacy.databaseSearchByProject,
    scenesByOwnerKey,
  };
};

export const WorkbenchLayoutSnapshotV5Schema = z.preprocess(
  migrateWorkbenchLayoutSnapshotToV5,
  z
    .object({
      version: z.literal(5),
      location: PersistedWorkbenchLocationV5Schema,
      databaseSearchByProject: StringRecordSchema.catch({}),
      scenesByOwnerKey: z.record(z.string().min(1), WorkbenchSceneSnapshotV3InputSchema),
    })
    .strict()
    .superRefine((layout, context) => {
      for (const [sceneKey, scene] of Object.entries(layout.scenesByOwnerKey)) {
        const ownerKey =
          scene.owner.kind === "project"
            ? `project:${scene.owner.projectId}`
            : `session:${scene.owner.sessionId}`;
        if (sceneKey === ownerKey) continue;
        context.addIssue({
          code: "custom",
          path: ["scenesByOwnerKey", sceneKey, "owner"],
          message: "Scene map key must match the canonical owner key",
        });
      }
    }),
) satisfies z.ZodType<WorkbenchLayoutSnapshotV5>;

const WorkbenchResourceTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      pageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("database"),
      databaseId: z.string().min(1).transform(parseDatabaseId),
    })
    .strict(),
  z
    .object({
      kind: z.literal("canvas"),
      canvasId: z.string().min(1),
    })
    .strict(),
]) satisfies z.ZodType<LibraryPlacedResourceTarget>;

export const WorkbenchSceneLocationV6Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV5Schema.options,
  z
    .object({
      kind: z.literal("resource"),
      root: WorkbenchResourceTargetSchema,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchSceneLocationV6>;

export const WorkbenchLocationV6Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV6Schema.options,
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV6Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV6Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending-worktree"),
      clientThreadId: z.string().min(1),
      returnTo: WorkbenchSceneLocationV6Schema,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchLocationV6>;

const PersistedWorkbenchLocationV6Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV6Schema.options,
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV6Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationV6Schema,
    })
    .strict(),
]);

function migrateWorkbenchLocationV5ToV6(
  location: WorkbenchLocationV5,
): WorkbenchLayoutSnapshotV6["location"] {
  if (location.kind === "library") return location.returnTo;
  if (location.kind === "pending-worktree") return location.returnTo;
  return location;
}

const migrateWorkbenchLayoutSnapshotToV6 = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.version === 6) {
    const location = record.location;
    if (
      typeof location === "object" &&
      location !== null &&
      !Array.isArray(location) &&
      (location as Record<string, unknown>).kind === "pending-worktree"
    ) {
      return {
        ...record,
        location: (location as Record<string, unknown>).returnTo,
      };
    }
    return value;
  }

  const parsedV5 = WorkbenchLayoutSnapshotV5Schema.safeParse(value);
  if (!parsedV5.success) return value;
  return {
    version: 6,
    location: migrateWorkbenchLocationV5ToV6(parsedV5.data.location),
    databaseSearchByProject: parsedV5.data.databaseSearchByProject,
    scenesByOwnerKey: Object.fromEntries(
      Object.entries(parsedV5.data.scenesByOwnerKey).map(([sceneKey, scene]) => [
        sceneKey,
        migrateWorkbenchSceneV3ToV4(scene),
      ]),
    ),
  };
};

export const WorkbenchLayoutSnapshotV6Schema = z.preprocess(
  migrateWorkbenchLayoutSnapshotToV6,
  z
    .object({
      version: z.literal(6),
      location: PersistedWorkbenchLocationV6Schema,
      databaseSearchByProject: StringRecordSchema.catch({}),
      scenesByOwnerKey: z.record(z.string().min(1), WorkbenchSceneSnapshotV4InputSchema),
    })
    .strict()
    .superRefine((layout, context) => {
      for (const [sceneKey, scene] of Object.entries(layout.scenesByOwnerKey)) {
        const ownerKey =
          scene.owner.kind === "project"
            ? `project:${scene.owner.projectId}`
            : scene.owner.kind === "session"
              ? `session:${scene.owner.sessionId}`
              : scene.owner.root.kind === "page"
                ? `resource:page:${scene.owner.root.pageId}`
                : scene.owner.root.kind === "database"
                  ? `resource:database:${scene.owner.root.databaseId}`
                  : `resource:canvas:${scene.owner.root.canvasId}`;
        if (sceneKey === ownerKey) continue;
        context.addIssue({
          code: "custom",
          path: ["scenesByOwnerKey", sceneKey, "owner"],
          message: "Scene map key must match the canonical owner key",
        });
      }
    }),
) satisfies z.ZodType<WorkbenchLayoutSnapshotV6>;

export const WorkbenchSceneLocationSchema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationV5Schema.options,
  z.object({ kind: z.literal("pages") }).strict(),
]) satisfies z.ZodType<WorkbenchSceneLocation>;

export const WorkbenchLocationV7Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationSchema.options,
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending-worktree"),
      clientThreadId: z.string().min(1),
      returnTo: WorkbenchSceneLocationSchema,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchLocationV7>;

const PersistedWorkbenchLocationV7Schema = z.discriminatedUnion("kind", [
  ...WorkbenchSceneLocationSchema.options,
  z
    .object({
      kind: z.literal("settings"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("automations"),
      path: z.string().min(1),
      returnTo: WorkbenchSceneLocationSchema,
    })
    .strict(),
]);

function resourceSceneKey(root: LibraryPlacedResourceTarget): string {
  if (root.kind === "page") return `resource:page:${root.pageId}`;
  if (root.kind === "database") return `resource:database:${root.databaseId}`;
  return `resource:canvas:${root.canvasId}`;
}

function resourceRootFromLocation(
  location: WorkbenchLocationV6,
): LibraryPlacedResourceTarget | null {
  const sceneLocation =
    location.kind === "settings" ||
    location.kind === "automations" ||
    location.kind === "pending-worktree"
      ? location.returnTo
      : location;
  return sceneLocation.kind === "resource" ? sceneLocation.root : null;
}

function migrateLocationV6ToV7(
  location: WorkbenchLocationV6,
): WorkbenchLayoutSnapshotV7["location"] {
  if (location.kind === "pending-worktree") {
    return migrateLocationV6ToV7(location.returnTo);
  }
  if (location.kind === "resource") return { kind: "pages" };
  if (location.kind === "settings" || location.kind === "automations") {
    return {
      ...location,
      returnTo: location.returnTo.kind === "resource" ? { kind: "pages" } : location.returnTo,
    };
  }
  return location;
}

const MIGRATED_PAGES_TOUCHED_AT = "1970-01-01T00:00:00.000Z";

function libraryResourceIdentity(root: LibraryPlacedResourceTarget): string {
  if (root.kind === "page") return `page:${root.pageId}`;
  if (root.kind === "database") return `database:${root.databaseId}`;
  return `canvas:${root.canvasId}`;
}

function stableMigrationHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function rootSurface(root: LibraryPlacedResourceTarget): WorkbenchSurfaceDescriptor {
  const common = {
    id: `migrated:pages:surface:${stableMigrationHash(libraryResourceIdentity(root))}`,
    stateKey: 0,
    state: null,
  } as const;
  if (root.kind === "page") {
    return {
      ...common,
      kind: "page_stage",
      titleSnapshot: "Page",
      config: { accessContext: { kind: "library" }, pageId: root.pageId },
    };
  }
  if (root.kind === "database") {
    return {
      ...common,
      kind: "db_view",
      titleSnapshot: "Database",
      config: {
        accessContext: { kind: "library" },
        target: { kind: "database-default", databaseId: root.databaseId },
      },
    };
  }
  return {
    ...common,
    kind: "canvas_stage",
    titleSnapshot: "Canvas",
    config: {
      accessContext: { kind: "library" },
      canvasBlockId: root.canvasId,
    },
  };
}

function materializeMigratedPagesScene(
  root: LibraryPlacedResourceTarget,
  legacy: WorkbenchSceneSnapshotV4 | undefined,
) {
  if (legacy) return migrateWorkbenchSceneV4ToV5(legacy);
  const identityCounts = new Map<string, number>();
  const identityFactory = {
    createId(kind: "surface" | "leaf" | "branch" | "browser" | "draft") {
      const count = (identityCounts.get(kind) ?? 0) + 1;
      identityCounts.set(kind, count);
      return `migrated:pages:${kind}:${count}`;
    },
  };
  const scene = createWorkbenchSceneSurface(
    materializeInitialWorkbenchScene(
      { kind: "pages" },
      { identityFactory, touchedAt: MIGRATED_PAGES_TOUCHED_AT },
    ),
    { panelId: "right", surface: rootSurface(root) },
  );
  return { ...scene, touchedAt: MIGRATED_PAGES_TOUCHED_AT };
}

const migrateWorkbenchLayoutSnapshotToV7 = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.version === 7) {
    const location = record.location;
    if (
      typeof location === "object" &&
      location !== null &&
      !Array.isArray(location) &&
      (location as Record<string, unknown>).kind === "pending-worktree"
    ) {
      return { ...record, location: (location as Record<string, unknown>).returnTo };
    }
    return value;
  }

  const parsedV6 = WorkbenchLayoutSnapshotV6Schema.safeParse(value);
  if (!parsedV6.success) return value;
  const legacy = parsedV6.data;
  const activeRoot = resourceRootFromLocation(legacy.location);
  const scenesByOwnerKey = Object.fromEntries(
    Object.entries(legacy.scenesByOwnerKey)
      .filter(([, scene]) => scene.owner.kind !== "resource")
      .map(([sceneKey, scene]) => [sceneKey, migrateWorkbenchSceneV4ToV5(scene)]),
  );
  if (activeRoot) {
    scenesByOwnerKey.pages = materializeMigratedPagesScene(
      activeRoot,
      legacy.scenesByOwnerKey[resourceSceneKey(activeRoot)],
    );
  }
  return {
    version: 7,
    location: migrateLocationV6ToV7(legacy.location),
    databaseSearchByProject: legacy.databaseSearchByProject,
    scenesByOwnerKey,
  };
};

export const WorkbenchLayoutSnapshotV7Schema = z.preprocess(
  migrateWorkbenchLayoutSnapshotToV7,
  z
    .object({
      version: z.literal(7),
      location: PersistedWorkbenchLocationV7Schema,
      databaseSearchByProject: StringRecordSchema.catch({}),
      scenesByOwnerKey: z.record(z.string().min(1), WorkbenchSceneSnapshotSchema),
    })
    .strict()
    .superRefine((layout, context) => {
      for (const [sceneKey, scene] of Object.entries(layout.scenesByOwnerKey)) {
        if (validateWorkbenchSceneMapKey(sceneKey, scene)) continue;
        context.addIssue({
          code: "custom",
          path: ["scenesByOwnerKey", sceneKey, "owner"],
          message: "Scene map key must match the canonical owner key",
        });
      }
    }),
) satisfies z.ZodType<WorkbenchLayoutSnapshotV7>;

export const WorkbenchLayoutSnapshotSchema: z.ZodType<WorkbenchLayoutSnapshot> =
  WorkbenchLayoutSnapshotV7Schema;
