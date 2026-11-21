import type {
  FileSearchSessionRef,
  FileSearchStartInput,
  FileSearchUpdateInput,
} from "../file-search";
import { isAbsoluteSearchPath } from "../file-search-paths";
import { z } from "zod";

const sessionId = z.string().uuid();
export const FileSearchStartSchema = z
  .object({
    sessionId,
    hostId: z.string().trim().min(1).max(256),
    roots: z.array(z.string().trim().min(1).max(4096).refine(isAbsoluteSearchPath)).min(1).max(32),
  })
  .strict() satisfies z.ZodType<FileSearchStartInput>;
export const FileSearchUpdateSchema = z
  .object({
    sessionId,
    query: z.string().max(512),
  })
  .strict() satisfies z.ZodType<FileSearchUpdateInput>;
export const FileSearchStopSchema = z
  .object({ sessionId })
  .strict() satisfies z.ZodType<FileSearchSessionRef>;
