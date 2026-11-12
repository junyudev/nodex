import { ProjectSessionPlacementSchema } from "./session-order";
import { PROMPT_TURN_READ_LIMIT } from "../prompt-turn";
import { z } from "zod";
import type {
  AgentRuntimeHostLaunchField,
  AgentRuntimeLaunch,
  AgentRuntimeMessage,
  RuntimeMode,
} from "../agent-runtime-api";
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
export const AgentRuntimeThreadIdentitySchema = z.object({ threadId: id }).strict();
export const AgentRuntimePromptTurnsSchema = z
  .object({
    sessionId: id,
    messageIds: z.array(id).min(1).max(PROMPT_TURN_READ_LIMIT),
  })
  .strict();
export const AgentRuntimeControlSchema = AgentRuntimeTargetSchema.extend({
  requestId: id.optional(),
  requireActive: z.boolean().optional(),
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
export const AgentRuntimeModeSchema = z.enum([
  "approval-required",
  "auto",
  "full-access",
]) satisfies z.ZodType<RuntimeMode>;
export const AgentRuntimeInteractionModeSchema = z.enum(["default", "plan"]);
const AgentConfigsSchema = z
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
  .max(100);
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
    agentConfigs: AgentConfigsSchema.optional(),
    skillInvocations: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(200),
          path: z.string().min(1),
          instanceId: id,
          cwd: z.string().min(1),
        }),
      )
      .max(3)
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
    workPage: z.object({ pageId: id, onlyIfAgentWork: z.boolean().optional() }).strict().optional(),
    presentationTicket: CodexTurnPresentationTicketSchema.optional(),
    modelSelection: AgentRuntimeModelSelectionSchema,
    runtimeMode: AgentRuntimeModeSchema.optional(),
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
  .strict() satisfies z.ZodType<RendererAgentRuntimeLaunch>;

/** Every launch field a window or a remote client may author; Main-only fields are excluded. */
type RendererAgentRuntimeLaunch = Omit<AgentRuntimeLaunch, AgentRuntimeHostLaunchField>;
type LaunchFieldMismatch =
  | Exclude<keyof RendererAgentRuntimeLaunch, keyof z.infer<typeof AgentRuntimeLaunchSchema>>
  | Exclude<keyof z.infer<typeof AgentRuntimeLaunchSchema>, keyof RendererAgentRuntimeLaunch>;
// A launch field the schema omits would be rejected by `.strict()` at runtime, and an added one
// would go unvalidated. Either mismatch fails the build here instead.
const launchSchemaMatchesRendererFields: [LaunchFieldMismatch] extends [never] ? true : false =
  true;
void launchSchemaMatchesRendererFields;
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
  submissionId: id.optional(),
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).optional(),
  optionId: z.string().min(1).optional(),
  feedback: z.string().trim().min(1).max(10_000).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  attachmentsByQuestionId: z.record(z.string(), z.unknown()).optional(),
});
export const AgentRuntimeModesSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runtimeMode: AgentRuntimeModeSchema.optional(),
  interactionMode: AgentRuntimeInteractionModeSchema.optional(),
});
export const AgentRuntimeCompactSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  /** Compacting continues this failed reply once the context fits again. */
  failedRunId: id.optional(),
});
export const AgentRuntimeClearContextSchema = AgentRuntimeTargetSchema.extend({ requestId: id });
export const AgentRuntimeRewriteMessageSchema = AgentRuntimeMessageInputSchema.extend({
  requestId: id,
  runId: id,
});
export const AgentRuntimeSessionMoveSchema = z
  .object({
    operationId: id,
    sessionId: id,
    projectId: id.nullable(),
    placement: ProjectSessionPlacementSchema.optional(),
  })
  .strict();
export const AgentRuntimeTaskStopSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
  taskId: id,
});
export const AgentRuntimeBackgroundStopSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id.nullable().optional(),
  taskIds: z
    .array(id)
    .min(1)
    .max(25)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const AgentRuntimeBackgroundOutputSchema = AgentRuntimeTargetSchema.extend({
  taskId: id,
});
export const AgentRuntimeTaskCancelSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  taskId: id,
  runId: id.nullable().optional(),
});
export const AgentRuntimePreparationRetrySchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
  workLocally: z.boolean(),
}).strict();
const queueControls = [
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
    action: z.literal("steer"),
    runId: id,
    targetRunId: id,
  }).strict(),
] as const;
export const AgentRuntimeQueueSchema = z.discriminatedUnion("action", [
  ...queueControls,
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("edit"),
    runId: id,
    message: AgentRuntimeMessageSchema,
    presentationTicket: CodexTurnPresentationTicketSchema.optional(),
  }).strict(),
]);

/** The context records a message carries beside its words; the Runtime checks each record. */
const HostedChatContextSchema = z
  .object({
    version: z.literal(1),
    records: z.array(
      z
        .object({ kind: z.string().max(64), label: z.string().max(200), payload: z.unknown() })
        .strict(),
    ),
  })
  .strict() satisfies z.ZodType<AgentRuntimeMessage["context"]>;
