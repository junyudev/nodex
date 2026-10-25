import { z } from "zod";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceFileMetadataInput,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
  WorkspaceFileWriteInput,
  WorkspaceFileWatchStopInput,
  WorkspacePathsExistInput,
} from "../types";

const hostIdSchema = z.string().trim().min(1).optional();
const localHostIdSchema = z.literal("local").optional();
const exactFilePathSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "File path is required",
});
const positiveByteLimitSchema = z
  .number()
  .int()
  .positive()
  .max(100 * 1024 * 1024);

export const WorkspaceDirectoryEntriesInputSchema = z
  .object({
    hostId: hostIdSchema,
    workspaceRoot: exactFilePathSchema,
    directoryPath: z.string().optional(),
    includeHidden: z.boolean().optional(),
    directoriesOnly: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<WorkspaceDirectoryEntriesInput>;

export const WorkspaceFileRequestSchema = z
  .object({
    hostId: hostIdSchema,
    path: exactFilePathSchema,
  })
  .strict() satisfies z.ZodType<WorkspaceFileRequest>;

export const WorkspaceLocalFileRequestSchema = WorkspaceFileRequestSchema.extend({
  hostId: localHostIdSchema,
}).strict();

export const WorkspacePathsExistInputSchema = z
  .object({ hostId: hostIdSchema, paths: z.array(z.string().min(1)) })
  .strict() satisfies z.ZodType<WorkspacePathsExistInput>;

export const WorkspaceFileTextReadInputSchema = WorkspaceFileRequestSchema.extend({
  maxBytes: positiveByteLimitSchema,
}).strict() satisfies z.ZodType<WorkspaceFileTextReadInput>;

export const WorkspaceFileMetadataInputSchema = WorkspaceFileRequestSchema.extend({
  contentSampleByteLimit: positiveByteLimitSchema.optional(),
  contentSampleMaxFileBytes: positiveByteLimitSchema.optional(),
}).strict() satisfies z.ZodType<WorkspaceFileMetadataInput>;

export const WorkspaceFileWriteInputSchema = WorkspaceFileRequestSchema.extend({
  hostId: localHostIdSchema,
  content: z.string(),
  expectedMtimeMs: z.number().finite().nonnegative().nullable(),
}).strict() satisfies z.ZodType<WorkspaceFileWriteInput>;

export const WorkspaceFileWatchStopInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
  })
  .strict() satisfies z.ZodType<WorkspaceFileWatchStopInput>;
