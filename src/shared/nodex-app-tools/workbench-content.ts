import { z } from "zod";
import { ContentAccessContextSchema, WorkbenchSceneOwnerSchema } from "../schemas/workbench-scene";

const identity = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unavailable = z
  .object({
    status: z.enum([
      "pending_local_edits",
      "stale_presentation",
      "surface_unavailable",
      "cancelled",
    ]),
  })
  .strict();

export const WorkbenchPrepareContentRequestSchema = z
  .object({
    kind: z.literal("prepare_content"),
    sceneOwner: WorkbenchSceneOwnerSchema,
    tabId: identity,
    expectedPresentationRevision: revision,
  })
  .strict();
export type WorkbenchPrepareContentRequest = z.infer<typeof WorkbenchPrepareContentRequestSchema>;

export const WorkbenchValidateContentRequestSchema = z
  .object({
    kind: z.literal("validate_content"),
    token: z.string().uuid(),
  })
  .strict();
export type WorkbenchValidateContentRequest = z.infer<typeof WorkbenchValidateContentRequestSchema>;

/** An opaque renderer token binds this fence to one mounted editor, not merely a Document. */
export const WorkbenchPreparedPageContentSchema = z
  .object({
    status: z.literal("ready"),
    token: z.string().uuid(),
    editorSurfaceId: identity,
    pageId: identity,
    documentId: identity,
    libraryId: identity,
    accessContext: ContentAccessContextSchema,
    storeEpoch: identity,
    generation: revision.min(1),
    expectedHeadSeq: revision,
    localEditRevision: revision,
    preparedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type WorkbenchPreparedPageContent = z.infer<typeof WorkbenchPreparedPageContentSchema>;
export const WorkbenchPrepareContentResultSchema = z.union([
  WorkbenchPreparedPageContentSchema,
  unavailable,
]);
export type WorkbenchPrepareContentResult = z.infer<typeof WorkbenchPrepareContentResultSchema>;

export const WorkbenchValidateContentResultSchema = z.union([
  z
    .object({
      status: z.literal("synchronized"),
      token: z.string().uuid(),
      checkedAt: z.string().datetime(),
      headSeq: revision,
      localEditRevision: revision,
    })
    .strict(),
  unavailable,
  z.object({ status: z.literal("expired") }).strict(),
]);
export type WorkbenchValidateContentResult = z.infer<typeof WorkbenchValidateContentResultSchema>;
