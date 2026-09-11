import { contentAccessContextKey } from "../content-access-context";
import {
  canonicalWorkbenchFilesConfig,
  WorkbenchAbsoluteFilePathSchema,
  workbenchFilesResourceKey,
} from "../workbench-resource-identity";
import { WorkbenchSurfaceIdSchema } from "../workbench-resource-identity";
import { z } from "zod";
import type { WorkbenchSurfaceDescriptor } from "../workbench-scene";
import {
  WorkbenchSceneOwnerSchema,
  ContentAccessContextSchema,
  WorkbenchDbViewSurfaceConfigSchema,
} from "../schemas/workbench-scene";
import {
  WorkbenchCommandEnvelopeSchema,
  WorkbenchCommandReceiptSchema,
  type WorkbenchCommandEnvelope,
} from "./workbench-commands";
import {
  WorkbenchPrepareContentRequestSchema,
  WorkbenchPrepareContentResultSchema,
  WorkbenchValidateContentRequestSchema,
  WorkbenchValidateContentResultSchema,
} from "./workbench-content";
import {
  WorkbenchCaptureViewRequestSchema,
  WorkbenchCaptureViewResultSchema,
} from "./workbench-view-content";

export const WORKBENCH_OBSERVATION_MAX_TABS = 4_096;

const identity = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const panelId = z.enum(["right", "bottom"]);

export const WorkbenchWindowReferenceSchema = z
  .object({
    windowSessionId: identity,
    rendererGeneration: identity,
  })
  .strict();
export type WorkbenchWindowReference = z.infer<typeof WorkbenchWindowReferenceSchema>;

export const WorkbenchSceneReferenceSchema = WorkbenchWindowReferenceSchema.extend({
  sceneOwner: WorkbenchSceneOwnerSchema,
});
export type WorkbenchSceneReference = z.infer<typeof WorkbenchSceneReferenceSchema>;

export const WorkbenchFocusedTargetSchema = z
  .object({
    tabId: WorkbenchSurfaceIdSchema,
    panelId: panelId.nullable(),
    groupId: identity.nullable(),
  })
  .strict();
export type WorkbenchFocusedTarget = z.infer<typeof WorkbenchFocusedTargetSchema>;

const referenceBase = { id: WorkbenchSurfaceIdSchema, titleSnapshot: z.string().max(2_000) };
const filePath = WorkbenchAbsoluteFilePathSchema;

/** Closed semantic targets. Saved view state, favicons and image collections never cross here. */
export const WorkbenchSurfaceReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...referenceBase,
    kind: z.literal("conversation"),
    config: z.strictObject({ sessionId: identity }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("db_view"),
    config: WorkbenchDbViewSurfaceConfigSchema,
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("page_stage"),
    config: z.strictObject({ accessContext: ContentAccessContextSchema, pageId: identity }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("canvas_stage"),
    config: z.strictObject({ accessContext: ContentAccessContextSchema, canvasBlockId: identity }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("browser"),
    config: z.strictObject({ browserTabId: identity }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("terminal"),
    config: z.strictObject({
      terminalSessionId: identity,
      context: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("project"), projectId: identity }),
          z.strictObject({ kind: z.literal("session"), sessionId: identity }),
        ])
        .optional(),
    }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("files"),
    config: z.strictObject({
      projectId: identity.nullable(),
      hostId: z.literal("local"),
      workspaceRoot: filePath.nullable(),
      cwd: filePath.nullable(),
      path: filePath.optional(),
    }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("review"),
    config: z.strictObject({ projectId: identity.nullable() }),
  }),
  z.strictObject({
    ...referenceBase,
    kind: z.literal("image_editor"),
    config: z.strictObject({
      projectId: z.string().min(1).max(4_096).nullable(),
      threadId: z.string().min(1).max(4_096).nullable(),
      initialImageId: z.string().min(1).max(4_096),
    }),
  }),
]);
export type WorkbenchSurfaceReference = z.infer<typeof WorkbenchSurfaceReferenceSchema>;

