import { z } from "zod";
import { isAbsoluteSearchPath } from "../file-search-paths";
import type { WorkspaceTextSearchRequest } from "../workspace-text-search";

const requestId = z.string().uuid();
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsoluteSearchPath)
  .refine((value) => !/[\r\n\0]/u.test(value));
export const WorkspaceTextSearchStartSchema = z
  .object({
    requestId,
    hostId: z.string().trim().min(1).max(256),
    roots: z.array(absolutePath).min(1).max(32),
    query: z
      .string()
      .max(256)
      .refine((value) => !/[\r\n\0]/u.test(value)),
    fileMask: z
      .string()
      .max(256)
      .refine((value) => !/[\r\n\0]/u.test(value))
      .optional(),
    priorityFolders: z.array(absolutePath).max(20).optional(),
  })
  .strict() satisfies z.ZodType<WorkspaceTextSearchRequest>;
export const WorkspaceTextSearchStopSchema = z.object({ requestId }).strict();
