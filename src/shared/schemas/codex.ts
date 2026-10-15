import modeKindJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ModeKind.schema.json";
import threadActiveFlagJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ThreadActiveFlag.schema.json";
import threadGoalJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ThreadGoal.schema.json";
import threadGoalStatusJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ThreadGoalStatus.schema.json";
import threadStatusJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ThreadStatus.schema.json";
import threadTokenUsageJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ThreadTokenUsage.schema.json";
import tokenUsageBreakdownJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/TokenUsageBreakdown.schema.json";
import { z } from "zod";
import type { ThreadGoal, ThreadGoalStatus } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCollaborationModeKind,
  CodexReasoningEffort,
  CodexThreadTokenUsage,
  CodexThreadActiveFlag,
  CodexThreadDetailLevel,
  CodexThreadSettings,
  CodexThreadRuntimeStatus,
  CodexThreadStatusType,
  CodexTokenUsageBreakdown,
} from "../types";
import {
  createGeneratedCodexSchema,
  createGeneratedCodexStringDiscriminatorSchema,
} from "../generated-codex-schema";

export const CodexUnknownRecordSchema = z.record(z.string(), z.unknown());

const CODEX_REASONING_EFFORT_MAX_LENGTH = 64;
const CODEX_REASONING_EFFORT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/** Runtime-advertised opaque value. Preserve spelling and case (for example, Kimi `Thinking`). */
export const CodexReasoningEffortSchema: z.ZodType<CodexReasoningEffort> = z
  .string()
  .trim()
  .min(1)
  .max(CODEX_REASONING_EFFORT_MAX_LENGTH)
  .refine((value) => !CODEX_REASONING_EFFORT_CONTROL_CHARACTER_PATTERN.test(value));

export const CodexThreadDetailLevelSchema = z.enum([
  "STEPS_PROSE",
  "STEPS_COMMANDS",
  "STEPS_EXECUTION",
]) satisfies z.ZodType<CodexThreadDetailLevel>;

export const CodexCollaborationModeKindSchema =
  createGeneratedCodexSchema<CodexCollaborationModeKind>(modeKindJsonSchema);

export const CodexThreadStatusTypeSchema =
  createGeneratedCodexStringDiscriminatorSchema<CodexThreadStatusType>(
    threadStatusJsonSchema,
    "type",
  );

export const CodexThreadStatusSchema =
  createGeneratedCodexSchema<CodexThreadRuntimeStatus>(threadStatusJsonSchema);

export const CodexThreadActiveFlagSchema = createGeneratedCodexSchema<CodexThreadActiveFlag>(
  threadActiveFlagJsonSchema,
);

export const CodexThreadGoalSchema = createGeneratedCodexSchema<ThreadGoal>(threadGoalJsonSchema);

export const CodexThreadGoalStatusSchema = createGeneratedCodexSchema<ThreadGoalStatus>(
  threadGoalStatusJsonSchema,
);

export const CodexTokenUsageBreakdownSchema = createGeneratedCodexSchema<CodexTokenUsageBreakdown>(
  tokenUsageBreakdownJsonSchema,
);

export const CodexThreadTokenUsageSchema = createGeneratedCodexSchema<CodexThreadTokenUsage>(
  threadTokenUsageJsonSchema,
);

export function parseCodexThreadTokenUsage(value: unknown): CodexThreadTokenUsage | undefined {
  const parsed = CodexThreadTokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const NonEmptyTrimmedStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

export const CodexThreadSettingsSchema = z.record(z.string(), z.unknown()).transform((value) => {
  const next: CodexThreadSettings = {};

  const model = NonEmptyTrimmedStringSchema.safeParse(value.model);
  if (model.success) {
    next.model = model.data;
  }

  const reasoningEffort = CodexReasoningEffortSchema.safeParse(value.reasoningEffort);
  if (reasoningEffort.success) {
    next.reasoningEffort = reasoningEffort.data;
  }

  const detailLevel = CodexThreadDetailLevelSchema.safeParse(value.detailLevel);
  if (detailLevel.success) {
    next.detailLevel = detailLevel.data;
  }

  return next;
}) satisfies z.ZodType<CodexThreadSettings>;

const CollaborationModeMapSchema = z.record(z.string(), z.unknown()).transform((value) =>
  Object.entries(value).reduce<Record<string, CodexCollaborationModeKind>>(
    (acc, [contextKey, mode]) => {
      const parsedMode = CodexCollaborationModeKindSchema.safeParse(mode);
      if (!parsedMode.success) return acc;
      acc[contextKey] = parsedMode.data;
      return acc;
    },
    {},
  ),
);

export const CodexCollaborationModesByContextSchema = z
  .record(z.string(), z.unknown())
  .transform((value) => {
    const rawModes =
      typeof value.modes === "object" && value.modes !== null && !Array.isArray(value.modes)
        ? (value.modes as Record<string, unknown>)
        : value;
    return CollaborationModeMapSchema.parse(rawModes);
  });
