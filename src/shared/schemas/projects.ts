import { z } from "zod";
import type {
  Project,
  ProjectCreateInput,
  ProjectLifecycleInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
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

const ProjectSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  databaseId: z.string(),
  defaultDatabaseViewId: z.string().nullable(),
  lifecycle: z.enum(["active", "inactive", "archived"]),
  bindingRevision: z.number(),
  name: z.string(),
  description: z.string(),
  appearance: ProjectAppearanceSchema,
  sources: z.array(z.object({ root: z.string(), order: z.number() })),
  primaryWorkspaceRoot: z.string().nullable(),
  pinned: z.boolean(),
  pinnedOrder: z.number().nullable(),
  created: z.coerce.date(),
  updated: z.coerce.date(),
}) satisfies z.ZodType<Project>;

const ProjectArchiveBlockerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active-turn"),
    threadId: z.string(),
    label: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pending-request"),
    threadId: z.string(),
    label: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("terminal"),
    terminalSessionId: z.string(),
    projectSessionId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("background-process"),
    threadId: z.string(),
    processId: z.string().nullable(),
    label: z.string().nullable(),
  }),
]);

export const ProjectLifecycleMutationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("updated"),
    project: ProjectSchema,
    changed: z.boolean(),
  }),
  z.object({
    kind: z.literal("blocked"),
    project: ProjectSchema,
    blockers: z.array(ProjectArchiveBlockerSchema),
  }),
  z.object({ kind: z.literal("not-found") }),
]) satisfies z.ZodType<ProjectLifecycleMutationResult>;

export function parseProjectLifecycleMutationResult(
  value: unknown,
): ProjectLifecycleMutationResult {
  return ProjectLifecycleMutationResultSchema.parse(value);
}

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

export const ProjectOrderInputSchema = z.object({
  orderedProjectIds: z.array(z.string()),
}) satisfies z.ZodType<ProjectOrderInput>;

export const ProjectPinnedInputSchema = z.object({
  pinned: z.boolean(),
}) satisfies z.ZodType<ProjectPinnedInput>;

export const ProjectPinnedOrderInputSchema = z.object({
  orderedProjectIds: z.array(z.string()),
}) satisfies z.ZodType<ProjectPinnedOrderInput>;