/** The most files one message to a chat on a Space's host carries, from any Device. */
export const HOSTED_CHAT_MAX_FILES = 12;
/**
 * What a Member's Device sends to a chat that runs on its Space host: words, the context they
 * reference and the choices that shape the Run, as a local Composer sends them. Images and files
 * travel as Library Files the Member uploaded, which the host reads with the Member's authority;
 * no Device path, byte or window that presents the turn crosses to the host.
 */
export const HostedChatMessageSchema = z
  .object({
    messageId: id,
    text: z.string().max(120_000),
    fileRefs: z.array(z.string().min(1).max(512)).max(HOSTED_CHAT_MAX_FILES).optional(),
    context: HostedChatContextSchema.optional(),
    agentConfigs: AgentConfigsSchema.optional(),
    modelSelection: AgentRuntimeModelSelectionSchema.optional(),
    interactionMode: AgentRuntimeInteractionModeSchema.optional(),
  })
  .strict();
/**
 * A new chat a Member starts on the Space host, with or without a Project, from a desktop or a
 * phone. It runs in the host's tasks directory, or where the host runs the Project, in its
 * checkout or a new worktree the host prepares; the starter owns it.
 */
export const HostedChatStartSchema = z
  .object({
    sessionId: id,
    launchId: id,
    acceptedAt: z.number().int().nonnegative(),
    projectId: id.nullable(),
    title: z.string().trim().min(1).max(2_000),
    initialPageIds: z.array(id).max(16).optional(),
    modelSelection: AgentRuntimeModelSelectionSchema,
    interactionMode: AgentRuntimeInteractionModeSchema,
    runInTarget: z.enum(["localProject", "newWorktree"]).optional(),
    message: HostedChatMessageSchema,
  })
  .strict();
/** While a Run is active a message waits behind it or redirects it; otherwise it starts one. */
export const HostedChatDeliverySchema = z.enum(["send", "queue", "steer"]);
export const HostedChatMessageInputSchema = AgentRuntimeTargetSchema.extend({
  message: HostedChatMessageSchema,
  delivery: HostedChatDeliverySchema,
}).strict();
/** A Member's rewrite of their own message, which Core admits only while no one has replied. */
export const HostedChatRewriteSchema = AgentRuntimeTargetSchema.extend({
  requestId: id,
  runId: id,
  message: HostedChatMessageSchema,
}).strict();
export const HostedChatQueueSchema = z.discriminatedUnion("action", [
  ...queueControls,
  AgentRuntimeTargetSchema.extend({
    requestId: id,
    action: z.literal("edit"),
    runId: id,
    message: HostedChatMessageSchema,
  }).strict(),
]);
export const AgentRuntimeSideChatCreateSchema = z
  .object({
    source: AgentRuntimeTargetSchema,
    sessionId: id,
    requestId: id,
    acceptedAt: z.number().int().nonnegative(),
  })
  .strict();
export const AgentRuntimeSideChatDeleteSchema = z.object({ sessionId: id, requestId: id }).strict();
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
/** A fork a Member asks a chat's Space host for; the host's own workspace setup applies. */
export const HostedChatForkSchema = AgentRuntimeForkSchema.omit({ runInEnvironmentPath: true });
export const AgentRuntimeHistorySchema = AgentRuntimeTargetSchema.extend({
  cursor: z.union([
    id,
    z
      .object({
        type: z.literal("item"),
        sourceThreadId: id,
        sourceItemId: id,
        ordinal: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ]),
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
/** The most bytes of a hosted chat's attachment that one read returns, before base64. */
export const HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
/**
 * One range of a hosted chat's attachment, named by the identities its transcript carries. Every
 * range after the first names the first one's version, so a read never splices two versions.
 */
export const HostedChatAttachmentReadSchema = AgentRuntimeAttachmentSchema.extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(1).max(HOSTED_CHAT_ATTACHMENT_CHUNK_BYTES),
  version: z.string().min(1).max(128).optional(),
}).strict();
export type HostedChatAttachmentChunk = {
  readonly base64: string;
  readonly totalBytes: number;
  /** A picture's type comes from its own bytes; nothing else is ever an `image/` type here. */
  readonly mimeType: string | null;
  readonly name: string | null;
  readonly version: string;
};
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
export const AgentRuntimeRestartSchema = z.object({ generation: id }).strict();
export const AgentRuntimeComposerSkillsSchema = z
  .object({ instanceId: z.string().min(1), cwd: z.string().min(1).nullable() })
  .strict();

export const AgentRuntimeCatalogSchema = z
  .object({
    refresh: z.boolean().optional(),
    instanceIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  })
  .strict();
export const AgentWindowsSandboxReadSchema = z
  .object({
    instanceId: id,
    refresh: z.boolean().optional(),
  })
  .strict();
export const AgentWindowsSandboxSetupSchema = z
  .object({
    instanceId: id,
    mode: z.enum(["elevated", "unelevated"]),
  })
  .strict();
export const AgentWindowsSandboxCancelSchema = z
  .object({
    instanceId: id,
    generation: z.string().min(1).max(128),
  })
  .strict();
export const ClaudeUsageLogoutSchema = z
  .object({ instanceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(32) })
  .strict();
