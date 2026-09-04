import { z } from "zod";
import {
  findWorkbenchPanelLeafForTab,
  flattenWorkbenchPanelTabIds,
  removeWorkbenchPanelTab,
} from "../workbench-panel-layout";
import {
  WORKBENCH_SCENE_MAX_PANEL_SURFACES,
  WORKBENCH_SCENE_VERSION,
  isPagesSceneSurfaceAllowed,
  isProjectScenePanelSurfaceAllowed,
  makeWorkbenchSceneKey,
  migrateWorkbenchSceneV1ToV4,
  migrateWorkbenchSceneV2ToV4,
  migrateWorkbenchSceneV3ToV4,
  migrateWorkbenchSceneV4ToV5,
  type WorkbenchSceneOwner,
  type WorkbenchSceneOwnerV4,
  type WorkbenchSceneSnapshot,
  type WorkbenchSceneSnapshotV2,
  type WorkbenchSceneSnapshotV3,
  type WorkbenchSceneSnapshotV4,
  type WorkbenchSurfaceDescriptor,
  type WorkbenchSurfaceDescriptorV3,
} from "../workbench-scene";
import { BrowserSidebarDeviceToolbarStateSchema } from "../browser/browser-schemas";
import { WorkbenchViewSchema } from "./workbench";
import { WorkbenchReviewConfigSchema } from "./workbench-review";
import { WorkbenchImageEditorSurfaceConfigSchema } from "./workbench-image-editor";
import {
  MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES,
  WorkbenchPanelStateSchema,
} from "./workbench-session-view";
import { parseDatabaseId } from "../database-identities";
import type { ContentAccessContext } from "../content-access-context";
import type { LibraryPlacedResourceTarget } from "../library-module";

const idSchema = z.string().min(1).max(512);
const surfaceIdSchema = z.string().min(1).max(160);
const titleSchema = z.string().max(2_000);

function encodedJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const WorkbenchSceneOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pages"),
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchSceneOwner>;

const WorkbenchSceneOwnerV4Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource"),
      root: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("page"),
            pageId: idSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("database"),
            databaseId: idSchema.transform(parseDatabaseId),
          })
          .strict(),
        z
          .object({
            kind: z.literal("canvas"),
            canvasId: idSchema,
          })
          .strict(),
      ]) satisfies z.ZodType<LibraryPlacedResourceTarget>,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchSceneOwnerV4>;

const WorkbenchConversationSurfaceConfigSchema = z
  .object({
    sessionId: idSchema,
  })
  .strict();

const ContentAccessContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
    })
    .strict(),
]) satisfies z.ZodType<ContentAccessContext>;

const WorkbenchDbViewSurfaceConfigFields = {
  accessContext: ContentAccessContextSchema,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project-default") }).strict(),
    z
      .object({
        kind: z.literal("database-default"),
        databaseId: idSchema.transform(parseDatabaseId),
      })
      .strict(),
    z
      .object({
        kind: z.literal("database-view"),
        databaseViewId: idSchema,
      })
      .strict(),
  ]),
} as const;

const WorkbenchDbViewSurfaceConfigSchema = z
  .object({
    ...WorkbenchDbViewSurfaceConfigFields,
  })
  .strict();

const WorkbenchPageStageSurfaceConfigSchema = z
  .object({
    accessContext: ContentAccessContextSchema,
    pageId: idSchema,
    titleSnapshot: z.string().max(2_000).optional(),
  })
  .strict();

const WorkbenchCanvasStageSurfaceConfigSchema = z
  .object({
    accessContext: ContentAccessContextSchema,
    canvasBlockId: idSchema,
    titleSnapshot: z.string().max(2_000).optional(),
  })
  .strict();

