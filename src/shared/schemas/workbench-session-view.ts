import { z } from "zod";
import { WorkbenchSurfaceIdSchema } from "../workbench-resource-identity";
import type {
  WorkbenchPanelLayout,
  WorkbenchPanelNode,
  WorkbenchPanelState,
  WorkbenchSessionViewSnapshot,
  WorkbenchSessionViewTab,
} from "../workbench-session-view";
import {
  WORKBENCH_SESSION_VIEW_MAX_TABS,
  WORKBENCH_SESSION_VIEW_VERSION,
} from "../workbench-session-view";
import { WorkbenchReviewConfigSchema } from "./workbench-review";
import { WorkbenchImageEditorSurfaceConfigSchema } from "./workbench-image-editor";
import { BrowserSidebarDeviceToolbarStateSchema } from "../browser/browser-schemas";
import { primaryCanvasBlockId } from "../block-documents/canvas-document-identity";

export const MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_WORKBENCH_PANEL_NODE_DEPTH = 32;
export const MAX_WORKBENCH_PANEL_NODE_COUNT = 256;

const idSchema = z.string().min(1).max(512);
const tabIdSchema = WorkbenchSurfaceIdSchema;
const titleSchema = z.string().max(2_000);

function encodedJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function inspectPanelNode(node: WorkbenchPanelNode, depth = 1): { depth: number; count: number } {
  if (node.type === "leaf") return { depth, count: 1 };
  const first = inspectPanelNode(node.first, depth + 1);
  const second = inspectPanelNode(node.second, depth + 1);
  return {
    depth: Math.max(first.depth, second.depth),
    count: 1 + first.count + second.count,
  };
}

const WorkbenchPanelNodeSchema: z.ZodType<WorkbenchPanelNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("leaf"),
        id: idSchema,
        tabIds: z.array(tabIdSchema).max(WORKBENCH_SESSION_VIEW_MAX_TABS),
        activeTabId: tabIdSchema.nullable(),
        mruTabIds: z.array(tabIdSchema).max(WORKBENCH_SESSION_VIEW_MAX_TABS),
      })
      .strict(),
    z
      .object({
        type: z.literal("split"),
        id: idSchema,
        direction: z.enum(["horizontal", "vertical"]),
        first: WorkbenchPanelNodeSchema,
        second: WorkbenchPanelNodeSchema,
        ratio: z.number().finite().min(0.1).max(0.9),
      })
      .strict(),
  ]),
);

export const WorkbenchPanelLayoutSchema = z
  .object({
    version: z.literal(2),
    root: WorkbenchPanelNodeSchema,
    activeLeafId: idSchema,
    mruLeafIds: z.array(idSchema).max(MAX_WORKBENCH_PANEL_NODE_COUNT),
    maximizedLeafId: idSchema.nullable().optional(),
  })
  .strict()
  .superRefine((layout, context) => {
    const inspection = inspectPanelNode(layout.root);
    if (inspection.depth > MAX_WORKBENCH_PANEL_NODE_DEPTH) {
      context.addIssue({
        code: "custom",
        message: `Panel tree depth exceeds ${MAX_WORKBENCH_PANEL_NODE_DEPTH}`,
      });
    }
    if (inspection.count > MAX_WORKBENCH_PANEL_NODE_COUNT) {
      context.addIssue({
        code: "custom",
        message: `Panel tree node count exceeds ${MAX_WORKBENCH_PANEL_NODE_COUNT}`,
      });
    }
    if (encodedJsonBytes(layout) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Panel layout exceeds its encoded size bound",
      });
    }
  }) satisfies z.ZodType<WorkbenchPanelLayout>;

