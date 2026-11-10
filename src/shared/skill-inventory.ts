import { z } from "zod";

export const SkillInventoryContextSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
});
export type SkillInventoryContext = z.infer<typeof SkillInventoryContextSchema>;

export type SkillLocationId = string;
export type SkillId = string;
export type SkillRevision = string;
export type SkillScope = "user" | "project" | "plugin" | "system";

export const SkillReaderSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  instanceId: z.string().min(1),
});
export type SkillReader = z.infer<typeof SkillReaderSchema>;
export type SkillToggle =
  | { readonly status: "available"; readonly scope: "user" | "project" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface SkillAgentAvailability extends SkillReader {
  readonly invocationName: string;
  readonly state: "enabled" | "disabled" | "unknown";
  readonly discovery: "available" | "shadowed" | "unverified";
  readonly toggle: SkillToggle;
}

export interface SkillInventoryEntry {
  readonly id: SkillId;
  readonly directory: string;
  readonly manifestPath: string;
  readonly name: string;
  readonly description: string;
  readonly writable: boolean;
  readonly agents: readonly SkillAgentAvailability[];
  readonly parseError: string | null;
}

export interface SkillLocation {
  readonly id: SkillLocationId;
  readonly directory: string;
  readonly scope: SkillScope;
  readonly readers: readonly SkillReader[];
  readonly writable: boolean;
  readonly exists: boolean;
  readonly skills: readonly SkillInventoryEntry[];
}

export interface SkillInventorySnapshot {
  readonly generation: string;
  readonly locations: readonly SkillLocation[];
  readonly sources: readonly (SkillReader & { readonly error: string | null })[];
}

export interface SkillDocument {
  readonly skillId: SkillId;
  readonly markdown: string;
  readonly files: readonly string[];
  readonly revision: SkillRevision;
  readonly writable: boolean;
}

export type SkillFailure = {
  readonly status: "failed";
  readonly code: "invalid_input" | "unavailable" | "unsafe" | "read_only" | "collision" | "io";
  readonly message: string;
};
export type SkillResult<T> = { readonly status: "ok"; readonly value: T } | SkillFailure;
export type SkillConflict = { readonly status: "conflict"; readonly document: SkillDocument };
export type SkillSaveResult = SkillResult<SkillDocument> | SkillConflict;
export type SkillTransferResult = SkillResult<{
  readonly skillId: SkillId;
  readonly sourceRetained: boolean;
  readonly warning?: string;
}>;

export interface SkillsChangedEvent {
  readonly subscriptionId: string;
}

export const MAX_SKILL_MANIFEST_BYTES = 1024 * 1024;
export const SkillSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
  .refine((slug) => !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u.test(slug));

const id = z.string().min(1).max(256);
const location = SkillInventoryContextSchema.extend({ locationId: id });
const target = SkillInventoryContextSchema.extend({ skillId: id });
const revision = target.extend({ baseRevision: id });

export const skillInput = {
  list: SkillInventoryContextSchema.extend({ forceRefresh: z.boolean().optional() }),
  readDocument: target,
  writeDocument: revision.extend({ markdown: z.string().max(MAX_SKILL_MANIFEST_BYTES) }),
  createBlank: location.extend({ slug: SkillSlugSchema }),
  rename: revision.extend({ slug: SkillSlugSchema }),
  transfer: target.extend({
    locationId: id,
    slug: SkillSlugSchema,
    mode: z.enum(["copy", "move"]),
  }),
  trash: target,
  setEnabled: target.extend({
    reader: SkillReaderSchema,
    scope: z.enum(["user", "project"]),
    enabled: z.boolean(),
  }),
  watchStart: SkillInventoryContextSchema.extend({ skillId: id.optional() }),
  watchStop: z.object({ subscriptionId: id }),
};
export type SkillInput<K extends keyof typeof skillInput> = z.input<(typeof skillInput)[K]>;
