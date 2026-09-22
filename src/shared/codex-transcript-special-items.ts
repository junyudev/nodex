import collabAgentStateJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/CollabAgentState.schema.json";
import collabAgentToolJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/CollabAgentTool.schema.json";
import collabAgentToolCallStatusJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/CollabAgentToolCallStatus.schema.json";
import guardianApprovalReviewJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/GuardianApprovalReview.schema.json";
import type {
  CollabAgentState,
  CollabAgentStatus,
  CollabAgentTool,
  CollabAgentToolCallStatus,
  GuardianApprovalReview,
  GuardianWarningNotification,
  ThreadItem,
} from "@nodex/codex-app-server-protocol/v2";
import { z } from "zod";
import { extractCodexThreadSubagentMetadata } from "./codex-subagent-metadata";
import { createGeneratedCodexSchema } from "./generated-codex-schema";
import { CodexUnknownRecordSchema } from "./schemas/codex";

const NullableStringSchema = z
  .string()
  .nullable()
  .optional()
  .catch(null)
  .transform((value) => value ?? null);
const NullableFiniteNumberSchema = z
  .number()
  .finite()
  .nullable()
  .optional()
  .catch(null)
  .transform((value) => value ?? null);

export const AUTO_REVIEW_INTERRUPTION_WARNING_PREFIX =
  "Automatic approval review rejected too many approval requests for this turn";

const CodexAutomaticApprovalReviewSchema = createGeneratedCodexSchema<GuardianApprovalReview>(
  guardianApprovalReviewJsonSchema,
);
const CodexMultiAgentActionNameSchema =
  createGeneratedCodexSchema<CollabAgentTool>(collabAgentToolJsonSchema);
const CodexMultiAgentActionStatusSchema = createGeneratedCodexSchema<CollabAgentToolCallStatus>(
  collabAgentToolCallStatusJsonSchema,
);
const CodexMultiAgentAgentStateSchema = createGeneratedCodexSchema<CollabAgentState>(
  collabAgentStateJsonSchema,
);

export type CodexAutomaticApprovalReviewStatus = GuardianApprovalReview["status"];
export type CodexAutomaticApprovalReviewRiskLevel = NonNullable<
  GuardianApprovalReview["riskLevel"]
>;

export type CodexAutomaticApprovalReviewPayload = GuardianApprovalReview & {
  targetItemId: string | null;
  riskScore: number | null;
  action: unknown;
};

export type CodexMultiAgentActionName = CollabAgentTool;
export type CodexMultiAgentActionStatus = CollabAgentToolCallStatus;
export type CodexMultiAgentAgentStatus = CollabAgentStatus;

export interface CodexMultiAgentReceiverThread {
  threadId: string;
  thread: {
    nickname: string | null;
    displayName?: string | null;
    name?: string | null;
    model: string | null;
    agentRole: string | null;
  } | null;
}

export type CodexMultiAgentAgentState = CollabAgentState;

type CodexProtocolMultiAgentAction = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

export interface CodexMultiAgentActionPayload {
  id: CodexProtocolMultiAgentAction["id"] | null;
  action: CodexProtocolMultiAgentAction["tool"];
  status: CodexProtocolMultiAgentAction["status"];
  senderThreadId: CodexProtocolMultiAgentAction["senderThreadId"] | null;
  receiverThreadIds: CodexProtocolMultiAgentAction["receiverThreadIds"];
  receiverThreads: CodexMultiAgentReceiverThread[];
  prompt: CodexProtocolMultiAgentAction["prompt"];
  model: CodexProtocolMultiAgentAction["model"];
  reasoningEffort: CodexProtocolMultiAgentAction["reasoningEffort"];
  agentsStates: Record<string, CodexMultiAgentAgentState>;
}

const CodexAutomaticApprovalReviewRecordSchema = CodexUnknownRecordSchema.transform(
  (value, ctx) => {
    const review = CodexAutomaticApprovalReviewSchema.safeParse({
      status: value.status,
      riskLevel: value.riskLevel ?? null,
      userAuthorization: value.userAuthorization ?? null,
      rationale: value.rationale ?? null,
    });
    if (!review.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid automatic approval review",
      });
      return z.NEVER;
    }

    return {
      ...review.data,
      riskScore: NullableFiniteNumberSchema.parse(value.riskScore),
    };
  },
);