const WorkbenchTerminalSurfaceConfigSchema = z
  .object({
    terminalSessionId: idSchema,
    context: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("project"),
            projectId: idSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("session"),
            sessionId: idSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const WorkbenchBrowserSurfaceConfigSchema = z
  .object({
    browserTabId: idSchema,
    browserUseSource: z
      .object({
        codexSessionId: idSchema,
      })
      .strict()
      .optional(),
    browserStorageId: idSchema.optional(),
    url: z.string().optional(),
    title: z.string().max(2_000).optional(),
    faviconUrl: z.string().optional(),
    deviceToolbarVisible: z.boolean().optional(),
    deviceToolbarState: BrowserSidebarDeviceToolbarStateSchema.optional(),
  })
  .strict();

const WorkbenchReviewSurfaceConfigSchema = WorkbenchReviewConfigSchema;

const WorkbenchFilesSurfaceConfigSchema = z
  .object({
    projectId: idSchema.nullable(),
    hostId: z.literal("local"),
    workspaceRoot: z.string().min(1).nullable(),
    cwd: z.string().min(1).nullable(),
    path: z.string().min(1).optional(),
  })
  .strict();

const surfaceBaseSchema = {
  id: surfaceIdSchema,
  titleSnapshot: titleSchema,
  stateKey: z.number().int().nonnegative(),
  state: z.unknown(),
} as const;

export const WorkbenchSurfaceDescriptorSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("conversation"),
        config: WorkbenchConversationSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("db_view"),
        config: WorkbenchDbViewSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("page_stage"),
        config: WorkbenchPageStageSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("canvas_stage"),
        config: WorkbenchCanvasStageSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("terminal"),
        config: WorkbenchTerminalSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("browser"),
        config: WorkbenchBrowserSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("review"),
        config: WorkbenchReviewSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("files"),
        config: WorkbenchFilesSurfaceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...surfaceBaseSchema,
        kind: z.literal("image_editor"),
        config: WorkbenchImageEditorSurfaceConfigSchema,
      })
      .strict(),
  ])
  .superRefine((surface, context) => {
    if (encodedJsonBytes(surface.config) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Surface config exceeds its encoded size bound",
      });
    }
    if (encodedJsonBytes(surface.state) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Surface state exceeds its encoded size bound",
      });
    }
  }) satisfies z.ZodType<WorkbenchSurfaceDescriptor>;

const WorkbenchDbViewSurfaceConfigV3Schema = z
  .object({
    projectId: idSchema,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project-default") }).strict(),
      z
        .object({
          kind: z.literal("database-view"),
          databaseViewId: idSchema,
        })
        .strict(),
    ]),
    view: WorkbenchViewSchema,
  })
  .strict();

const WorkbenchPageStageSurfaceConfigV3Schema = z
  .object({
    projectId: idSchema,
    pageId: idSchema,
    titleSnapshot: z.string().max(2_000).optional(),
  })
  .strict();

const WorkbenchCanvasStageSurfaceConfigV3Schema = z
  .object({
    projectId: idSchema,
    canvasBlockId: idSchema,
    titleSnapshot: z.string().max(2_000).optional(),
  })
  .strict();

const WorkbenchSurfaceDescriptorV3Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("conversation"),
      config: WorkbenchConversationSurfaceConfigSchema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("db_view"),
      config: WorkbenchDbViewSurfaceConfigV3Schema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("page_stage"),
      config: WorkbenchPageStageSurfaceConfigV3Schema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("canvas_stage"),
      config: WorkbenchCanvasStageSurfaceConfigV3Schema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("terminal"),
      config: WorkbenchTerminalSurfaceConfigSchema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("browser"),
      config: WorkbenchBrowserSurfaceConfigSchema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("review"),
      config: WorkbenchReviewSurfaceConfigSchema,
    })
    .strict(),
  z
    .object({
      ...surfaceBaseSchema,
      kind: z.literal("files"),
      config: WorkbenchFilesSurfaceConfigSchema,
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchSurfaceDescriptorV3>;

const WorkbenchAgentDockStateSchema = z
  .object({
    binding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new") }).strict(),
      z
        .object({
          kind: z.literal("session"),
          sessionId: idSchema,
        })
        .strict(),
    ]),
    newDraftId: idSchema,
  })
  .strict();

