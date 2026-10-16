import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { CommandAction, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalHookRun } from "../../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexCanonicalItem,
  CodexConversationServerRequest,
  CodexDelegatedTaskStatus,
  CodexItemStatus,
  CodexConversationTurn,
  CodexRuntimeNotice,
  CodexUserMessageInputIntent,
  CodexUserMessageOrigin,
} from "../../../shared/types";
import { projectCodexCanonicalTurnViews } from "../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../shared/codex-transcript-entry-projection";
import { buildAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import type { CodexTranscriptTurnDetails } from "../../../shared/codex-transcript-projection";

export type AgentRuntimeThread = AgentSnapshot["projection"]["thread"];
export type AgentRuntimeRun = AgentSnapshot["projection"]["runs"][number];
export type AgentRuntimeProjectedItem = AgentSnapshot["projection"]["visibleTurnItems"][number];
type JsonValue = Extract<CodexCanonicalItem, { type: "dynamicToolCall" }>["arguments"];
const emptyCommandActions: CommandAction[] = [];
const emptyTextElements: Extract<UserInput, { type: "text" }>["text_elements"] = [];

export function agentRuntimeTime(value: string | null | undefined): number | null {
  if (value == null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function agentRuntimeItemStatus(status: AgentTurnItem["status"]): CodexItemStatus {
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "interrupted";
  if (status === "completed" || status === "idle") return "completed";
  return "inProgress";
}

export function agentRuntimeTurnStatus(
  status: AgentRuntimeRun["status"] | undefined,
): CodexTranscriptTurnDetails["status"] {
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted" || status === "rolled_back")
    return "interrupted";
  if (status === undefined || status === "completed") return "completed";
  return "inProgress";
}

/** Explicit export uses the same item projection without installing another transcript owner. */
export function projectAgentRuntimeExportTurns(
  thread: AgentRuntimeThread,
  rows: readonly AgentRuntimeProjectedItem[],
  runs: readonly AgentRuntimeRun[],
): CodexConversationTurn[] {
  const groups = new Map<string, AgentRuntimeProjectedItem[]>();
  let runlessKey = "";
  for (const row of rows) {
    const item = row.item;
    if (isAgentRuntimeItemHidden(item)) continue;
    if (item.runId === null && (item.type === "user_message" || !runlessKey))
      runlessKey = JSON.stringify([row.sourceThreadId, "native-history", item.id]);
    const key = item.runId === null ? runlessKey : JSON.stringify([row.sourceThreadId, item.runId]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([entityKey, group]) => {
    const first = group[0]!;
    const openingItem = group.find((row) => row.item.type === "user_message")?.item;
    const run = runs.find((entry) => entry.id === first.item.runId);
    const details = projectAgentRuntimeTurnDetails({
      thread,
      entityKey,
      run,
      ...(openingItem?.type === "user_message" ? { openingItem } : {}),
    });
    const canonical = {
      ...details,
      turnId: first.item.runId ?? entityKey,
      items: group.flatMap(
        (row) => projectAgentRuntimeItem(row.item, thread.worktreePath ?? "") ?? [],
      ),
    };
    const items = projectCodexCanonicalTurnViews({
      threadId: first.sourceThreadId,
      turn: canonical,
      turnKey: entityKey,
      observedAtMs: details.turnStartedAtMs ?? 0,
    }).map((view, sequence) => projectCodexItemViewToTranscriptEntry(view, "replay", sequence));
    return {
      threadId: first.sourceThreadId,
      entityKey,
      turnId: canonical.turnId,
      status: details.status,
      clientUserMessageId: details.params.clientUserMessageId,
      items,
      itemIds: items.map((item) => item.itemId),
    };
  });
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
}

const notice = (
  item: AgentTurnItem,
  message: string,
  detail: CodexRuntimeNotice = { kind: "info" },
): CodexCanonicalItem => ({
  type: "runtimeNotice",
  id: item.id,
  message,
  notice: detail,
});

const NODEX_APP_SERVER = /^nodex[-_ ]?app$/iu;
/**
 * Runtime execution plumbing: model listing and task polling explain nothing a delegated
 * task row does not already show, so these calls never reach the transcript.
 */
const HIDDEN_TASK_TOOLS = new Set(["list_agent_models", "task_status", "task_wait"]);
/** Task lifecycle calls are represented by the task's own row unless the call failed. */
const TASK_ROW_TOOLS = new Set(["delegate_task", "task_cancel"]);

/**
 * Providers spell application tools differently (Claude `mcp__server__tool`, Codex
 * `server.tool`); presentation keys on one namespace and the bare tool name.
 */
export function parseAgentRuntimeToolName(toolName: string | null): {
  readonly namespace: string | null;
  readonly tool: string;
} {
  const name = toolName?.trim() || "Tool";
  const qualified = /^mcp__(.+?)__(.+)$/u.exec(name);
  const dot = name.indexOf(".");
  const [namespace, tool] = qualified
    ? [qualified[1]!, qualified[2]!]
    : dot > 0 && dot < name.length - 1
      ? [name.slice(0, dot), name.slice(dot + 1)]
      : [null, name];
  return {
    namespace:
      namespace === null ? null : NODEX_APP_SERVER.test(namespace) ? "nodex_app" : namespace,
    tool,
  };
}

const isLive = (status: AgentTurnItem["status"]) =>
  status === "pending" || status === "running" || status === "waiting";

export type AgentRuntimeQuestionRequest = Extract<AgentTurnItem, { type: "user_input_request" }> & {
  readonly responseMode: "message";
};

/**
 * Optional questions the Agent asks while it keeps working. They are answered from the
 * question panel above the ordinary Composer, never from a blocking request card.
 */
export const isAgentRuntimeAsyncQuestion = (
  item: AgentTurnItem,
): item is AgentRuntimeQuestionRequest =>
  item.type === "user_input_request" && item.responseMode === "message";

/** An asynchronous question reads as the assistant message that asked it. */
export function projectAgentRuntimeAsyncQuestionMessage(
  item: AgentRuntimeQuestionRequest,
): Extract<CodexCanonicalItem, { type: "agentMessage" }> {
  return {
    type: "agentMessage",
    id: item.id,
    text: item.questions.map((question) => question.question).join("\n"),
    phase: null,
    memoryCitation: null,
    delivery: "async",
    questions: item.questions.map((question) => ({
      title: question.question,
      options: question.options.length ? question.options.map((option) => option.label) : null,
    })),
  };
}

/** Execution bookkeeping with no conversation meaning stays out of the transcript. */
export function isAgentRuntimeItemHidden(item: AgentTurnItem): boolean {
  switch (item.type) {
    case "dynamic_tool": {
      const { namespace, tool } = parseAgentRuntimeToolName(item.toolName);
      if (namespace !== "nodex_app") return false;
      return HIDDEN_TASK_TOOLS.has(tool) || (TASK_ROW_TOOLS.has(tool) && item.status !== "failed");
    }
    case "run_interrupt_request":
    case "checkpoint":
    case "approval_request":
    // A Turn's hooks are its metadata, presented with its reply rather than as rows.
    case "hook_run":
      return true;
    case "user_input_request":
      return isLive(item.status) && !isAgentRuntimeAsyncQuestion(item);
    default:
      return false;
  }
}

export function agentRuntimeDelegatedTaskStatus(
  status: AgentTurnItem["status"],
): CodexDelegatedTaskStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped";
    case "cancelled":
      return "cancelled";
    case "idle":
    case "completed":
      return "completed";
  }
}

const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

function userMessageOrigin(
  item: Extract<AgentTurnItem, { type: "user_message" }>,
): CodexUserMessageOrigin | undefined {
  if (item.scheduledTaskId !== undefined) return { kind: "automation" };
  if (item.createdBy === "user") return undefined;
  return item.createdBy === "agent" && item.creationSource !== "server"
    ? { kind: "agent", senderThreadId: item.senderThreadId ?? null }
    : { kind: "nodex" };
}

const INPUT_INTENT = {
  turn_start: undefined,
  queued_turn: "queued",
  steer: "steer",
  promoted_queued_to_steer: "promotedToSteer",
} as const satisfies Record<
  Extract<AgentTurnItem, { type: "user_message" }>["inputIntent"],
  CodexUserMessageInputIntent | undefined
>;

function notificationNotice(
  source: Extract<AgentTurnItem, { type: "notification" }>["source"],
  outcome: Extract<AgentTurnItem, { type: "notification" }>["outcome"],
): CodexRuntimeNotice {
  switch (source.kind) {
    case "delegated_task":
    case "subagent":
      return {
        kind: "report",
        source: "subagent",
        outcome,
        childThreadId: source.childThreadId ?? null,
      };
    case "command":
    case "monitor":
    case "system":
      return { kind: "report", source: source.kind, outcome, childThreadId: null };
    default:
      return { kind: "report", source: "background", outcome, childThreadId: null };
  }
}

/**
 * A presentation conversion only. Provider requests and execution remain engine-owned.
 * Hidden execution bookkeeping projects to null and never occupies a transcript slot.
 */
export function projectAgentRuntimeItem(item: AgentTurnItem, cwd = ""): CodexCanonicalItem | null {
  if (isAgentRuntimeItemHidden(item)) return null;
  const id = item.id;
  const status = agentRuntimeItemStatus(item.status);
  const durationMs =
    item.startedAt && item.completedAt
      ? Math.max(
          0,
          (agentRuntimeTime(item.completedAt) ?? 0) - (agentRuntimeTime(item.startedAt) ?? 0),
        )
      : null;
  switch (item.type) {
    case "user_message": {
      const origin = userMessageOrigin(item);
      const inputIntent = INPUT_INTENT[item.inputIntent];
      return {
        type: "userMessage",
        id,
        clientId: item.messageId,
        ...(origin ? { origin } : {}),
        ...(inputIntent ? { inputIntent } : {}),
        content: [
          { type: "text", text: item.text, text_elements: emptyTextElements },
          ...item.attachments
            .filter((attachment) => attachment.type === "image")
            .map((attachment): UserInput => ({
              type: "image",
              url: buildAgentRuntimeAttachmentSource({
                sourceThreadId: item.threadId,
                itemId: item.id,
                attachmentId: attachment.id,
              }),
            })),
        ],
      };
    }
    case "assistant_message":
      return {
        type: "agentMessage",
        id,
        text: item.text,
        phase: null,
        memoryCitation: item.memoryCitation
          ? {
              entries: item.memoryCitation.entries.map((entry) => ({ ...entry })),
              threadIds: [...item.memoryCitation.threadIds],
            }
          : null,
        delivery: null,
        questions: null,
      };
    case "reasoning":
      return { type: "reasoning", id, summary: [item.text], content: [] };
    case "proposed_plan":
      return { type: "plan", id, text: item.markdown };
    case "command_execution":
      return {
        type: "commandExecution",
        id,
        pluginId: null,
        scriptPath: null,
        command: item.input,
        cwd,
        processId: null,
        source: "agent",
        status: status === "interrupted" ? "declined" : status,
        commandActions: item.commandActions
          ? item.commandActions.map((action) => ({ ...action }))
          : emptyCommandActions,
        aggregatedOutput: item.output ?? null,
        exitCode: item.exitCode ?? null,
        durationMs,
      };
    case "file_change":
      return {
        type: "fileChange",
        id,
        status: status === "interrupted" ? "declined" : status,
        changes: (item.changes?.length
          ? item.changes.map((change) => change.path)
          : [item.fileName]
        ).map((path) => ({
          path,
          kind: { type: "update", move_path: null },
          diff: item.diffStr ?? "",
        })),
      };
    case "web_search":
      return {
        type: "webSearch",
        id,
        query: item.patterns?.join(" ") ?? "",
        action: {
          type: "search",
          query: item.patterns?.[0] ?? null,
          queries: item.patterns ? [...item.patterns] : null,
        },
        results: item.results ? item.results.map(jsonValue) : null,
      };
    case "file_search":
      return notice(item, item.pattern ? `Search files: ${item.pattern}` : "Search files");
    case "dynamic_tool": {
      const { namespace, tool } = parseAgentRuntimeToolName(item.toolName);
      return {
        type: "dynamicToolCall",
        id,
        namespace,
        tool,
        arguments: jsonValue(item.input),
        status: status === "inProgress" || status === "completed" ? status : "failed",
        contentItems:
          item.output === undefined
            ? null
            : [
                {
                  type: "inputText",
                  text: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
                },
              ],
        success: status === "inProgress" ? null : status === "completed",
        durationMs,
      };
    }
    case "subagent":
      return {
        type: "delegatedTask",
        id,
        taskId: item.subagentId,
        ownerRunId: item.runId,
        childThreadId: item.childThreadId,
        title: item.title?.trim() || firstLine(item.prompt) || "Subagent",
        providerInstanceId: item.providerInstanceId,
        status: agentRuntimeDelegatedTaskStatus(item.status),
        prompt: item.prompt,
        summary:
          (isLive(item.status)
            ? (item.progress ?? item.result)
            : (item.result ?? item.progress)
          )?.trim() || null,
      };
    case "thread_created":
      return {
        type: "subAgentActivity",
        model: item.targetModel,
        reasoningEffort: null,
        id,
        kind: "started",
        agentThreadId: item.targetThreadId,
        agentPath: item.targetThreadId,
      };
    case "fork":
      return {
        type: "forkedFromConversation",
        id,
        sourceConversationId: item.source.type === "run" ? item.source.threadId : item.threadId,
        sourceConversationTitle: null,
      };
    case "compaction":
      return {
        type: "contextCompaction",
        id,
        completed: status === "completed",
        source: "automatic",
      };
    case "todo_list":
      return {
        type: "todo-list",
        id,
        explanation: item.explanation ?? null,
        plan: item.steps.map((step) => ({
          step: step.text,
          status: step.status === "running" ? "inProgress" : step.status,
        })),
      };
    case "error":
      return {
        type: "error",
        id,
        message: item.failure.message,
        willRetry: item.retry !== undefined,
        errorInfo: null,
        additionalDetails: null,
      };
    case "notification":
      return notice(item, item.summary, notificationNotice(item.source, item.outcome));
    case "run_interrupt_result":
      return notice(item, "Stopped", { kind: "stopped" });
    case "system_notice":
      return notice(item, item.message);
    case "handoff":
      return notice(
        item,
        item.summary ?? `Continued with ${item.toModel ?? item.toProviderInstanceId}`,
      );
    case "user_input_request":
      return isAgentRuntimeAsyncQuestion(item)
        ? projectAgentRuntimeAsyncQuestionMessage(item)
        : notice(item, item.questions.map((question) => question.question).join("\n"));
    case "secret_request":
      return notice(item, item.reason);
    case "approval_review":
      return {
        type: "automaticApprovalReview",
        id,
        targetItemId: item.targetItemId,
        // Each review reads as the action it judged; the reviewer's own wording stays intact.
        action: { type: "command", source: "shell", command: item.actionSummary, cwd },
        startedAtMs: agentRuntimeTime(item.startedAt) ?? agentRuntimeTime(item.updatedAt) ?? 0,
        completedAtMs: agentRuntimeTime(item.completedAt),
        event: null,
        status: item.decision,
        riskLevel: item.riskLevel,
        userAuthorization: item.userAuthorization,
        rationale: item.rationale,
      };
    case "run_interrupt_request":
    case "checkpoint":
    case "approval_request":
    case "hook_run":
      return null;
  }
}

/** A Turn's hook, in the shape its reply's hook presentation reads. */
export function projectAgentRuntimeHookRun(
  item: Extract<AgentTurnItem, { type: "hook_run" }>,
): CodexCanonicalHookRun {
  const startedAt = agentRuntimeTime(item.startedAt) ?? agentRuntimeTime(item.updatedAt) ?? 0;
  const completedAt = agentRuntimeTime(item.completedAt);
  return {
    id: item.id,
    run: {
      id: item.id,
      eventName: item.eventName as CodexCanonicalHookRun["run"]["eventName"],
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: item.sourcePath ?? "",
      source: item.source as CodexCanonicalHookRun["run"]["source"],
      displayOrder: 0n,
      status: item.hookStatus,
      statusMessage: item.statusMessage,
      startedAt: BigInt(startedAt),
      completedAt: completedAt === null ? null : BigInt(completedAt),
      durationMs: completedAt === null ? null : BigInt(Math.max(0, completedAt - startedAt)),
      entries: item.entries.map((entry) => ({ ...entry })),
    },
  };
}

export function projectAgentRuntimeTurnDetails(input: {
  readonly thread: AgentRuntimeThread;
  readonly entityKey: string;
  readonly run?: AgentRuntimeRun | undefined;
  readonly openingItem?: Extract<AgentTurnItem, { type: "user_message" }> | undefined;
  readonly previous?: CodexTranscriptTurnDetails | undefined;
  readonly hookRuns?: readonly CodexCanonicalHookRun[] | undefined;
}): CodexTranscriptTurnDetails {
  const { thread, run, previous, openingItem } = input;
  const hookRuns = input.hookRuns ?? previous?.hookRuns;
  const startedAt = agentRuntimeTime(
    run?.workStartedAt ?? run?.startedAt ?? run?.requestedAt ?? openingItem?.startedAt,
  );
  const completedAt = agentRuntimeTime(run?.completedAt);
  return {
    entityKey: input.entityKey,
    turnId: run?.id ?? previous?.turnId ?? null,
    rootTurnId: null,
    itemsView: "full",
    status: run ? agentRuntimeTurnStatus(run.status) : (previous?.status ?? "completed"),
    error: previous?.error ?? null,
    durationMs:
      startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
    diff: null,
    turnStartedAtMs: startedAt ?? previous?.turnStartedAtMs ?? null,
    completedAtMs: completedAt,
    finalAssistantStartedAtMs: previous?.finalAssistantStartedAtMs ?? null,
    lifecycleStatusByItemId: previous?.lifecycleStatusByItemId,
    ...(hookRuns?.length ? { hookRuns } : {}),
    params: openingItem
      ? {
          threadId: thread.id,
          input: [
            { type: "text", text: openingItem.text, text_elements: emptyTextElements },
            ...openingItem.attachments
              .filter((attachment) => attachment.type === "image")
              .map((attachment): UserInput => ({
                type: "image",
                url: buildAgentRuntimeAttachmentSource({
                  sourceThreadId: openingItem.threadId,
                  itemId: openingItem.id,
                  attachmentId: attachment.id,
                }),
              })),
          ],
          clientUserMessageId: openingItem.messageId,
          cwd: thread.worktreePath ?? null,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          model: run?.modelSelection.model ?? thread.modelSelection.model,
          effort: null,
          summary: "none",
          personality: null,
          outputSchema: null,
          collaborationMode: null,
          attachments: [],
        }
      : (previous?.params ?? {
          threadId: thread.id,
          input: [],
          cwd: thread.worktreePath ?? null,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          model: run?.modelSelection.model ?? thread.modelSelection.model,
          effort: null,
          summary: "none",
          personality: null,
          outputSchema: null,
          collaborationMode: null,
          attachments: [],
        }),
  };
}

/** Live request views use engine IDs; they do not manufacture raw provider request authority. */
export function projectAgentRuntimeRequest(
  item: AgentTurnItem,
  projectId: string | null,
  turnId: string | null,
): CodexConversationServerRequest | null {
  if (
    item.status === "completed" ||
    item.status === "cancelled" ||
    item.status === "failed" ||
    item.status === "interrupted"
  )
    return null;
  const base = {
    projectId,
    threadId: item.threadId,
    turnId,
    itemId: item.id,
    createdAt: agentRuntimeTime(item.startedAt ?? item.updatedAt) ?? 0,
  };
  if (item.type === "approval_request" && turnId !== null)
    return {
      ...base,
      turnId,
      type: "approval",
      requestId: item.requestId,
      kind: item.requestKind === "file-change" ? "file" : "command",
      reason: item.prompt,
      availableDecisions: item.options?.map((option) => option.decision) ?? null,
    };
  if (item.type !== "user_input_request" || isAgentRuntimeAsyncQuestion(item)) return null;
  return {
    ...base,
    type: "userInput",
    executionOwner: "agent-runtime",
    requestId: item.requestId,
    isBlocking: true,
    questions: item.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect,
      isOther: question.allowCustomAnswer !== false,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}
