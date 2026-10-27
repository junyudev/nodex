import { z } from "zod";
import type {
  FileOpenApplicationsInput,
  OpenFileWithApplicationInput,
} from "../file-open-applications";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value), {
    message: "An absolute local path is required",
  });

export const FileOpenApplicationsInputSchema = z
  .object({ path: absolutePath })
  .strict() satisfies z.ZodType<FileOpenApplicationsInput>;

export const OpenFileWithApplicationInputSchema = FileOpenApplicationsInputSchema.extend({
  appPath: absolutePath.refine((value) => /\.app\/?$/iu.test(value), {
    message: "An application bundle path is required",
  }),
}).strict() satisfies z.ZodType<OpenFileWithApplicationInput>;