const WorkbenchComposerOverlayStateSchema = z
  .object({
    visible: z.boolean(),
  })
  .strict();

const WorkbenchAgentDockStateV2Schema = WorkbenchAgentDockStateSchema.extend({
  visible: z.boolean(),
}).strict();

const workbenchSceneSnapshotFields = {
  owner: WorkbenchSceneOwnerSchema,
  primary: WorkbenchSurfaceDescriptorSchema.nullable(),
  panelSurfacesById: z.record(surfaceIdSchema, WorkbenchSurfaceDescriptorSchema),
  panels: z
    .object({
      right: WorkbenchPanelStateSchema,
      bottom: WorkbenchPanelStateSchema,
    })
    .strict(),
  lastFocusedPanelId: z.enum(["right", "bottom"]).nullable(),
  touchedAt: z.iso.datetime(),
} as const;

const workbenchSceneSnapshotFieldsV4 = {
  ...workbenchSceneSnapshotFields,
  owner: WorkbenchSceneOwnerV4Schema,
  primary: WorkbenchSurfaceDescriptorSchema,
} as const;

const WorkbenchSceneOwnerV3Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: idSchema,
    })
    .strict(),
]);

const workbenchSceneSnapshotFieldsV3 = {
  owner: WorkbenchSceneOwnerV3Schema,
  primary: WorkbenchSurfaceDescriptorV3Schema,
  panelSurfacesById: z.record(surfaceIdSchema, WorkbenchSurfaceDescriptorV3Schema),
  panels: z
    .object({
      right: WorkbenchPanelStateSchema,
      bottom: WorkbenchPanelStateSchema,
    })
    .strict(),
  lastFocusedPanelId: z.enum(["right", "bottom"]).nullable(),
  touchedAt: z.iso.datetime(),
} as const;

const WorkbenchSceneSnapshotV1InputSchema = z
  .object({
    version: z.literal(1),
    ...workbenchSceneSnapshotFieldsV3,
  })
  .strict();

const WorkbenchSceneSnapshotV2InputSchema = z
  .object({
    version: z.literal(2),
    ...workbenchSceneSnapshotFieldsV3,
    agentDock: WorkbenchAgentDockStateV2Schema.nullable(),
  })
  .strict() satisfies z.ZodType<WorkbenchSceneSnapshotV2>;

export const WorkbenchSceneSnapshotV3InputSchema = z
  .object({
    version: z.literal(3),
    ...workbenchSceneSnapshotFieldsV3,
    composerOverlay: WorkbenchComposerOverlayStateSchema,
    agentDock: WorkbenchAgentDockStateSchema.nullable(),
  })
  .strict() satisfies z.ZodType<WorkbenchSceneSnapshotV3>;