export const WorkbenchObservedTabSchema = z
  .object({
    tabId: WorkbenchSurfaceIdSchema,
    panelId: panelId.nullable(),
    groupId: identity.nullable(),
    protected: z.boolean(),
    persisted: z.boolean(),
    preview: z.boolean(),
    selected: z.boolean(),
    visible: z.boolean(),
    surface: WorkbenchSurfaceReferenceSchema.nullable(),
    auxiliary: z
      .object({
        kind: z.enum([
          "side_chat",
          "mcp_app",
          "plan",
          "automation",
          "agent",
          "process_output",
          "image_editor",
        ]),
        title: z.string().max(2_000),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((tab) => (tab.surface === null) !== (tab.auxiliary === null), {
    message: "A tab has exactly one semantic surface or auxiliary target",
  });
export type WorkbenchObservedTab = Omit<z.infer<typeof WorkbenchObservedTabSchema>, "surface"> & {
  readonly surface: WorkbenchSurfaceReference | null;
};

/** Presentation coordinates only. Main binds the submitting renderer's physical identity. */
export const WorkbenchSubmitPresentationSchema = z
  .object({
    rendererGeneration: identity,
    sceneOwner: WorkbenchSceneOwnerSchema.nullable(),
    presentationRevision: revision,
    focusedTarget: WorkbenchFocusedTargetSchema.nullable(),
    selectedTabs: z.array(WorkbenchObservedTabSchema).max(WORKBENCH_OBSERVATION_MAX_TABS),
    availability: z.enum(["available", "partial", "unavailable"]).optional(),
    omittedTabCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkbenchSubmitPresentation = Omit<
  z.infer<typeof WorkbenchSubmitPresentationSchema>,
  "selectedTabs"
> & { readonly selectedTabs: readonly WorkbenchObservedTab[] };

export const PresentationAnchorSchema = WorkbenchSubmitPresentationSchema.extend({
  windowSessionId: identity,
  capturedAt: z.string().datetime(),
});
export type PresentationAnchor = WorkbenchSubmitPresentation & {
  readonly windowSessionId: string;
  readonly capturedAt: string;
};

export const WorkbenchObservedGroupSchema = z
  .object({
    groupId: identity,
    panelId,
    tabIds: z.array(WorkbenchSurfaceIdSchema).max(WORKBENCH_OBSERVATION_MAX_TABS),
    selectedTabId: identity.nullable(),
    focused: z.boolean(),
    visible: z.boolean(),
  })
  .strict();
export type WorkbenchObservedGroup = z.infer<typeof WorkbenchObservedGroupSchema>;

export const WorkbenchObservedPanelSchema = z
  .object({
    panelId,
    collapsed: z.boolean(),
    activeGroupId: identity,
    maximizedGroupId: identity.nullable(),
    size: z
      .object({
        widthPx: z.number().finite().nonnegative().optional(),
        heightPx: z.number().finite().nonnegative().optional(),
        fullWidth: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const WorkbenchObservedSplitSchema = z
  .object({
    branchId: identity,
    panelId,
    direction: z.enum(["horizontal", "vertical"]),
    ratio: z.number().finite().min(0.15).max(0.85),
    firstGroupIds: z.array(identity).max(512),
    secondGroupIds: z.array(identity).max(512),
  })
  .strict();

/** Trusted renderer evidence, before Main's independent per-target authorization/redaction. */
export const WorkbenchRendererObservationSchema = z
  .object({
    sceneOwner: WorkbenchSceneOwnerSchema,
    selectedSceneOwner: WorkbenchSceneOwnerSchema.nullable(),
    presentationRevision: revision,
    mounted: z.boolean(),
    focusedTarget: WorkbenchFocusedTargetSchema.nullable(),
    tabs: z.array(WorkbenchObservedTabSchema).max(WORKBENCH_OBSERVATION_MAX_TABS),
    availability: z.enum(["available", "partial"]).optional(),
    omittedTabCount: z.number().int().nonnegative().optional(),
    groups: z.array(WorkbenchObservedGroupSchema).max(512),
    panels: z.array(WorkbenchObservedPanelSchema).length(2),
    splits: z.array(WorkbenchObservedSplitSchema).max(510),
  })
  .strict()
  .superRefine((observation, context) => {
    const tabs = new Map(observation.tabs.map((tab) => [tab.tabId, tab]));
    if (tabs.size !== observation.tabs.length)
      context.addIssue({ code: "custom", message: "Observed tab identities must be unique" });
    const groupIds = new Set(observation.groups.map((group) => group.groupId));
    if (groupIds.size !== observation.groups.length)
      context.addIssue({ code: "custom", message: "Observed group identities must be unique" });
    for (const tab of observation.tabs) {
      if (tab.surface && tab.surface.id !== tab.tabId)
        context.addIssue({
          code: "custom",
          message: "Observed surface identity must match its tab",
        });
    }
    for (const group of observation.groups) {
      if (
        new Set(group.tabIds).size !== group.tabIds.length ||
        group.tabIds.some(
          (id) =>
            tabs.get(id)?.groupId !== group.groupId || tabs.get(id)?.panelId !== group.panelId,
        )
      )
        context.addIssue({
          code: "custom",
          message: "Observed group membership must resolve exactly once",
        });
      if (group.selectedTabId && !group.tabIds.includes(group.selectedTabId))
        context.addIssue({
          code: "custom",
          message: "Selected tab must belong to its observed group",
        });
    }
  });
export type WorkbenchRendererObservation = Omit<
  z.infer<typeof WorkbenchRendererObservationSchema>,
  "tabs"
> & {
  readonly tabs: readonly WorkbenchObservedTab[];
};

export const WorkbenchAgentRequestBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discover"), sessionId: identity }).strict(),
  z.object({ kind: z.literal("observe"), sceneOwner: WorkbenchSceneOwnerSchema }).strict(),
  z.object({ kind: z.literal("command"), envelope: WorkbenchCommandEnvelopeSchema }).strict(),
  WorkbenchPrepareContentRequestSchema,
  WorkbenchValidateContentRequestSchema,
  WorkbenchCaptureViewRequestSchema,
]);
export type WorkbenchAgentRequestBody =
  | Exclude<z.infer<typeof WorkbenchAgentRequestBodySchema>, { kind: "command" }>
  | { readonly kind: "command"; readonly envelope: WorkbenchCommandEnvelope };

export const WorkbenchAgentResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("discover"),
      presentationRevision: revision,
      selectedSceneOwner: WorkbenchSceneOwnerSchema.nullable(),
      sceneOwners: z.array(WorkbenchSceneOwnerSchema).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("observe"),
      observation: WorkbenchRendererObservationSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("command"), receipt: WorkbenchCommandReceiptSchema }).strict(),
  z
    .object({
      kind: z.literal("prepare_content"),
      preparation: WorkbenchPrepareContentResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("validate_content"),
      validation: WorkbenchValidateContentResultSchema,
    })
    .strict(),
  z.strictObject({ kind: z.literal("capture_view"), capture: WorkbenchCaptureViewResultSchema }),
]);
export type WorkbenchAgentResult =
  | Extract<
      z.infer<typeof WorkbenchAgentResultSchema>,
      { kind: "discover" | "command" | "prepare_content" | "validate_content" | "capture_view" }
    >
  | { readonly kind: "observe"; readonly observation: WorkbenchRendererObservation | null };

export const WorkbenchAgentRequestSchema = WorkbenchWindowReferenceSchema.extend({
  requestId: identity,
  body: WorkbenchAgentRequestBodySchema,
});
export type WorkbenchAgentRequest = Omit<z.infer<typeof WorkbenchAgentRequestSchema>, "body"> & {
  readonly body: WorkbenchAgentRequestBody;
};
export const WorkbenchAgentCancelSchema = WorkbenchWindowReferenceSchema.extend({
  requestId: identity,
});
export type WorkbenchAgentCancel = z.infer<typeof WorkbenchAgentCancelSchema>;
export const WorkbenchAgentRegisterSchema = z.object({ ownerId: z.string().uuid() }).strict();

export const WorkbenchAgentReplySchema = WorkbenchWindowReferenceSchema.extend({
  requestId: identity,
  outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result: WorkbenchAgentResultSchema }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z.enum([
          "unavailable",
          "stale_presentation",
          "invalid_request",
          "result_too_large",
          "cancelled",
          "failed",
        ]),
      })
      .strict(),
  ]),
});
export type WorkbenchAgentReply = Omit<z.infer<typeof WorkbenchAgentReplySchema>, "outcome"> & {
  readonly outcome:
    | { readonly ok: true; readonly result: WorkbenchAgentResult }
    | Extract<z.infer<typeof WorkbenchAgentReplySchema>["outcome"], { ok: false }>;
};

