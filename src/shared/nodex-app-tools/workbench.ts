import { z } from "zod";
import type { WorkbenchSurfaceDescriptor } from "../workbench-scene";
import {
  WorkbenchSceneOwnerSchema,
  WorkbenchSurfaceDescriptorSchema,
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
    tabId: identity,
    panelId: panelId.nullable(),
    groupId: identity.nullable(),
  })
  .strict();
export type WorkbenchFocusedTarget = z.infer<typeof WorkbenchFocusedTargetSchema>;

type SurfaceReference<Surface> = Surface extends WorkbenchSurfaceDescriptor
  ? Omit<Surface, "state" | "stateKey">
  : never;
export type WorkbenchSurfaceReference = SurfaceReference<WorkbenchSurfaceDescriptor>;

// Reuse the owning descriptor's closed kind/config grammar, excluding saved view state.
const [firstSurface, ...remainingSurfaces] = WorkbenchSurfaceDescriptorSchema.options.map(
  (schema) => schema.omit({ state: true, stateKey: true }),
);
export const WorkbenchSurfaceReferenceSchema = z.discriminatedUnion("kind", [
  firstSurface!,
  ...remainingSurfaces,
]) satisfies z.ZodType<WorkbenchSurfaceReference>;

export const WorkbenchObservedTabSchema = z
  .object({
    tabId: identity,
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
    selectedTabs: z.array(WorkbenchObservedTabSchema).max(2_048),
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
    tabIds: z.array(identity).max(2_048),
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
    tabs: z.array(WorkbenchObservedTabSchema).max(2_048),
    groups: z.array(WorkbenchObservedGroupSchema).max(512),
    panels: z.array(WorkbenchObservedPanelSchema).length(2),
    splits: z.array(WorkbenchObservedSplitSchema).max(510),
  })
  .strict();
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