function validateWorkbenchSceneV4(scene: WorkbenchSceneSnapshotV4, context: z.RefinementCtx) {
  if (scene.owner.kind !== "resource") return;
  const entries = Object.entries(scene.panelSurfacesById);
  if (entries.length > WORKBENCH_SCENE_MAX_PANEL_SURFACES) {
    context.addIssue({
      code: "custom",
      path: ["panelSurfacesById"],
      message: `Scene contains more than ${WORKBENCH_SCENE_MAX_PANEL_SURFACES} panel surfaces`,
    });
  }
  for (const [surfaceId, surface] of entries) {
    if (surfaceId === surface.id) continue;
    context.addIssue({
      code: "custom",
      path: ["panelSurfacesById", surfaceId, "id"],
      message: "Surface map key must match surface.id",
    });
  }
  if (scene.panelSurfacesById[scene.primary.id]) {
    context.addIssue({
      code: "custom",
      path: ["primary", "id"],
      message: "Primary surface cannot also be a regular panel surface",
    });
  }

  const rightIds = flattenWorkbenchPanelTabIds(scene.panels.right.layout);
  const bottomIds = flattenWorkbenchPanelTabIds(scene.panels.bottom.layout);
  const placementCount = new Map<string, number>();
  for (const surfaceId of [...rightIds, ...bottomIds]) {
    placementCount.set(surfaceId, (placementCount.get(surfaceId) ?? 0) + 1);
  }
  for (const surfaceId of Object.keys(scene.panelSurfacesById)) {
    if (placementCount.get(surfaceId) === 1) continue;
    context.addIssue({
      code: "custom",
      path: ["panelSurfacesById", surfaceId],
      message: "Every panel surface must be placed exactly once",
    });
  }
  for (const surfaceId of placementCount.keys()) {
    if (surfaceId === scene.primary.id || scene.panelSurfacesById[surfaceId]) {
      continue;
    }
    context.addIssue({
      code: "custom",
      path: ["panels"],
      message: `Panel placement references unknown surface ${surfaceId}`,
    });
  }

  const root = scene.owner.root;
  const primaryMatchesRoot =
    root.kind === "page"
      ? scene.primary.kind === "page_stage" &&
        scene.primary.config.accessContext.kind === "library" &&
        scene.primary.config.pageId === root.pageId
      : root.kind === "database"
        ? scene.primary.kind === "db_view" &&
          scene.primary.config.accessContext.kind === "library" &&
          scene.primary.config.target.kind === "database-default" &&
          scene.primary.config.target.databaseId === root.databaseId
        : scene.primary.kind === "canvas_stage" &&
          scene.primary.config.accessContext.kind === "library" &&
          scene.primary.config.canvasBlockId === root.canvasId;
  if (!primaryMatchesRoot) {
    context.addIssue({
      code: "custom",
      path: ["primary"],
      message: "Resource Scene primary must target its owning Library root",
    });
  }
  if (scene.agentDock !== null || scene.composerOverlay.visible) {
    context.addIssue({
      code: "custom",
      path: ["agentDock"],
      message: "Resource Scene cannot own execution composer state",
    });
  }
  if (placementCount.get(scene.primary.id) !== 1 || bottomIds.includes(scene.primary.id)) {
    context.addIssue({
      code: "custom",
      path: ["primary", "id"],
      message: "Resource primary must be placed once in the right surface stack",
    });
  }
  const primaryLeaf = findWorkbenchPanelLeafForTab(scene.panels.right.layout, scene.primary.id);
  if (!primaryLeaf || primaryLeaf.tabIds[0] !== scene.primary.id) {
    context.addIssue({
      code: "custom",
      path: ["panels", "right", "layout"],
      message: "Resource primary must be the first tab in its leaf",
    });
  }
  if (scene.panels.right.collapsed || scene.panels.right.size.fullWidth !== true) {
    context.addIssue({
      code: "custom",
      path: ["panels", "right"],
      message: "Resource right surface stack must remain open and full width",
    });
  }
  const allowedKinds = new Set(["db_view", "page_stage", "canvas_stage", "browser"]);
  if (entries.some(([, surface]) => !allowedKinds.has(surface.kind))) {
    context.addIssue({
      code: "custom",
      path: ["panelSurfacesById"],
      message: "Resource Scene contains an execution-only surface",
    });
  }
  if (encodedJsonBytes(scene) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
    context.addIssue({
      code: "custom",
      message: "Scene exceeds its encoded size bound",
    });
  }
}

export const WorkbenchSceneSnapshotV4InputSchema = z.preprocess(
  stripDatabaseLayoutsFromScene,
  z
    .object({
      version: z.literal(4),
      ...workbenchSceneSnapshotFieldsV4,
      composerOverlay: WorkbenchComposerOverlayStateSchema,
      agentDock: WorkbenchAgentDockStateSchema.nullable(),
    })
    .strict()
    .superRefine(validateWorkbenchSceneV4),
) satisfies z.ZodType<WorkbenchSceneSnapshotV4>;

function stripDatabaseLayoutFromSurface(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const surface = value as Record<string, unknown>;
  if (surface.kind !== "db_view") return value;
  const config = surface.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return value;
  const { view: legacyLayout, ...durableConfig } = config as Record<string, unknown>;
  void legacyLayout;
  return { ...surface, config: durableConfig };
}

