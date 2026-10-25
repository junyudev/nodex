import { z } from "zod";
import type { AgentRuntimeLaunch, AgentRuntimeMessage } from "../agent-runtime-api";
import { AGENT_RUNTIME_CONTROL_EVENT_TYPES } from "../agent-runtime-api";
import { CodexTurnPresentationTicketSchema } from "../nodex-app-tools/turn-presentation";

const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
export const AgentRuntimeTargetSchema = z
  .object({ sessionId: id, threadId: id.optional() })
  .strict();
export const AgentRuntimeControlSchema = AgentRuntimeTargetSchema.extend({
  runId: id.optional(),
}).strict();
export const AgentRuntimeOverviewSchema = AgentRuntimeTargetSchema.extend({
  activeCursor: z.string().min(1).max(2048).optional(),
  terminalCursor: z.string().min(1).max(2048).optional(),
}).strict();
export const AgentRuntimeModelSelectionSchema = z
  .object({
    instanceId: id,
    model: z.string().trim().min(1).max(512),
    options: z
      .array(z.object({ id, value: z.union([z.string().min(1), z.boolean()]) }).strict())
      .max(64)
      .optional(),
  })
  .strict();
export const AgentRuntimeInteractionModeSchema = z.enum(["default", "plan"]);
// Native attachment/context codecs stay authoritative in the execution process.
export const AgentRuntimeMessageSchema = z
  .object({
    messageId: id,
    text: z.string().max(120_000),
    attachments: z.array(z.unknown()).max(100).optional(),
    images: z
      .array(
        z
          .object({
            source: z.string().min(1).max(7_400_000),
            caption: z.string().max(2_000).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    modelSelection: AgentRuntimeModelSelectionSchema.optional(),
    interactionMode: AgentRuntimeInteractionModeSchema.optional(),
    agentConfigs: z
      .array(
        z
          .object({
            mode: z.string().max(512).optional(),
            provider: z.string().max(512).optional(),
            model: z.string().max(512).optional(),
            reasoning: z.string().max(512).optional(),
            speed: z.string().max(512).optional(),
            unknownAttributes: z.array(z.string().max(512)).max(32).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict() as z.ZodType<AgentRuntimeMessage>;
export const AgentRuntimeLaunchSchema = z
  .object({
    launchId: id,
    acceptedAt: z.number().int().nonnegative(),
    sessionId: id,
    projectId: id.nullable(),
    title: z.string().trim().min(1).max(2_000),
    initialPageIds: z.array(id).max(16).optional(),
    presentationTicket: CodexTurnPresentationTicketSchema.optional(),
    modelSelection: AgentRuntimeModelSelectionSchema,
    interactionMode: AgentRuntimeInteractionModeSchema,
    runInTarget: z.enum(["localProject", "newWorktree"]).optional(),
    sourceRoot: z.string().trim().min(1).max(32768).optional(),
    runInEnvironmentPath: id.nullable().optional(),
    worktreeStartingState: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("working-tree") }).strict(),
        z
          .object({
            type: z.literal("branch"),
            branchName: id,
            remoteRef: id.optional(),
            onMissing: z.enum(["error", "create-branch"]).optional(),
          })
          .strict(),
      ])
      .optional(),
    branch: id.nullable().optional(),
    worktreePath: id.nullable().optional(),
    message: AgentRuntimeMessageSchema,
  })
  .strict() satisfies z.ZodType<AgentRuntimeLaunch>;
export const AgentRuntimeMessageInputSchema = AgentRuntimeTargetSchema.extend({
  message: AgentRuntimeMessageSchema,
  intent: z.enum(["auto", "steer", "restart"]).optional(),
  presentationTicket: CodexTurnPresentationTicketSchema.optional(),
});
export const AgentRuntimeStopSchema = AgentRuntimeTargetSchema.extend({ runId: id });
export const AgentRuntimeMergeBackSchema = AgentRuntimeTargetSchema.extend({ requestId: id });
export const AgentRuntimeResponseSchema = AgentRuntimeTargetSchema.extend({
  runId: id.nullable(),
  requestId: id,
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  attachmentsByQuestionId: z.record(z.string(), z.unknown()).optional(),
});
export const AgentRuntimeModesSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  interactionMode: AgentRuntimeInteractionModeSchema.optional(),
});
export const AgentRuntimeCompactSchema = AgentRuntimeTargetSchema.extend({ requestId: id });
export const AgentRuntimeRollbackSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
});
export const AgentRuntimeSessionMoveSchema = z
  .object({ operationId: id, sessionId: id, projectId: id.nullable() })
  .strict();
export const AgentRuntimeTaskStopSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
  taskId: id,
});
export const AgentRuntimePreparationRetrySchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
  workLocally: z.boolean(),
}).strict();
export const AgentRuntimeQueueSchema = z.discriminatedUnion("action", [
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("resume"),
    runId: id.optional(),
  }).strict(),
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("cancel"),
    runId: id,
  }).strict(),
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("reorder"),
    beforeRunId: id.nullable().optional(),
    orderedRunIds: z
      .array(id)
      .min(1)
      .max(128)
      .refine((ids) => new Set(ids).size === ids.length),
  }).strict(),
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("edit"),
    runId: id,
    message: AgentRuntimeMessageSchema,
    presentationTicket: CodexTurnPresentationTicketSchema.optional(),
  }).strict(),
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("steer"),
    runId: id,
    targetRunId: id,
  }).strict(),
]);
export const AgentRuntimeForkSchema = z
  .object({
    source: AgentRuntimeTargetSchema,
    sessionId: id,
    requestId: id,
    acceptedAt: z.number().int().nonnegative(),
    environment: z.enum(["same-directory", "worktree"]),
    sourceRunId: id.optional(),
    runInEnvironmentPath: id.nullable().optional(),
  })
  .strict();
export const AgentRuntimeHistorySchema = AgentRuntimeTargetSchema.extend({
  cursor: id,
  throughEntryId: id.optional(),
  conversationOnly: z.boolean().optional(),
});
export const AgentRuntimeQueueReadSchema = AgentRuntimeTargetSchema.extend({
  cursor: id.optional(),
});
export const AgentRuntimeRunSchema = AgentRuntimeTargetSchema.extend({ runId: id });
export const AgentRuntimeItemSchema = AgentRuntimeTargetSchema.extend({
  itemId: id,
  sourceThreadId: id.optional(),
  full: z.literal(true).optional(),
});
export const AgentRuntimeAttachmentSchema = AgentRuntimeTargetSchema.extend({
  itemId: id,
  attachmentId: id,
  sourceThreadId: id.optional(),
}).strict();
export const AgentRuntimeObserveSchema = AgentRuntimeTargetSchema.extend({
  subscriptionId: id,
  afterSequence: z.number().int().nonnegative().optional(),
  eventTypes: z
    .array(z.enum(AGENT_RUNTIME_CONTROL_EVENT_TYPES))
    .min(1)
    .max(AGENT_RUNTIME_CONTROL_EVENT_TYPES.length)
    .optional(),
});
export const AgentRuntimeUnobserveSchema = z.object({ subscriptionId: id }).strict();
export const AgentRuntimeCatalogSchema = z
  .object({
    refresh: z.boolean().optional(),
    instanceIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  })
  .strict();
export const ClaudeUsageLogoutSchema = z
  .object({ instanceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(32) })
  .strict();