export const WORKBENCH_AGENT_REQUEST_CHANNEL = "workbench-agent:request";
export const WORKBENCH_AGENT_CANCEL_CHANNEL = "workbench-agent:cancel";
export const WORKBENCH_AGENT_MAX_REPLY_BYTES = 768 * 1_024;

/** The context boundary owns a semantic projection, never a copy of saved presentation config. */
export function projectWorkbenchSurfaceReference(
  surface: WorkbenchSurfaceReference | WorkbenchSurfaceDescriptor,
): WorkbenchSurfaceReference {
  const base = { id: surface.id, titleSnapshot: surface.titleSnapshot };
  if (surface.kind === "files")
    return { ...base, kind: "files", config: canonicalWorkbenchFilesConfig(surface.config) };
  if (surface.kind === "browser")
    return { ...base, kind: "browser", config: { browserTabId: surface.config.browserTabId } };
  if (surface.kind === "image_editor")
    return {
      ...base,
      kind: "image_editor",
      config: {
        projectId: surface.config.projectId,
        threadId: surface.config.threadId,
        initialImageId: surface.config.initialImageId,
      },
    };
  if (surface.kind === "page_stage")
    return {
      ...base,
      kind: surface.kind,
      config: { accessContext: surface.config.accessContext, pageId: surface.config.pageId },
    };
  if (surface.kind === "canvas_stage")
    return {
      ...base,
      kind: surface.kind,
      config: {
        accessContext: surface.config.accessContext,
        canvasBlockId: surface.config.canvasBlockId,
      },
    };
  const {
    state: _state,
    stateKey: _stateKey,
    ...reference
  } = { state: null, stateKey: 0, ...surface };
  return reference;
}