export const WorkbenchPanelStateSchema = z
  .object({
    collapsed: z.boolean(),
    layout: WorkbenchPanelLayoutSchema,
    size: z
      .object({
        widthPx: z.number().finite().positive().optional(),
        heightPx: z.number().finite().positive().optional(),
        fullWidth: z.boolean().optional(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<WorkbenchPanelState>;

const WorkbenchDbViewTabConfigSchema = z
  .object({
    projectId: z.string().min(1),
    databaseViewId: z.string().min(1),
  })
  .strict();

const WorkbenchPageStageTabConfigSchema = z
  .object({
    projectId: z.string().min(1),
    pageId: z.string().min(1),
    titleSnapshot: z.string().optional(),
  })
  .strict();

const WorkbenchCanvasStageTabConfigSchema = z
  .object({
    projectId: z.string().min(1),
    canvasBlockId: z.string().min(1),
    titleSnapshot: z.string().optional(),
  })
  .strict();

const WorkbenchTerminalTabConfigSchema = z
  .object({
    terminalSessionId: z.string().min(1),
  })
  .strict();

const WorkbenchBrowserTabConfigSchema = z
  .object({
    browserTabId: z.string().min(1),
    browserStorageId: z.string().min(1).optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    faviconUrl: z.string().optional(),
    deviceToolbarVisible: z.boolean().optional(),
    deviceToolbarState: BrowserSidebarDeviceToolbarStateSchema.optional(),
  })
  .strict();

const WorkbenchReviewTabConfigSchema = WorkbenchReviewConfigSchema;

const WorkbenchFilesTabConfigSchema = z
  .object({
    projectId: z.string().min(1).nullable(),
    hostId: z.literal("local"),
    workspaceRoot: z.string().min(1).nullable(),
    cwd: z.string().min(1).nullable(),
    path: z.string().min(1).optional(),
  })
  .strict();

const tabBaseSchema = {
  id: tabIdSchema,
  titleSnapshot: titleSchema,
  stateKey: z.number().int().nonnegative(),
  state: z.unknown(),
} as const;

export const WorkbenchSessionViewTabSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("db_view"),
        config: WorkbenchDbViewTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("page_stage"),
        config: WorkbenchPageStageTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("canvas_stage"),
        config: WorkbenchCanvasStageTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("terminal"),
        config: WorkbenchTerminalTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("browser"),
        config: WorkbenchBrowserTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("review"),
        config: WorkbenchReviewTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("files"),
        config: WorkbenchFilesTabConfigSchema,
      })
      .strict(),
    z
      .object({
        ...tabBaseSchema,
        kind: z.literal("image_editor"),
        config: WorkbenchImageEditorSurfaceConfigSchema,
      })
      .strict(),
  ])
  .superRefine((tab, context) => {
    if (encodedJsonBytes(tab.config) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Tab config exceeds its encoded size bound",
      });
    }
    if (encodedJsonBytes(tab.state) > MAX_WORKBENCH_SESSION_VIEW_JSON_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Tab state exceeds its encoded size bound",
      });
    }
  }) satisfies z.ZodType<WorkbenchSessionViewTab>;

function migrateWorkbenchSessionView(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.version === WORKBENCH_SESSION_VIEW_VERSION) return value;
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) {
    return value;
  }
  const tabsById =
    typeof record.tabsById === "object" &&
    record.tabsById !== null &&
    !Array.isArray(record.tabsById)
      ? Object.fromEntries(
          Object.entries(record.tabsById).map(([tabId, candidate]) => {
            if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
              return [tabId, candidate];
            }
            const tab = candidate as Record<string, unknown>;
            const config =
              typeof tab.config === "object" && tab.config !== null && !Array.isArray(tab.config)
                ? (tab.config as Record<string, unknown>)
                : null;
            if (tab.kind !== "db_view" || !config) {
              return [tabId, candidate];
            }
            if (
              (record.version === 1 || record.version === 2) &&
              config.view === "canvas" &&
              typeof config.projectId === "string"
            ) {
              return [
                tabId,
                {
                  ...tab,
                  kind: "canvas_stage",
                  state: null,
                  config: {
                    projectId: config.projectId,
                    canvasBlockId: primaryCanvasBlockId(config.projectId),
                    ...(typeof tab.titleSnapshot === "string"
                      ? { titleSnapshot: tab.titleSnapshot }
                      : {}),
                  },
                },
              ];
            }
            const { view: legacyLayout, ...durableConfig } = config;
            void legacyLayout;
            return [tabId, { ...tab, config: durableConfig }];
          }),
        )
      : record.tabsById;
  return {
    ...record,
    tabsById,
    version: WORKBENCH_SESSION_VIEW_VERSION,
  };
}

export const WorkbenchSessionViewSnapshotSchema = z.preprocess(
  migrateWorkbenchSessionView,
  z
    .object({
      version: z.literal(WORKBENCH_SESSION_VIEW_VERSION),
      sessionId: z.string().min(1),
      tabsById: z.record(tabIdSchema, WorkbenchSessionViewTabSchema),
      panels: z
        .object({
          right: WorkbenchPanelStateSchema,
          bottom: WorkbenchPanelStateSchema,
        })
        .strict(),
      lastFocusedPanelId: z.enum(["right", "bottom"]).nullable(),
      touchedAt: z.iso.datetime(),
    })
    .strict()
    .superRefine((view, context) => {
      const entries = Object.entries(view.tabsById);
      if (entries.length > WORKBENCH_SESSION_VIEW_MAX_TABS) {
        context.addIssue({
          code: "custom",
          message: `Session view contains more than ${WORKBENCH_SESSION_VIEW_MAX_TABS} tabs`,
        });
      }
      for (const [tabId, tab] of entries) {
        if (tabId === tab.id) continue;
        context.addIssue({
          code: "custom",
          path: ["tabsById", tabId, "id"],
          message: "Tab map key must match tab.id",
        });
      }
    }),
) satisfies z.ZodType<WorkbenchSessionViewSnapshot>;
