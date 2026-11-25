import { z } from "zod";
import { AGENTS_MAP_MAX_RECENT_LIMIT, type AgentsMapReadInput } from "../agents-map";

export const AgentsMapReadInputSchema: z.ZodType<AgentsMapReadInput> = z.strictObject({
  scope: z.strictObject({
    projectId: z
      .string()
      .min(1)
      .max(512)
      .refine((id) => id.trim() === id)
      .nullable(),
  }),
  recentLimit: z.number().int().min(0).max(AGENTS_MAP_MAX_RECENT_LIMIT),
});
