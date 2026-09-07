import { z } from "zod";
import { WorkbenchSurfaceRevealSchema } from "./workbench-reveal";
import type { WorkbenchSurfaceDescriptor } from "../workbench-scene";
import {
  WorkbenchSceneOwnerSchema,
  WorkbenchSurfaceDescriptorSchema,
} from "../schemas/workbench-scene";

const identity = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const panelId = z.enum(["right", "bottom"]);
const groupTarget = { panelId, groupId: identity };
const [firstSurface, ...otherSurfaces] = WorkbenchSurfaceDescriptorSchema.options.map((schema) =>
  schema.omit({ id: true, state: true, stateKey: true }),
);

/** Uses the Scene owner's closed semantic config; saved view state and caller-made tab IDs are absent. */
export const WorkbenchOpenSurfaceSchema = z.discriminatedUnion("kind", [
  firstSurface!,
  ...otherSurfaces,
]);

export const WorkbenchCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("activate_surface"), tabId: identity }),
  z.strictObject({ kind: z.literal("navigate_session"), projectId: identity.nullable() }),
  z.strictObject({
    kind: z.literal("open_surface"),
    panelId,
    surface: WorkbenchOpenSurfaceSchema,
    reveal: WorkbenchSurfaceRevealSchema.optional(),
  }),
  z
    .object({ kind: z.literal("open_tab"), ...groupTarget, surface: WorkbenchOpenSurfaceSchema })
    .strict(),
  z.object({ kind: z.literal("activate_tab"), tabId: identity }).strict(),
  z.object({ kind: z.literal("close_tab"), tabId: identity }).strict(),
  z
    .object({
      kind: z.literal("move_tab"),
      tabId: identity,
      ...groupTarget,
      index: z.number().int().min(0).max(2_048),
      splitSide: z.enum(["left", "right", "up", "down"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reorder_tabs"),
      ...groupTarget,
      tabIds: z.array(identity).max(2_048),
    })
    .strict(),
  z
    .object({
      kind: z.literal("split_group"),
      ...groupTarget,
      side: z.enum(["left", "right", "up", "down"]),
      tabId: identity.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("merge_group"), ...groupTarget }).strict(),
  z
    .object({
      kind: z.literal("set_panel_state"),
      panelId,
      collapsed: z.boolean().optional(),
      maximizedGroupId: identity.nullable().optional(),
      size: z
        .object({
          widthPx: z.number().finite().min(180).max(8_192).optional(),
          heightPx: z.number().finite().min(120).max(8_192).optional(),
          fullWidth: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
type OpenSurface<Surface> = Surface extends WorkbenchSurfaceDescriptor
  ? Omit<Surface, "id" | "state" | "stateKey">
  : never;
export type WorkbenchCommand =
  | Exclude<z.infer<typeof WorkbenchCommandSchema>, { kind: "open_tab" | "open_surface" }>
  | (Omit<Extract<z.infer<typeof WorkbenchCommandSchema>, { kind: "open_tab" }>, "surface"> & {
      readonly surface: OpenSurface<WorkbenchSurfaceDescriptor>;
    })
  | (Omit<Extract<z.infer<typeof WorkbenchCommandSchema>, { kind: "open_surface" }>, "surface"> & {
      readonly surface: OpenSurface<WorkbenchSurfaceDescriptor>;
    });

export const WorkbenchCommandEnvelopeSchema = z
  .object({
    operationId: identity,
    sceneOwner: WorkbenchSceneOwnerSchema,
    expectedPresentationRevision: revision,
    command: WorkbenchCommandSchema,
  })
  .strict();
export type WorkbenchCommandEnvelope = Omit<
  z.infer<typeof WorkbenchCommandEnvelopeSchema>,
  "command"
> & { readonly command: WorkbenchCommand };

export const WorkbenchCommandErrorSchema = z.enum([
  "stale_presentation",
  "revoked_generation",
  "scene_not_found",
  "tab_not_found",
  "group_not_found",
  "protected_primary",
  "invalid_placement",
  "invalid_order",
  "save_failed",
  "persistence_failed",
  "runtime_cleanup_failed",
  "operation_id_reused",
  "receipt_capacity",
  "invalid_command",
]);
export type WorkbenchCommandError = z.infer<typeof WorkbenchCommandErrorSchema>;

export const WorkbenchCommandReceiptSchema = z
  .object({
    operationId: identity,
    sceneOwner: WorkbenchSceneOwnerSchema,
    applied: z.boolean(),
    persisted: z.boolean(),
    presentationRevision: revision,
    layoutRevision: revision.nullable(),
    tabId: identity.nullable(),
    groupId: identity.nullable(),
    error: WorkbenchCommandErrorSchema.nullable(),
  })
  .strict();
export type WorkbenchCommandReceipt = z.infer<typeof WorkbenchCommandReceiptSchema>;

export const WORKBENCH_COMMAND_MAX_BYTES = 64 * 1_024;
export const WORKBENCH_COMMAND_MAX_RECEIPTS = 256;