/** Identity and authorization scope, independent of property order or mutable display settings. */
function observedTargetKey(surface: WorkbenchSurfaceReference): string {
  const { kind, config } = surface;
  if (kind === "conversation") return JSON.stringify([kind, config.sessionId]);
  if (kind === "browser") return JSON.stringify([kind, config.browserTabId]);
  if (kind === "files")
    return JSON.stringify([kind, config.projectId, workbenchFilesResourceKey(config)]);
  if (kind === "review") return JSON.stringify([kind, config.projectId]);
  if (kind === "terminal")
    return JSON.stringify([
      kind,
      config.terminalSessionId,
      config.context?.kind,
      config.context?.kind === "project" ? config.context.projectId : config.context?.sessionId,
    ]);
  if (kind === "image_editor")
    return JSON.stringify([kind, config.projectId, config.threadId, config.initialImageId]);
  const access = contentAccessContextKey(config.accessContext);
  if (kind === "page_stage") return JSON.stringify([kind, access, config.pageId]);
  if (kind === "canvas_stage") return JSON.stringify([kind, access, config.canvasBlockId]);
  return JSON.stringify([
    kind,
    access,
    config.target.kind,
    config.target.kind === "database-view"
      ? config.target.databaseViewId
      : config.target.kind === "database-default"
        ? config.target.databaseId
        : null,
  ]);
}

export function sameWorkbenchObservedTarget(
  left: WorkbenchObservedTab,
  right: WorkbenchObservedTab,
): boolean {
  if (left.tabId !== right.tabId) return false;
  if (!left.surface || !right.surface)
    return left.surface === right.surface && left.auxiliary?.kind === right.auxiliary?.kind;
  return observedTargetKey(left.surface) === observedTargetKey(right.surface);
}

export function unavailableWorkbenchSubmission(): z.infer<
  typeof WorkbenchSubmitPresentationSchema
> {
  return {
    rendererGeneration: "unavailable",
    sceneOwner: null,
    presentationRevision: 0,
    focusedTarget: null,
    selectedTabs: [],
    availability: "unavailable",
  };
}
