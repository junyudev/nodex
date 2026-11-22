import { z } from "zod";
import { CLAUDE_EFFORT_LEVELS, type ClaudeCustomModel } from "./claude-model-types.ts";
export const ClaudeModelTraitsSchema = z
  .object({
    effortLevels: z.array(z.enum(CLAUDE_EFFORT_LEVELS)).max(5).optional(),
    fastMode: z.boolean().optional(),
    adaptiveThinking: z.boolean().optional(),
    disableThinking: z.boolean().optional(),
    disabledThinkingEfforts: z.array(z.enum(CLAUDE_EFFORT_LEVELS)).max(5).optional(),
    contextWindows: z
      .array(z.string().regex(/^\d+[km]$/u))
      .max(8)
      .optional(),
  })
  .strict();
export const ClaudeCustomModelSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => value !== "default", "Default follows Claude configuration."),
    displayName: z.string().trim().min(1).max(128),
    traits: ClaudeModelTraitsSchema.default({}),
  })
  .strict();

export const ClaudeCustomModelsSchema: z.ZodType<readonly ClaudeCustomModel[]> = z
  .array(ClaudeCustomModelSchema)
  .max(64)
  .refine(
    (models) => new Set(models.map(({ id }) => id)).size === models.length,
    "Custom model IDs must be unique.",
  );
