import { z } from "zod";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceFileMetadataInput,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
  WorkspaceFileWriteInput,
  WorkspaceFileWatchStopInput,
} from "../types";

const hostIdSchema = z.literal("local").optional();
const pathSchema = z.string().trim().min(1);
const positiveByteLimitSchema = z
  .number()
  .int()
  .positive()
  .max(100 * 1024 * 1024);

export const WorkspaceDirectoryEntriesInputSchema = z
  .object({
    hostId: hostIdSchema,
    workspaceRoot: pathSchema,
    directoryPath: z.string().optional(),
    includeHidden: z.boolean().optional(),
    directoriesOnly: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<WorkspaceDirectoryEntriesInput>;

export const WorkspaceFileRequestSchema = z
  .object({
    hostId: hostIdSchema,
    path: pathSchema,
  })
  .strict() satisfies z.ZodType<WorkspaceFileRequest>;

export const WorkspaceFileTextReadInputSchema = WorkspaceFileRequestSchema.extend({
  maxBytes: positiveByteLimitSchema,
}).strict() satisfies z.ZodType<WorkspaceFileTextReadInput>;

export const WorkspaceFileMetadataInputSchema = WorkspaceFileRequestSchema.extend({
  contentSampleByteLimit: positiveByteLimitSchema.optional(),
  contentSampleMaxFileBytes: positiveByteLimitSchema.optional(),
}).strict() satisfies z.ZodType<WorkspaceFileMetadataInput>;

export const WorkspaceFileWriteInputSchema = WorkspaceFileRequestSchema.extend({
  content: z.string(),
  expectedMtimeMs: z.number().finite().nonnegative().nullable(),
}).strict() satisfies z.ZodType<WorkspaceFileWriteInput>;

export const WorkspaceFileWatchStopInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
  })
  .strict() satisfies z.ZodType<WorkspaceFileWatchStopInput>;