const CodexReceiverThreadSchema = CodexUnknownRecordSchema.transform((value, ctx) => {
  const threadId = z.string().safeParse(value.threadId);
  if (!threadId.success || threadId.data.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid receiver thread id",
    });
    return z.NEVER;
  }

  const thread = CodexUnknownRecordSchema.safeParse(value.thread);
  const subagentMetadata = thread.success ? extractCodexThreadSubagentMetadata(thread.data) : null;
  const displayName = thread.success ? NullableStringSchema.parse(thread.data.displayName) : null;
  const name = thread.success ? NullableStringSchema.parse(thread.data.name) : null;
  const nickname = thread.success
    ? (NullableStringSchema.parse(thread.data.nickname) ??
      NullableStringSchema.parse(thread.data.agentNickname) ??
      subagentMetadata?.agentNickname ??
      null)
    : null;
  const agentRole = thread.success
    ? (NullableStringSchema.parse(thread.data.agentRole) ?? subagentMetadata?.agentRole ?? null)
    : null;

  return {
    threadId: threadId.data,
    thread: thread.success
      ? {
          nickname,
          ...(displayName ? { displayName } : {}),
          ...(name ? { name } : {}),
          model: NullableStringSchema.parse(thread.data.model),
          agentRole,
        }
      : null,
  } satisfies CodexMultiAgentReceiverThread;
});

const CodexReceiverThreadsSchema = z.array(z.unknown()).transform((value) =>
  value.reduce<CodexMultiAgentReceiverThread[]>((acc, entry) => {
    const parsed = CodexReceiverThreadSchema.safeParse(entry);
    if (!parsed.success) return acc;
    acc.push(parsed.data);
    return acc;
  }, []),
);

const CodexAgentsStatesSchema = CodexUnknownRecordSchema.transform((value) =>
  Object.entries(value).reduce<Record<string, CodexMultiAgentAgentState>>(
    (acc, [threadId, rawState]) => {
      const state = CodexMultiAgentAgentStateSchema.safeParse(rawState);
      if (!state.success) return acc;
      acc[threadId] = state.data;
      return acc;
    },
    {},
  ),
);

const CodexMultiAgentActionRecordSchema = CodexUnknownRecordSchema.transform((value, ctx) => {
  const action = CodexMultiAgentActionNameSchema.safeParse(value.tool);
  const status = CodexMultiAgentActionStatusSchema.safeParse(value.status);
  if (!action.success || !status.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid multi-agent action payload",
    });
    return z.NEVER;
  }

  const receiverThreadIds = Array.isArray(value.receiverThreadIds)
    ? value.receiverThreadIds.reduce<string[]>((acc, entry) => {
        const parsed = z.string().safeParse(entry);
        if (!parsed.success) return acc;
        acc.push(parsed.data);
        return acc;
      }, [])
    : [];

  const receiverThreads = CodexReceiverThreadsSchema.safeParse(value.receiverThreads);
  const agentsStates = CodexAgentsStatesSchema.safeParse(value.agentsStates);

  return {
    id: NullableStringSchema.parse(value.id),
    action: action.data,
    status: status.data,
    senderThreadId: NullableStringSchema.parse(value.senderThreadId),
    receiverThreadIds,
    receiverThreads: receiverThreads.success ? receiverThreads.data : [],
    prompt: NullableStringSchema.parse(value.prompt),
    model: NullableStringSchema.parse(value.model),
    reasoningEffort: NullableStringSchema.parse(value.reasoningEffort),
    agentsStates: agentsStates.success ? agentsStates.data : {},
  } satisfies CodexMultiAgentActionPayload;
});

