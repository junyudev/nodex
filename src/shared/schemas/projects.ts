import { z } from "zod";
import type {
  ProjectCreateInput,
  ProjectLifecycleInput,
  ProjectUpdateCommandInput,
  ProjectUpdateInput,
} from "../types";
import { PROJECT_MARKER_COLORS, PROJECT_MARKER_ICONS } from "../project-appearance";
import { isBoundedOperationId } from "../operation-identity";

export const ProjectAppearanceSchema = z.object({
  color: z.enum(PROJECT_MARKER_COLORS),
  marker: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("icon"),
      icon: z.enum(PROJECT_MARKER_ICONS),
    }),
    z.object({
      kind: z.literal("emoji"),
      emoji: z.string().min(1).max(256),
    }),
  ]),
});

export const PageKeyPrefixSchema = z.string().min(1).max(8);

export const ProjectLifecycleInputSchema = z.object({
  lifecycle: z.enum(["active", "archived"]),
}) satisfies z.ZodType<ProjectLifecycleInput>;

export const ProjectUpdateInputSchema = z
  .object({
    expectedBindingRevision: z.number().int().positive().safe().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    appearance: ProjectAppearanceSchema.optional(),
    sources: z.array(z.string()).optional(),
  })
  .strict() satisfies z.ZodType<ProjectUpdateInput>;

export const ProjectUpdateCommandInputSchema = z
  .object({
    operationId: z.string().refine(isBoundedOperationId, "Invalid bounded operation identity"),
    projectId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value === value.trim(), "Project identity must be canonical"),
    updates: ProjectUpdateInputSchema.extend({
      expectedBindingRevision: z.number().int().positive().safe(),
    }),
  })
  .strict() satisfies z.ZodType<ProjectUpdateCommandInput>;

export const ProjectCreateInputSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    appearance: ProjectAppearanceSchema.optional(),
    sources: z.array(z.string()).optional(),
    pageKeyPrefix: PageKeyPrefixSchema.optional(),
  })
  .strict() satisfies z.ZodType<ProjectCreateInput>;