function stripDatabaseLayoutsFromScene(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const scene = value as Record<string, unknown>;
  const surfaces = scene.panelSurfacesById;
  const panelSurfacesById =
    surfaces && typeof surfaces === "object" && !Array.isArray(surfaces)
      ? Object.fromEntries(
          Object.entries(surfaces).map(([surfaceId, surface]) => [
            surfaceId,
            stripDatabaseLayoutFromSurface(surface),
          ]),
        )
      : surfaces;
  return {
    ...scene,
    primary: stripDatabaseLayoutFromSurface(scene.primary),
    panelSurfacesById,
  };
}

function isRawScenePanelSurfaceAllowed(ownerKind: unknown, surface: unknown): boolean {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) return true;
  const record = surface as Record<string, unknown>;
  if (ownerKind === "project") return record.kind !== "conversation" && record.kind !== "review";
  if (ownerKind === "session") return record.kind !== "conversation";
  if (ownerKind !== "pages") return true;

  const config = record.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const configRecord = config as Record<string, unknown>;
  const accessContext = configRecord.accessContext;
  if (!accessContext || typeof accessContext !== "object" || Array.isArray(accessContext)) {
    return false;
  }
  if ((accessContext as Record<string, unknown>).kind !== "library") return false;
  if (record.kind === "page_stage" || record.kind === "canvas_stage") return true;
  if (record.kind !== "db_view") return false;
  const target = configRecord.target;
  return (
    !!target &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    (target as Record<string, unknown>).kind !== "project-default"
  );
}

/**
 * Remove panel surfaces that cannot be owned by their persisted Scene without
 * discarding the rest of a valid layout. This also repairs Project Review
 * surfaces authored before Review ownership was constrained to Sessions.
 */
function stripOwnerInvalidPanelSurfacesFromScene(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const scene = value as Record<string, unknown>;
  const owner = scene.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return value;
  const ownerKind = (owner as Record<string, unknown>).kind;

  const surfaces = scene.panelSurfacesById;
  if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) return value;
  const removedSurfaceIds = Object.entries(surfaces).flatMap(([surfaceId, surface]) => {
    return isRawScenePanelSurfaceAllowed(ownerKind, surface) ? [] : [surfaceId];
  });
  if (removedSurfaceIds.length === 0) return value;
  const removedSurfaceIdSet = new Set(removedSurfaceIds);

  const panels = scene.panels;
  if (!panels || typeof panels !== "object" || Array.isArray(panels)) return value;
  const panelRecord = panels as Record<string, unknown>;
  const stripPanel = (panel: unknown): unknown => {
    const parsed = WorkbenchPanelStateSchema.safeParse(panel);
    if (!parsed.success) return panel;
    const layout = removedSurfaceIds.reduce(
      (current, surfaceId) => removeWorkbenchPanelTab(current, surfaceId),
      parsed.data.layout,
    );
    return { ...parsed.data, layout };
  };

  return {
    ...scene,
    panelSurfacesById: Object.fromEntries(
      Object.entries(surfaces).filter(([surfaceId]) => !removedSurfaceIdSet.has(surfaceId)),
    ),
    panels: {
      ...panelRecord,
      right: stripPanel(panelRecord.right),
      bottom: stripPanel(panelRecord.bottom),
    },
  };
}