export function normalizeAutomaticApprovalReviewPayload(
  rawItem: unknown,
  fallbackTargetItemId?: string | null,
): CodexAutomaticApprovalReviewPayload | null {
  const candidate = CodexUnknownRecordSchema.safeParse(rawItem);
  if (!candidate.success) return null;

  const reviewRecord = CodexAutomaticApprovalReviewRecordSchema.safeParse(candidate.data.review);
  let normalizedReview: z.infer<typeof CodexAutomaticApprovalReviewRecordSchema> | null = null;
  if (reviewRecord.success) {
    normalizedReview = reviewRecord.data;
  } else {
    const parsedFallback = CodexAutomaticApprovalReviewRecordSchema.safeParse(candidate.data);
    normalizedReview = parsedFallback.success ? parsedFallback.data : null;
  }
  if (!normalizedReview) return null;

  return {
    targetItemId:
      NullableStringSchema.parse(candidate.data.targetItemId) ?? fallbackTargetItemId ?? null,
    ...normalizedReview,
    action: Object.prototype.hasOwnProperty.call(candidate.data, "action")
      ? candidate.data.action
      : null,
  };
}

export function buildAutomaticApprovalReviewSummary(
  review: Pick<CodexAutomaticApprovalReviewPayload, "status" | "rationale">,
): string {
  const trimmedRationale = review.rationale?.trim() ?? "";
  if (trimmedRationale.length > 0) return trimmedRationale;
  if (review.status === "inProgress") {
    return "A carefully prompted reviewer agent is reviewing this request before Nodex runs it";
  }
  if (review.status === "aborted") {
    return "A carefully prompted reviewer agent stopped reviewing this request before Nodex ran it";
  }
  if (review.status === "timedOut") {
    return "A carefully prompted reviewer agent timed out before Nodex ran this request";
  }
  return "A carefully prompted reviewer agent reviewed this request.";
}

export function buildAutomaticApprovalReviewTitle(
  review: Pick<CodexAutomaticApprovalReviewPayload, "status" | "riskLevel">,
): string {
  if (review.status === "inProgress") return "Auto-reviewing";
  if (review.status === "approved") return "Auto-review approved";
  if (review.status === "denied" && review.riskLevel === "high")
    return "Auto-review denied high risk";
  if (review.status === "denied") return "Auto-review denied";
  if (review.status === "timedOut") return "Auto-review timed out";
  return "Auto-review stopped";
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<string[]>((acc, entry) => {
    const parsed = readNonEmptyString(entry);
    if (parsed) acc.push(parsed);
    return acc;
  }, []);
}

function pluralizeFileCount(count: number): string {
  return count === 1 ? "a file" : `${count} files`;
}

export function buildAutomaticApprovalReviewActionSummary(action: unknown): string {
  const candidate = CodexUnknownRecordSchema.safeParse(action);
  if (!candidate.success) return "Request";

  const type = readNonEmptyString(candidate.data.type);
  if (type === "command") {
    return readNonEmptyString(candidate.data.command) ?? "Request";
  }

  if (type === "execve") {
    const program = readNonEmptyString(candidate.data.program);
    if (!program) return "Request";
    return [program, ...readStringArray(candidate.data.argv)].join(" ");
  }

  if (type === "applyPatch") {
    const files = readStringArray(candidate.data.files);
    if (files.length === 1) return `Editing ${files[0]}`;
    return `Editing ${pluralizeFileCount(files.length)}`;
  }

  if (type === "networkAccess") {
    const target = readNonEmptyString(candidate.data.target);
    return target ? `Network access to ${target}` : "Network access";
  }

  if (type === "mcpToolCall") {
    const toolName =
      readNonEmptyString(candidate.data.toolName) ??
      readNonEmptyString(candidate.data.toolTitle) ??
      "tool";
    const serverName =
      readNonEmptyString(candidate.data.connectorName) ?? readNonEmptyString(candidate.data.server);
    return serverName ? `MCP ${toolName} on ${serverName}` : `MCP ${toolName}`;
  }

  if (type === "requestPermissions") {
    const reason = readNonEmptyString(candidate.data.reason);
    return reason ? `Permission request: ${reason}` : "Permission request";
  }

  return "Request";
}

export function shouldShowAutoReviewInterruptionWarning(
  notification: GuardianWarningNotification,
): boolean {
  return notification.message.startsWith(AUTO_REVIEW_INTERRUPTION_WARNING_PREFIX);
}

export function normalizeMultiAgentActionPayload(
  rawItem: unknown,
): CodexMultiAgentActionPayload | null {
  const parsed = CodexMultiAgentActionRecordSchema.safeParse(rawItem);
  return parsed.success ? parsed.data : null;
}
