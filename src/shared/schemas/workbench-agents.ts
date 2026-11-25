import { z } from "zod";
import type { AgentsMapScope } from "../agents-map";

export const WorkbenchAgentsSurfaceConfigSchema = z.strictObject({
  projectId: z
    .string()
    .min(1)
    .max(512)
    .refine((id) => id.trim() === id)
    .nullable(),
}) satisfies z.ZodType<AgentsMapScope>;