function migrateWorkbenchSceneSnapshot(value: unknown): unknown {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (record?.version === WORKBENCH_SCENE_VERSION) {
    return stripOwnerInvalidPanelSurfacesFromScene(stripDatabaseLayoutsFromScene(value));
  }
  if (record?.version === 5 || record?.version === 6) {
    return stripOwnerInvalidPanelSurfacesFromScene({
      ...(stripDatabaseLayoutsFromScene(value) as Record<string, unknown>),
      version: WORKBENCH_SCENE_VERSION,
    });
  }
  const v4Candidate = record?.version === 4 ? stripDatabaseLayoutsFromScene(value) : value;
  const previousCurrent = WorkbenchSceneSnapshotV4InputSchema.safeParse(v4Candidate);
  if (previousCurrent.success) {
    return migrateWorkbenchSceneV4ToV5(previousCurrent.data);
  }
  const currentLegacy = WorkbenchSceneSnapshotV3InputSchema.safeParse(value);
  if (currentLegacy.success) {
    return migrateWorkbenchSceneV4ToV5(
      migrateWorkbenchSceneV3ToV4(currentLegacy.data) as WorkbenchSceneSnapshotV4,
    );
  }
  const previous = WorkbenchSceneSnapshotV2InputSchema.safeParse(value);
  if (previous.success) {
    return migrateWorkbenchSceneV4ToV5(
      migrateWorkbenchSceneV2ToV4(previous.data) as WorkbenchSceneSnapshotV4,
    );
  }
  const legacy = WorkbenchSceneSnapshotV1InputSchema.safeParse(value);
  if (!legacy.success) return value;
  return migrateWorkbenchSceneV4ToV5(
    migrateWorkbenchSceneV1ToV4(legacy.data) as WorkbenchSceneSnapshotV4,
  );
}

