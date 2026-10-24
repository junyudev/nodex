import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type {
  CommandAction,
  DynamicToolCallOutputContentItem,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalHookRun } from "../../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexCanonicalItem,
  CodexConversationServerRequest,
  CodexDelegatedTaskStatus,
  CodexImportedMarkdownImage,
  CodexItemStatus,
  CodexConversationTurn,
  CodexRuntimeNotice,
  CodexUnavailableImage,
  CodexUserMessageInputIntent,
  CodexUserMessageOrigin,
} from "../../../shared/types";
import { projectCodexCanonicalTurnViews } from "../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../shared/codex-transcript-entry-projection";
import {
  buildAgentRuntimeAttachmentSource,
  buildAgentRuntimeToolResultImageSource,
} from "../../../shared/agent-runtime-attachments";
import { projectAgentRuntimeSubagentDisplay } from "../../../shared/agent-runtime-subagent-display";
import { agentMessageDisplayText } from "../../../shared/agent-prompt";
import type { CodexTranscriptTurnDetails } from "../../../shared/codex-transcript-projection";
import {
  conversationRecoveryReason,
  type ConversationRecovery,
} from "../../../shared/conversation-recovery";

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

/** Preserve typed media and the complete MCP result used by application-tool renderers. */
function dynamicToolOutputContent(
  item: Extract<AgentTurnItem, { type: "dynamic_tool" }>,
): DynamicToolCallOutputContentItem[] | null {
  const result = item.outputOmitted ? null : item.mcpToolCall?.result;
  const output = result?.content ?? item.output;
  if (output === undefined) return null;
  const values = Array.isArray(output) ? output : [output];
  const content = values.map((value, contentIndex): DynamicToolCallOutputContentItem => {
    const source = () =>
      buildAgentRuntimeToolResultImageSource({
        sourceThreadId: item.threadId,
        itemId: item.id,
        contentIndex,
      });
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {
        type: "inputText",
        text: typeof value === "string" ? value : JSON.stringify(jsonValue(value)),
      };
    const block = value as Record<string, unknown>;
    if ((block.type === "inputText" || block.type === "text") && typeof block.text === "string")
      return { type: "inputText", text: block.text };
    if (block.type === "image") return { type: "inputImage", imageUrl: source() };
    if (block.type === "inputImage")
      return {
        type: "inputImage",
        imageUrl: typeof block.imageUrl === "string" ? block.imageUrl : source(),
      };
    if (block.type === "inputAudio" && typeof block.audioUrl === "string")
      return { type: "inputAudio", audioUrl: block.audioUrl };
    if (
      block.type === "audio" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      return { type: "inputAudio", audioUrl: `data:${block.mimeType};base64,${block.data}` };
    return { type: "inputText", text: JSON.stringify(jsonValue(value)) };
  });
  if (result?.structuredContent == null) return content;
  const text = JSON.stringify(result.structuredContent);
  return [
    { type: "inputText", text },
    ...content.filter((block) => block.type !== "inputText" || block.text !== text),
  ];
}

/** Runtime keeps native MCP identity and content; row identity belongs to the runtime item. */
function projectRuntimeMcpToolCall(
  item: Extract<AgentTurnItem, { type: "dynamic_tool" }>,
  status: "inProgress" | "completed" | "failed",
  durationMs: number | null,
): Extract<CodexCanonicalItem, { type: "mcpToolCall" }> {
  const call = item.mcpToolCall!;
  const app = call.appContext;
  return {
    type: "mcpToolCall",
    id: item.id,
    nativeCallId: call.id,
    server: call.server,
    tool: call.tool,
    status,
    arguments: jsonValue(call.arguments),
    appContext: app
      ? {
          connectorId: app.connectorId,
          linkId: app.linkId ?? null,
          resourceUri: app.resourceUri ?? null,
          appName: app.appName ?? null,
          actionName: app.actionName ?? null,
        }
      : null,
    mcpAppUi: call.mcpAppUi ? { ...call.mcpAppUi } : null,
    ...(call.mcpAppResourceUri ? { mcpAppResourceUri: call.mcpAppResourceUri } : {}),
    pluginId: call.pluginId ?? null,
    readOnlyHint: call.readOnlyHint ?? null,
    result: call.result
      ? {
          content: call.result.content.map((content, contentIndex) => {
            const value = jsonValue(content);
            if (
              value === null ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              value.type !== "image"
            )
              return value;
            return {
              ...value,
              data: "",
              source: buildAgentRuntimeToolResultImageSource({
                sourceThreadId: item.threadId,
                itemId: item.id,
                contentIndex,
              }),
            };
          }),
          structuredContent: jsonValue(call.result.structuredContent),
          _meta: jsonValue(call.result._meta),
        }
      : null,
    error: call.error ? { message: call.error.message } : null,
    durationMs: call.durationMs ?? durationMs,
    ...(item.outputOmitted ? { outputOmitted: true } : {}),
  };
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

const HANDOFF_CARRIED = {
  full_thread_summary: "conversation",
  delta_since_target_last_seen: "missed",
  fork_delta_summary: "fork",
  checkpoint_summary: "checkpoint",
  manual_context: "imported",
} as const satisfies Record<
  Extract<AgentTurnItem, { type: "handoff" }>["strategy"],
  Extract<CodexRuntimeNotice, { kind: "agentHandoff" }>["carried"]
>;

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

function runtimeRecoveryState(
  item: Extract<AgentTurnItem, { type: "error" }>,
): ConversationRecovery["state"] {
  if (item.status === "cancelled" || item.status === "interrupted") return "stopped";
  if (!item.retry) return "failed";
  if (isLive(item.status)) return "retrying";
  if (item.status === "completed" || item.status === "idle") return "recovered";
  return "failed";
}

function runtimeRecoveryReason(
  failure: Extract<AgentTurnItem, { type: "error" }>["failure"],
): ConversationRecovery["reason"] {
  // An unclassified provider code is not evidence of a connection failure.
  if (failure.code !== null) return conversationRecoveryReason(failure.code);
  if (failure.class === "transport_error") return "connection";
  if (failure.class === "usage_limit") return "usage_limit";
  return "unknown";
}

/** Retry metadata survives resolution; the item's current status owns recovery. */
function projectRuntimeRecovery(
  item: Extract<AgentTurnItem, { type: "error" }>,
): ConversationRecovery {
  const state = runtimeRecoveryState(item);
  const updatedAt = agentRuntimeTime(item.updatedAt);
  const delay = item.retry?.retryDelayMs;
  return {
    state,
    reason: runtimeRecoveryReason(item.failure),
    attempt: item.retry?.attempt ?? null,
    maxAttempts: item.retry?.maxAttempts ?? null,
    retryAt: state === "retrying" && updatedAt !== null && delay != null ? updatedAt + delay : null,
    updatedAt,
  };
}

function runtimeFailureDetails(
  failure: Extract<AgentTurnItem, { type: "error" }>["failure"],
): string | null {
  const resetAt = agentRuntimeTime(failure.resetAt);
  const details = [
    failure.code === null ? null : `Code: ${failure.code}`,
    resetAt === null ? null : `Usage resets: ${new Date(resetAt).toUTCString()}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
  return details || null;
}

/**
 * A presentation conversion only. Provider requests and execution remain engine-owned.
 * Hidden execution bookkeeping projects to null and never occupies a transcript slot.
 */
const unavailableImages = (item: AgentTurnItem): readonly CodexUnavailableImage[] =>
  (item.unavailableImages ?? []).map(({ name, sourcePath }) => ({ name, sourcePath }));

/** Pictures display from the item's owned attachment bytes, never from a recorded locator. */
function attachmentSource(item: AgentTurnItem, attachmentId: string): string {
  return buildAgentRuntimeAttachmentSource({
    sourceThreadId: item.threadId,
    itemId: item.id,
    attachmentId,
  });
}

function importedMarkdownImages(
  item: Extract<AgentTurnItem, { type: "assistant_message" }>,
): readonly CodexImportedMarkdownImage[] {
  return (item.importedImageLinks ?? []).map(({ sourcePath, attachmentId }) => {
    const copy =
      attachmentId === null
        ? undefined
        : item.attachments?.find((attachment) => attachment.id === attachmentId);
    const missing = item.unavailableImages?.find((image) => image.sourcePath === sourcePath);
    return {
      sourcePath,
      name: copy?.name ?? missing?.name ?? (sourcePath.split(/[\\/]/u).at(-1) || "Image"),
      source: copy ? attachmentSource(item, copy.id) : null,
    };
  });
}

/**
 * An imported inspection is recognized by its typed picture record (an owned copy or a missing
 * source), which survives output omission on the wire; its output body is never consulted.
 */
const isImportedImageView = (item: Extract<AgentTurnItem, { type: "dynamic_tool" }>) =>
  item.toolName === "imageView" &&
  (Boolean(item.unavailableImages?.length) ||
    Boolean(item.attachments?.some((attachment) => attachment.type === "image")));

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
      const missing = unavailableImages(item);
      return {
        type: "userMessage",
        id,
        clientId: item.messageId,
        ...(origin ? { origin } : {}),
        ...(inputIntent ? { inputIntent } : {}),
        ...(missing.length ? { unavailableImages: missing } : {}),
        content: [
          {
            type: "text",
            text: agentMessageDisplayText(item.text),
            text_elements: emptyTextElements,
          },
          ...item.attachments
            .filter((attachment) => attachment.type === "image")
            .map((attachment): UserInput => ({
              type: "image",
              url: attachmentSource(item, attachment.id),
            })),
        ],
      };
    }
    case "assistant_message": {
      const importedImages = importedMarkdownImages(item);
      return {
        type: "agentMessage",
        id,
        text: item.text,
        ...(importedImages.length ? { importedImages } : {}),
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
    }
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
      // File inspections use the provider's path, independently of retained tool-result bytes.
      if (item.status === "completed" && item.viewedImagePath)
        return { type: "imageView", id, path: item.viewedImagePath };
      if (isImportedImageView(item)) {
        const copy = item.attachments?.find((attachment) => attachment.type === "image");
        if (copy) return { type: "imageView", id, path: attachmentSource(item, copy.id) };
        const missing = unavailableImages(item);
        if (missing[0])
          return { type: "imageView", id, path: missing[0].sourcePath, unavailableImages: missing };
      }
      const { namespace, tool } = parseAgentRuntimeToolName(item.toolName);
      const toolStatus = status === "inProgress" || status === "completed" ? status : "failed";
      if (item.mcpToolCall && namespace !== "nodex_app")
        return projectRuntimeMcpToolCall(item, toolStatus, durationMs);
      return {
        type: "dynamicToolCall",
        id,
        namespace,
        tool,
        displayTitle: item.title,
        ...(item.outputOmitted ? { outputOmitted: true } : {}),
        arguments: jsonValue(item.input),
        status: toolStatus,
        contentItems: dynamicToolOutputContent(item),
        success: status === "inProgress" ? null : status === "completed",
        durationMs,
      };
    }
    case "subagent": {
      const display = projectAgentRuntimeSubagentDisplay(item);
      return {
        type: "delegatedTask",
        id,
        taskId: item.subagentId,
        ownerRunId: item.runId,
        childThreadId: item.childThreadId,
        title: display.displayName || firstLine(item.prompt) || "Subagent",
        ...(display.agentPath ? { agentPath: display.agentPath } : {}),
        providerInstanceId: item.providerInstanceId,
        status: agentRuntimeDelegatedTaskStatus(item.status),
        prompt: item.prompt,
        summary:
          (isLive(item.status)
            ? (item.progress ?? item.result)
            : (item.result ?? item.progress)
          )?.trim() || null,
      };
    }
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
        source: item.trigger === "manual" ? "manual" : "automatic",
        startedAtMs: agentRuntimeTime(item.startedAt),
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
        recovery: projectRuntimeRecovery(item),
        errorInfo: null,
        additionalDetails: runtimeFailureDetails(item.failure),
      };
    case "notification":
      return notice(item, item.summary, notificationNotice(item.source, item.outcome));
    case "run_interrupt_result":
      return notice(item, "Stopped", { kind: "stopped" });
    case "system_notice":
      return notice(item, item.message);
    case "handoff": {
      // The carried history itself stays with the Runtime; the notice names who continued.
      const to = { providerInstanceId: item.toProviderInstanceId, model: item.toModel ?? null };
      const from = item.fromModelSelections?.length
        ? item.fromModelSelections.map((selection) => ({
            providerInstanceId: selection.instanceId,
            model: selection.model,
          }))
        : item.fromProviderInstanceIds.map((providerInstanceId) => ({
            providerInstanceId,
            model: null,
          }));
      return notice(item, `Context handoff to ${to.model ?? to.providerInstanceId}`, {
        kind: "agentHandoff",
        carried: HANDOFF_CARRIED[item.strategy],
        failed: item.status === "failed",
        from,
        to,
      });
    }
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
            {
              type: "text",
              text: agentMessageDisplayText(openingItem.text),
              text_elements: emptyTextElements,
            },
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