export const WorkbenchSceneSnapshotSchema = z.preprocess(
  migrateWorkbenchSceneSnapshot,
  z
    .object({
      version: z.literal(WORKBENCH_SCENE_VERSION),
      ...workbenchSceneSnapshotFields,
      composerOverlay: WorkbenchComposerOverlayStateSchema,
      agentDock: WorkbenchAgentDockStateSchema.nullable(),
    })
    .strict()
    .superRefine((scene, context) => {
      const entries = Object.entries(scene.panelSurfacesById);
      if (entries.length > WORKBENCH_SCENE_MAX_PANEL_SURFACES) {
        context.addIssue({
          code: "custom",
          path: ["panelSurfacesById"],
          message: `Scene contains more than ${WORKBENCH_SCENE_MAX_PANEL_SURFACES} panel surfaces`,
        });
      }

      for (const [surfaceId, surface] of entries) {
        if (surfaceId === surface.id) continue;
        context.addIssue({
          code: "custom",
          path: ["panelSurfacesById", surfaceId, "id"],
          message: "Surface map key must match surface.id",
        });
      }

      if (scene.primary && scene.panelSurfacesById[scene.primary.id]) {
        context.addIssue({
          code: "custom",
          path: ["primary", "id"],
          message: "Primary surface cannot also be owned as a regular panel surface",
        });
      }

      const placedIds = [
        ...flattenWorkbenchPanelTabIds(scene.panels.right.layout),
        ...flattenWorkbenchPanelTabIds(scene.panels.bottom.layout),
      ];
      const placementCount = new Map<string, number>();
      for (const surfaceId of placedIds) {
        placementCount.set(surfaceId, (placementCount.get(surfaceId) ?? 0) + 1);
      }
      for (const surfaceId of Object.keys(scene.panelSurfacesById)) {
        if (placementCount.get(surfaceId) === 1) continue;
        context.addIssue({
          code: "custom",
          path: ["panelSurfacesById", surfaceId],
          message: "Every panel surface must be placed exactly once",
        });
      }
      for (const surfaceId of placementCount.keys()) {
        if (scene.panelSurfacesById[surfaceId] || surfaceId === scene.primary?.id) continue;
        context.addIssue({
          code: "custom",
          path: ["panels"],
          message: `Panel placement references unknown surface ${surfaceId}`,
        });
      }

      if (scene.owner.kind === "project") {
        if (
          !scene.primary ||
          scene.primary.kind !== "db_view" ||
          scene.primary.config.accessContext.kind !== "project" ||
          scene.primary.config.accessContext.projectId !== scene.owner.projectId ||
          (scene.primary.config.target.kind !== "project-default" &&
            scene.primary.config.target.kind !== "database-view")
        ) {
          context.addIssue({
            code: "custom",
            path: ["primary"],
            message:
              "Project Scene primary must target the Project default or an exact Database View",
          });
        }
        if (scene.agentDock === null) {
          context.addIssue({
            code: "custom",
            path: ["agentDock"],
            message: "Project Scene must own Agent Dock view state",
          });
        }
        if (placementCount.get(scene.primary?.id ?? "") !== 1) {
          context.addIssue({
            code: "custom",
            path: ["primary", "id"],
            message: "Project primary must be placed exactly once",
          });
        }
        if (
          flattenWorkbenchPanelTabIds(scene.panels.bottom.layout).includes(scene.primary?.id ?? "")
        ) {
          context.addIssue({
            code: "custom",
            path: ["panels", "bottom"],
            message: "Project primary must stay in the right surface stack",
          });
        }
        const primaryLeaf = findWorkbenchPanelLeafForTab(
          scene.panels.right.layout,
          scene.primary?.id ?? "",
        );
        if (!primaryLeaf || primaryLeaf.tabIds[0] !== scene.primary?.id) {
          context.addIssue({
            code: "custom",
            path: ["panels", "right", "layout"],
            message: "Project primary must be the first tab in its leaf",
          });
        }
        if (scene.panels.right.collapsed || scene.panels.right.size.fullWidth !== true) {
          context.addIssue({
            code: "custom",
            path: ["panels", "right"],
            message: "Project right surface stack must remain open and full width",
          });
        }
        if (entries.some(([, surface]) => !isProjectScenePanelSurfaceAllowed(surface))) {
          context.addIssue({
            code: "custom",
            path: ["panelSurfacesById"],
            message: "Project Scene contains a Session-only panel surface",
          });
        }
      } else if (scene.owner.kind === "pages") {
        if (scene.primary !== null) {
          context.addIssue({
            code: "custom",
            path: ["primary"],
            message: "Pages Scene does not own a protected primary surface",
          });
        }
        if (scene.agentDock !== null || scene.composerOverlay.visible) {
          context.addIssue({
            code: "custom",
            path: ["agentDock"],
            message: "Pages Scene cannot own execution composer state",
          });
        }
        if (scene.panels.right.collapsed || scene.panels.right.size.fullWidth !== true) {
          context.addIssue({
            code: "custom",
            path: ["panels", "right"],
            message: "Pages right surface stack must remain open and full width",
          });
        }
        if (entries.some(([, surface]) => !isPagesSceneSurfaceAllowed(surface))) {
          context.addIssue({
            code: "custom",
            path: ["panelSurfacesById"],
            message: "Pages Scene contains a non-Library or execution-only surface",
          });
        }
      } else if (
        !scene.primary ||
        scene.primary.kind !== "conversation" ||
        scene.primary.config.sessionId !== scene.owner.sessionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["primary"],
          message: "Session Scene primary must target its owning Conversation",
        });
      } else {
        if (scene.agentDock !== null) {
          context.addIssue({
            code: "custom",
            path: ["agentDock"],
            message: "Session Scene cannot own a Project Agent Dock",
          });
        }
        if (placementCount.has(scene.primary.id)) {
          context.addIssue({
            code: "custom",
            path: ["primary", "id"],
            message: "Session primary remains in the main plane",
          });
        }
        if (entries.some(([, surface]) => surface.kind === "conversation")) {
          context.addIssue({
            code: "custom",
            path: ["panelSurfacesById"],
            message: "Session Scene contains a duplicate Conversation panel surface",
          });
        }
      }

      if (encodedJsonBytes(scene) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
        context.addIssue({
          code: "custom",
          message: "Scene exceeds its encoded size bound",
        });
      }
    }),
) satisfies z.ZodType<WorkbenchSceneSnapshot>;

export function validateWorkbenchSceneMapKey(
  sceneKey: string,
  scene: WorkbenchSceneSnapshot,
): boolean {
  return makeWorkbenchSceneKey(scene.owner) === sceneKey;
}
