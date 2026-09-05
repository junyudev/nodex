import {
  expandCodexAsyncQuestions,
  decodeCodexAsyncQuestionReplies,
  formatCodexAsyncQuestionReplies,
} from "./codex-async-user-input";
import type { TurnStatus } from "@nodex/codex-app-server-protocol/v2/TurnStatus";
import {
  buildCodexFileChangeFromProtocol,
  buildCodexFileChangeMap,
  isCodexVisualizationPath,
} from "./codex-file-change";
import { resolveCodexFileChangeActivity } from "./codex-file-change-activity";
import {
  buildCodexUserAttachmentsFromContent,
  buildCodexUserAttachmentsFromInput,
} from "./codex-user-attachment-projection";
import { projectCodexParsedCommand } from "./codex-command-action-projection";
import { projectCodexMcpToolCall } from "./codex-mcp-tool-call";
import { parseCodexDelegationText } from "./codex-delegation";
import { projectCodexReasoningSummary } from "./codex-reasoning-projection";
import {
  buildAutomaticApprovalReviewSummary,
  normalizeAutomaticApprovalReviewPayload,
} from "./codex-transcript-special-items";
import type {
  CodexCanonicalItem,
  CodexCanonicalSteeringUserMessageItem,
  CodexCanonicalTurnParams,
  CodexCanonicalTurnState,
} from "./codex-conversation-state/codex-conversation-state";
import { buildCodexSteeringCompareKey } from "./codex-conversation-state/codex-steering-compare";
import { readCodexCanonicalThreadGoalTranscriptProjection } from "./codex-conversation-state/codex-thread-goal-transcript";
import type {
  CodexAutomationUpdateView,
  CodexCommandAction,
  CodexDynamicToolCallView,
  CodexFileChange,
  CodexFileChangeView,
  CodexItemStatus,
  CodexItemView,
  CodexReviewDiffCommentAttachment,
  CodexSteeringRestoreMessage,
  CodexSteeringUserInput,
} from "./types";

export interface ProjectCodexCanonicalItemViewsOptions {
  readonly observedAtMs: number;
  readonly turnStatus: TurnStatus;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
  readonly interruptedCommandExecutionItemIds?: readonly string[];
  readonly isBackgroundSubagentsEnabled?: boolean;
}

export interface ProjectCodexCanonicalTurnItemViewsInput extends ProjectCodexCanonicalItemViewsOptions {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly items: readonly CodexCanonicalItem[];
}

export interface ProjectCodexCanonicalVisibleTurnItemViewsInput extends ProjectCodexCanonicalTurnItemViewsInput {
  readonly hasVisibleTurnParamsUserMessage?: boolean;
  readonly params: CodexCanonicalTurnParams;
  readonly preserveServerUserMessages?: boolean;
}

export interface ProjectCodexCanonicalTurnViewsInput {
  readonly threadId: string;
  readonly turn: CodexCanonicalTurnState;
  readonly turnKey?: string;
  readonly observedAtMs: number;
  readonly isBackgroundSubagentsEnabled?: boolean;
  readonly preserveServerUserMessages?: boolean;
}

/** A complete turn view can include app-owned params fields absent from ThreadItem. */
export type CodexCanonicalTurnView = CodexItemView;

interface ItemProjectionContext extends ProjectCodexCanonicalItemViewsOptions {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly isLastNonUserWorkItem: boolean;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled canonical item: ${JSON.stringify(value)}`);
}

function buildBaseView(
  item: CodexCanonicalItem,
  context: ItemProjectionContext,
): Pick<
  CodexItemView,
  | "createdAt"
  | "itemId"
  | "rawItem"
  | "rawItemId"
  | "rawItemType"
  | "threadId"
  | "turnId"
  | "type"
  | "updatedAt"
> {
  return {
    threadId: context.threadId,
    turnId: context.turnId,
    itemId: item.id,
    rawItemId: item.id,
    rawItemType: item.type,
    type: item.type,
    rawItem: item,
    createdAt: context.observedAtMs,
    updatedAt: context.observedAtMs,
  };
}

function resolveCanonicalItemStatus(
  item: CodexCanonicalItem,
  context: ItemProjectionContext,
): CodexItemStatus | undefined {
  const lifecycleStatus = context.lifecycleStatusByItemId?.[item.id];
  if (lifecycleStatus !== undefined) return lifecycleStatus;

  if (
    "status" in item &&
    (item.status === "inProgress" ||
      item.status === "completed" ||
      item.status === "failed" ||
      item.status === "declined" ||
      item.status === "interrupted")
  ) {
    return item.status;
  }

  return context.turnStatus === "inProgress" ? undefined : "completed";
}

function resolveWebSearchCompleted(
  item: Extract<CodexCanonicalItem, { type: "webSearch" }>,
  context: ItemProjectionContext,
): boolean {
  const lifecycleStatus = context.lifecycleStatusByItemId?.[item.id];
  if (lifecycleStatus !== undefined) return lifecycleStatus !== "inProgress";
  if (context.turnStatus !== "inProgress") return true;
  return !context.isLastNonUserWorkItem;
}

/**
 * Reports the non-positional turn-status dependencies owned by individual
 * projector branches. Item lifecycle status is carried by the canonical
 * sidecar instead of inferred from sibling position.
 */
export function doesCodexCanonicalItemProjectionChangeWithTurnStatus(
  item: CodexCanonicalItem,
  beforeStatus: TurnStatus,
  afterStatus: TurnStatus,
): boolean {
  if (beforeStatus === afterStatus) return false;

  switch (item.type) {
    case "commandExecution":
      return (
        item.status === "inProgress" &&
        (beforeStatus === "interrupted") !== (afterStatus === "interrupted")
      );
    case "mcpToolCall":
      return (
        item.status === "inProgress" &&
        (beforeStatus === "inProgress") !== (afterStatus === "inProgress")
      );
    case "automaticApprovalReview":
      return (
        item.status === "inProgress" &&
        (beforeStatus === "interrupted") !== (afterStatus === "interrupted")
      );
    case "contextCompaction":
      return (
        (item.completed ?? true) === false &&
        (beforeStatus === "inProgress") !== (afterStatus === "inProgress")
      );
    default:
      return false;
  }
}

function projectAssistantText(text: string, streaming: boolean): string | null {
  const withoutMemoryCitations = text.replace(
    /<oai-mem-citation>.*?(?:<\/oai-mem-citation>|$)/gs,
    "",
  );
  const partialCitationIndex = streaming ? withoutMemoryCitations.lastIndexOf("<") : -1;
  const withoutPartialCitation =
    partialCitationIndex >= 0 &&
    "<oai-mem-citation>".startsWith(withoutMemoryCitations.slice(partialCitationIndex))
      ? withoutMemoryCitations.slice(0, partialCitationIndex)
      : withoutMemoryCitations;
  const trimmedStart = withoutPartialCitation.trimStart();
  if (
    withoutPartialCitation.trim() === "<EXTERNAL SESSION IMPORTED>" ||
    trimmedStart.startsWith("[external tool call:") ||
    trimmedStart.startsWith("[external tool result]") ||
    trimmedStart.startsWith("[external tool result:")
  ) {
    return null;
  }

  let hiddenBlock: "call" | "result" | null = null;
  let removed = withoutPartialCitation !== text;
  const retainedLines: string[] = [];
  for (const line of withoutPartialCitation.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (hiddenBlock) {
      removed = true;
      if (trimmed === `[/external_agent_tool_${hiddenBlock}]`) hiddenBlock = null;
      continue;
    }

    const opener = /^\[external_agent_tool_(call|result)(?::[^\]]*)?\]$/.exec(trimmed);
    if (opener) {
      hiddenBlock = opener[1] as "call" | "result";
      removed = true;
      continue;
    }
    retainedLines.push(line);
  }

  if (!removed) return text;
  const projected = retainedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return projected.length === 0 ? null : projected;
}

function projectUserMessageText(content: readonly CodexSteeringUserInput[]): string {
  return content.flatMap((input) => (input.type === "text" ? [input.text] : [])).join("\n");
}

function areStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => areStructurallyEqual(entry, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areStructurallyEqual(leftRecord[key], rightRecord[key]),
  );
}

export function areCodexCanonicalTurnParamsEqual(
  left: CodexCanonicalTurnParams,
  right: CodexCanonicalTurnParams,
): boolean {
  return areStructurallyEqual(left, right);
}

function isUserMessageDuplicatePreludeItem(item: CodexCanonicalItem): boolean {
  switch (item.type) {
    case "automaticApprovalReview":
    case "forkedFromConversation":
    case "modelChanged":
    case "modelRerouted":
    case "personalityChanged":
    case "remoteTaskCreated":
    case "worktreeInit":
      return true;
    default:
      return false;
  }
}

function isDuplicateServerUserMessage(input: {
  readonly items: readonly CodexCanonicalItem[];
  readonly itemIndex: number;
  readonly item: Extract<CodexCanonicalItem, { type: "userMessage" }>;
  readonly params: CodexCanonicalTurnParams;
}): boolean {
  const matchesClientId =
    input.item.clientId !== null &&
    input.params.clientUserMessageId != null &&
    input.item.clientId === input.params.clientUserMessageId;
  const matchesInput = areStructurallyEqual(input.item.content, input.params.input);
  if (!matchesClientId && !matchesInput) return false;

  return input.items.slice(0, input.itemIndex).every(isUserMessageDuplicatePreludeItem);
}

function collectCodexCanonicalDuplicateUserMessageIds(
  items: readonly CodexCanonicalItem[],
  params: CodexCanonicalTurnParams,
): ReadonlySet<string> {
  const duplicateIds = new Set<string>();
  items.forEach((item, itemIndex) => {
    if (item.type !== "userMessage") return;
    if (!isDuplicateServerUserMessage({ items, itemIndex, item, params })) return;
    duplicateIds.add(item.id);
  });
  return duplicateIds;
}

function projectServerUserMessageAsSteered(view: CodexItemView): CodexItemView {
  return {
    ...view,
    type: "steered",
    normalizedKind: "systemEvent",
    semanticKind: "steered",
    status: "completed",
    role: undefined,
    userAttachments: undefined,
    commentAttachments: undefined,
    deliveryStatus: undefined,
    markdownText: "Steered conversation",
  };
}

export function collectCodexCanonicalUserMessageVisibilityChangedOwnerIds(input: {
  readonly beforeItems: readonly CodexCanonicalItem[];
  readonly beforeParams: CodexCanonicalTurnParams;
  readonly afterItems: readonly CodexCanonicalItem[];
  readonly afterParams: CodexCanonicalTurnParams;
}): ReadonlySet<string> {
  const beforeIds = collectCodexCanonicalDuplicateUserMessageIds(
    input.beforeItems,
    input.beforeParams,
  );
  const afterIds = collectCodexCanonicalDuplicateUserMessageIds(
    input.afterItems,
    input.afterParams,
  );
  return new Set([
    ...[...beforeIds].filter((itemId) => !afterIds.has(itemId)),
    ...[...afterIds].filter((itemId) => !beforeIds.has(itemId)),
  ]);
}

function isReviewDiffCommentAttachment(value: unknown): value is CodexReviewDiffCommentAttachment {
  const attachment = asJsonObject(value);
  const position = asJsonObject(attachment?.position);
  if (
    attachment?.type !== "comment" ||
    typeof attachment.id !== "string" ||
    !Array.isArray(attachment.content) ||
    !attachment.content.every((part) => {
      const contentPart = asJsonObject(part);
      return contentPart?.content_type === "text" && typeof contentPart.text === "string";
    }) ||
    typeof attachment.createdAt !== "number" ||
    (position?.side !== "left" && position?.side !== "right") ||
    typeof position.path !== "string" ||
    typeof position.line !== "number"
  ) {
    return false;
  }

  return true;
}

function projectTurnParamsUserView(input: {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly turnKey: string;
  readonly params: CodexCanonicalTurnParams;
  readonly blocked: boolean;
  readonly observedAtMs: number;
  readonly goalProjection: ReturnType<typeof readCodexCanonicalThreadGoalTranscriptProjection>;
}): CodexCanonicalTurnView | null {
  const itemId = `${input.turnKey}:input`;
  const rawCommentAttachments = input.params.commentAttachments ?? [];
  const commentAttachments = rawCommentAttachments.filter(isReviewDiffCommentAttachment);
  const rawMarkdownText = buildCodexSteeringCompareKey(
    input.params.input,
    rawCommentAttachments,
  ).rawText;
  const delegation = parseCodexDelegationText(rawMarkdownText);
  const markdownText = input.goalProjection?.message ?? delegation?.input ?? rawMarkdownText;
  const userAttachments = buildCodexUserAttachmentsFromInput(
    input.params.input,
    input.params.attachments ?? [],
    itemId,
  );
  if (
    markdownText.trim().length === 0 &&
    userAttachments.length === 0 &&
    commentAttachments.length === 0
  ) {
    return null;
  }

  return {
    threadId: input.threadId,
    turnId: input.turnId,
    itemId,
    type: "userMessage",
    normalizedKind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    status: "completed",
    markdownText,
    ...(input.goalProjection ? { goal: true } : {}),
    ...(input.blocked ? { deliveryStatus: "not-sent" as const } : {}),
    ...(commentAttachments.length === 0 ? {} : { commentAttachments: [...commentAttachments] }),
    ...(userAttachments.length === 0 ? {} : { userAttachments }),
    ...(input.goalProjection
      ? {}
      : {
          rawItem: {
            id: itemId,
            type: "userMessage",
            clientId: input.params.clientUserMessageId ?? null,
            content: [...input.params.input],
            attachments: [...(input.params.attachments ?? [])],
            commentAttachments: [...commentAttachments],
          },
        }),
    createdAt: input.observedAtMs,
    updatedAt: input.observedAtMs,
  };
}

function projectSteeringUserMessage(
  item: CodexCanonicalSteeringUserMessageItem,
  context: ItemProjectionContext,
): CodexItemView[] {
  const rawText = projectUserMessageText(item.input);
  const questionReplies =
    item.input.length === 1 ? (decodeCodexAsyncQuestionReplies(rawText) ?? undefined) : undefined;
  const markdownText = questionReplies ? formatCodexAsyncQuestionReplies(questionReplies) : rawText;
  const contentAttachments = buildCodexUserAttachmentsFromContent(item.input, item.id);
  if (markdownText.trim().length === 0 && contentAttachments.length === 0) return [];

  return [
    {
      ...buildBaseView(item, context),
      normalizedKind: "userMessage",
      semanticKind: "userMessage",
      role: "user",
      status: "completed",
      markdownText,
      questionReplies,
      steeringStatus: item.status,
      steeringInput: [...item.input],
      steeringCompareKey: JSON.stringify(item.compareKey),
      steeringRestoreMessage: item.restoreMessage as unknown as CodexSteeringRestoreMessage,
      steeringTargetTurnId: item.targetTurnId,
      steeringTargetTurnStartedAtMs: item.targetTurnStartedAtMs,
      ...(contentAttachments.length === 0 ? {} : { userAttachments: contentAttachments }),
    },
  ];
}

function projectCommandActions(
  item: Extract<CodexCanonicalItem, { type: "commandExecution" }>,
  context: ItemProjectionContext,
): CodexItemView[] {
  const actions: readonly CodexCommandAction[] =
    item.commandActions.length > 0
      ? item.commandActions
      : [{ type: "unknown", command: item.command }];
  const interrupted =
    item.status === "inProgress" &&
    (context.turnStatus === "interrupted" ||
      context.interruptedCommandExecutionItemIds?.includes(item.id) === true);
  const executionStatus: CodexItemStatus = interrupted ? "interrupted" : item.status;
  const outputExists = item.aggregatedOutput !== null || item.exitCode !== null;

  return actions.map((action, index) => {
    const callId = actions.length > 1 ? `${item.id}:${index}` : item.id;
    const command = action.command.trim();
    return {
      ...buildBaseView(item, context),
      itemId: callId,
      normalizedKind: "commandExecution",
      semanticKind: "exec",
      callId,
      ...(callId === item.id ? {} : { commandExecutionItemId: item.id }),
      command,
      cmd: command.length > 0 ? [command] : [],
      cwd: item.cwd || null,
      processId: item.processId,
      commandActions: [action],
      aggregatedOutput: outputExists ? (item.aggregatedOutput ?? "") : null,
      exitCode: outputExists ? item.exitCode : null,
      durationMs: item.durationMs,
      startedAtMs: context.commandExecutionStartedAtMsById?.[item.id],
      status: executionStatus,
      executionStatus,
      parsedCmd: projectCodexParsedCommand(action, executionStatus !== "inProgress"),
      approvalRequestId: null,
      proposedExecpolicyAmendment: null,
    };
  });
}

function resolveFileChangeKind(
  change: Extract<CodexCanonicalItem, { type: "fileChange" }>["changes"][number],
): "add" | "delete" | "update" {
  return change.kind.type;
}

function projectFileChange(
  item: Extract<CodexCanonicalItem, { type: "fileChange" }>,
  context: ItemProjectionContext,
): CodexItemView[] {
  const ordinaryChanges: CodexFileChange[] = [];
  const visualizationKinds = new Map<string, "create" | "update">();
  for (const change of item.changes) {
    const kind = resolveFileChangeKind(change);
    const movePath = change.kind.type === "update" ? change.kind.move_path : null;
    const projectedPath = movePath ?? change.path;
    if (isCodexVisualizationPath(projectedPath)) {
      if (kind === "add") visualizationKinds.set(projectedPath, "create");
      if (kind === "update" && visualizationKinds.get(projectedPath) !== "create") {
        visualizationKinds.set(projectedPath, "update");
      }
      continue;
    }

    const projected = buildCodexFileChangeFromProtocol({
      path: change.path,
      kind,
      diff: change.diff,
      movePath,
    });
    if (projected) ordinaryChanges.push(projected);
  }

  const visualizationActivities =
    item.status === "inProgress" || item.status === "completed"
      ? [...visualizationKinds].map(([path, kind]) => ({ path, kind }))
      : [];

  const fileChange: CodexFileChangeView = {
    changes: buildCodexFileChangeMap(ordinaryChanges),
    ...(visualizationActivities.length === 0 ? {} : { visualizationActivities }),
  };
  const activity = resolveCodexFileChangeActivity({
    status: item.status,
    fileChange,
  });
  if (activity.visibility === "suppressed") return [];
  const projectedFileChange: CodexFileChangeView = {
    ...fileChange,
    success: activity.success,
  };
  return [
    {
      ...buildBaseView(item, context),
      normalizedKind: "fileChange",
      semanticKind: "patch",
      callId: item.id,
      status: item.status,
      fileChange: projectedFileChange,
      approvalRequestId: null,
      grantRoot: null,
    },
  ];
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseAutomationResult(
  contentItems: Extract<CodexCanonicalItem, { type: "dynamicToolCall" }>["contentItems"],
): CodexAutomationUpdateView["result"] {
  for (const contentItem of contentItems ?? []) {
    if (contentItem.type !== "inputText") continue;
    try {
      const parsed = asJsonObject(JSON.parse(contentItem.text));
      const automationId =
        typeof parsed?.automationId === "string" ? parsed.automationId.trim() : "";
      if (!automationId) continue;
      const mode =
        parsed?.mode === "create" || parsed?.mode === "update" || parsed?.mode === "delete"
          ? parsed.mode
          : null;
      const deleteStatus =
        parsed?.deleteStatus === "deleted" || parsed?.deleteStatus === "not_found"
          ? parsed.deleteStatus
          : undefined;
      const rawSnapshot = asJsonObject(parsed?.snapshot);
      const snapshot:
        | NonNullable<NonNullable<CodexAutomationUpdateView["result"]>["snapshot"]>
        | undefined =
        rawSnapshot &&
        (rawSnapshot.kind === "cron" || rawSnapshot.kind === "heartbeat") &&
        typeof rawSnapshot.name === "string" &&
        typeof rawSnapshot.rrule === "string"
          ? {
              kind: rawSnapshot.kind,
              name: rawSnapshot.name,
              rrule: rawSnapshot.rrule,
            }
          : undefined;
      return {
        automationId,
        mode,
        ...(deleteStatus ? { deleteStatus } : {}),
        ...(snapshot ? { snapshot } : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function projectAutomationUpdate(
  item: Extract<CodexCanonicalItem, { type: "dynamicToolCall" }>,
  context: ItemProjectionContext,
): CodexItemView[] {
  if (item.status !== "completed" || item.success !== true) return [];
  const args = asJsonObject(item.arguments);
  if (!args || typeof args.mode !== "string") return [];

  const result = parseAutomationResult(item.contentItems);
  const resolvedId =
    result?.automationId ??
    (typeof args.id === "string" && args.id.trim().length > 0 ? args.id : null);
  const snapshot = result?.mode === "delete" ? result.snapshot : undefined;
  return [
    {
      ...buildBaseView(item, context),
      normalizedKind: "systemEvent",
      semanticKind: "automationUpdate",
      status: "completed",
      automationUpdate: {
        callId: item.id,
        arguments: {
          ...args,
          ...(resolvedId ? { id: resolvedId } : {}),
          ...(snapshot ? { kind: snapshot.kind, name: snapshot.name, rrule: snapshot.rrule } : {}),
        },
        result,
      },
    },
  ];
}

function projectDynamicToolCall(
  item: Extract<CodexCanonicalItem, { type: "dynamicToolCall" }>,
  context: ItemProjectionContext,
): CodexItemView[] {
  if (item.tool === "automation_update") return projectAutomationUpdate(item, context);
  if (item.tool === "load_workspace_dependencies") return [];

  const dynamicToolCall: CodexDynamicToolCallView = {
    callId: item.id,
    namespace: item.namespace,
    tool: item.tool,
    arguments: item.arguments,
    status: item.status,
    contentItems: item.contentItems,
    success: item.success,
    durationMs: item.durationMs,
    completed: item.status === "completed" || item.status === "failed",
  };
  return [
    {
      ...buildBaseView(item, context),
      normalizedKind: "toolCall",
      semanticKind: "dynamicToolCall",
      status: item.status,
      dynamicToolCall,
    },
  ];
}

function projectSubagentDisplayName(agentPath: string): string | null {
  const segment = agentPath
    .split("/")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "root")
    .at(-1);
  if (!segment) return null;
  const normalized = segment.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return null;
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

function projectSubagentDisplayStatus(
  kind: Extract<CodexCanonicalItem, { type: "subAgentActivity" }>["kind"],
): "active" | "updated" | "interrupted" {
  if (kind === "started") return "active";
  if (kind === "interacted") return "updated";
  return "interrupted";
}

function projectErrorMessage(message: string, willRetry: boolean): string {
  if (!willRetry) {
    try {
      const parsed = asJsonObject(JSON.parse(message));
      const error = asJsonObject(parsed?.error);
      if (typeof error?.message === "string") return error.message;
    } catch {
      return message;
    }
    return message;
  }

  const reconnect = /^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/.exec(message.trim());
  return reconnect ? `Reconnecting ${reconnect[1]}/${reconnect[2]}` : message;
}

function shouldHidePolicyError(item: Extract<CodexCanonicalItem, { type: "error" }>): boolean {
  if (item.errorInfo === "cyberPolicy") return true;
  try {
    const parsed = asJsonObject(JSON.parse(item.message));
    const error = asJsonObject(parsed?.error);
    const message = typeof error?.message === "string" ? error.message : item.message;
    return (
      error?.code === "bio_policy" ||
      message.startsWith(
        "Invalid prompt: we've limited access to this content for safety reasons.",
      ) ||
      message.startsWith("This content was flagged for possible biological risk.")
    );
  } catch {
    return (
      item.message.startsWith(
        "Invalid prompt: we've limited access to this content for safety reasons.",
      ) || item.message.startsWith("This content was flagged for possible biological risk.")
    );
  }
}

function isNonUserWorkItem(item: CodexCanonicalItem): boolean {
  return (
    item.type !== "userMessage" &&
    item.type !== "hookPrompt" &&
    item.type !== "steeringUserMessage" &&
    item.type !== "steered"
  );
}

function resolveLastNonUserWorkItemIndex(items: readonly CodexCanonicalItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && isNonUserWorkItem(item)) return index;
  }
  return -1;
}

function projectCanonicalItemViews(
  item: CodexCanonicalItem,
  context: ItemProjectionContext,
): CodexItemView[] {
  switch (item.type) {
    case "hookPrompt": {
      const markdownText = item.fragments.map((fragment) => fragment.text).join("\n");
      if (markdownText.trim().length === 0) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          markdownText,
          hookFeedback: true,
        },
      ];
    }
    case "agentMessage": {
      const questions = expandCodexAsyncQuestions(item);
      if (questions.length)
        return questions.map((question) => ({
          ...buildBaseView(item, context),
          itemId: question.id,
          rawItemId: item.id,
          normalizedKind: "assistantMessage",
          semanticKind: "assistantMessage",
          role: "assistant",
          assistantPhase: "commentary",
          markdownText: question.title,
          asyncQuestion: question,
          status: resolveCanonicalItemStatus(item, context),
        }));
      const status = resolveCanonicalItemStatus(item, context);
      const markdownText = projectAssistantText(item.text, status === "inProgress");
      if (markdownText === null) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "assistantMessage",
          semanticKind: "assistantMessage",
          role: "assistant",
          assistantPhase: item.phase ?? undefined,
          markdownText,
          status,
        },
      ];
    }
    case "functionCallOutput":
      return [];
    case "plan": {
      const status = resolveCanonicalItemStatus(item, context);
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "plan",
          semanticKind: "proposedPlan",
          role: "assistant",
          markdownText: item.text,
          status,
        },
      ];
    }
    case "reasoning": {
      const status = resolveCanonicalItemStatus(item, context);
      const markdownText = projectCodexReasoningSummary(item.summary);
      if (!markdownText) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "reasoning",
          semanticKind: "reasoning",
          markdownText,
          status,
        },
      ];
    }
    case "commandExecution":
      return projectCommandActions(item, context);
    case "fileChange":
      return projectFileChange(item, context);
    case "mcpToolCall":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "toolCall",
          semanticKind: "mcpToolCall",
          status: item.status,
          mcpToolCall: projectCodexMcpToolCall(item, context.turnStatus),
        },
      ];
    case "dynamicToolCall":
      return projectDynamicToolCall(item, context);
    case "collabAgentToolCall":
      if (context.isBackgroundSubagentsEnabled === false || item.tool === "wait") return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "toolCall",
          semanticKind: "multiAgentAction",
          status: item.status,
        },
      ];
    case "subAgentActivity":
      if (context.isBackgroundSubagentsEnabled === false) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "subAgentActivity",
          status: item.kind === "interrupted" ? "interrupted" : "inProgress",
          subagentActivity: {
            agentThreadId: item.agentThreadId,
            displayName: projectSubagentDisplayName(item.agentPath),
            displayStatus: projectSubagentDisplayStatus(item.kind),
          },
        },
      ];
    case "todo-list": {
      const markdownText = item.plan
        .map(
          (step, index) =>
            `${index + 1}. [${step.status === "completed" ? "x" : " "}] ${step.step}`,
        )
        .join("\n");
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "plan",
          semanticKind: "todoList",
          status: item.plan.every((step) => step.status === "completed")
            ? "completed"
            : "inProgress",
          markdownText,
        },
      ];
    }
    case "planImplementation":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "planImplementation",
          semanticKind: "planImplementation",
          status: item.isCompleted ? "completed" : "inProgress",
          markdownText: item.planContent,
        },
      ];
    case "error":
      if (!item.willRetry && shouldHidePolicyError(item)) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: item.willRetry ? "streamError" : "systemError",
          status: item.willRetry ? "inProgress" : "failed",
          markdownText: projectErrorMessage(item.message, item.willRetry),
          additionalDetails: item.additionalDetails,
          willRetry: item.willRetry,
        },
      ];
    case "automaticApprovalReview": {
      const review = normalizeAutomaticApprovalReviewPayload(item);
      if (!review) return [];
      const status =
        item.status === "inProgress" && context.turnStatus === "interrupted"
          ? "aborted"
          : item.status;
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "automaticApprovalReview",
          status: status === "inProgress" ? "inProgress" : "completed",
          markdownText: buildAutomaticApprovalReviewSummary({ ...review, status }),
        },
      ];
    }
    case "remoteTaskCreated":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "remoteTaskCreated",
          status: "completed",
        },
      ];
    case "personalityChanged":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "personalityChanged",
          status: "completed",
        },
      ];
    case "forkedFromConversation":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "forkedFromConversation",
          status: "completed",
        },
      ];
    case "modelChanged":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "modelChanged",
          status: "completed",
        },
      ];
    case "modelRerouted":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "modelRerouted",
          status: "completed",
        },
      ];
    case "autoReviewInterruptionWarning":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "autoReviewInterruptionWarning",
          status: "completed",
          markdownText:
            "Automatic approval review rejected too many approval requests for this turn",
        },
      ];
    case "userInputResponse":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "userInputResponse",
          semanticKind: "userInputResponse",
          requestId: item.requestId,
          status: item.completed ? "completed" : "inProgress",
          markdownText:
            item.questions.length === 1
              ? "Asked 1 question"
              : `Asked ${item.questions.length} questions`,
          userInputQuestions: item.questions.map((question) => ({
            ...question,
            isOther: false,
            isSecret: false,
            options: [...question.options],
          })),
          userInputAnswers: Object.fromEntries(
            Object.entries(item.answers).map(([id, answers]) => [id, [...answers]]),
          ),
        },
      ];
    case "mcpServerElicitation":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "mcpServerElicitation",
          requestId: item.requestId,
          status: item.completed ? "completed" : "inProgress",
          markdownText:
            "message" in item.elicitation ? item.elicitation.message : "MCP elicitation",
        },
      ];
    case "permissionRequest":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "permissionRequest",
          requestId: item.requestId,
          status: item.completed ? "completed" : "inProgress",
          markdownText: item.reason ?? "Permission request",
        },
      ];
    case "webSearch":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "toolCall",
          semanticKind: "webSearch",
          webSearch: {
            query: item.query,
            action: item.action,
            completed: resolveWebSearchCompleted(item, context),
          },
        },
      ];
    case "contextCompaction": {
      const completed = context.turnStatus !== "inProgress" || (item.completed ?? true);
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "contextCompaction",
          status: completed ? "completed" : "inProgress",
          markdownText: completed
            ? "Context automatically compacted"
            : "Automatically compacting context",
          contextCompaction: {
            completed,
            source: item.source ?? "automatic",
          },
        },
      ];
    }
    case "worktreeInit":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "worktreeInit",
          status: "completed",
        },
      ];
    case "userMessage": {
      const rawText = projectUserMessageText(item.content);
      const questionReplies =
        item.content.length === 1
          ? (decodeCodexAsyncQuestionReplies(rawText) ?? undefined)
          : undefined;
      const markdownText = questionReplies
        ? formatCodexAsyncQuestionReplies(questionReplies)
        : rawText;
      const userAttachments = buildCodexUserAttachmentsFromContent(item.content, item.id);
      if (markdownText.trim().length === 0 && userAttachments.length === 0) return [];
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          status: "completed",
          markdownText,
          questionReplies,
          ...(userAttachments.length === 0 ? {} : { userAttachments }),
        },
      ];
    }
    case "steeringUserMessage":
      return projectSteeringUserMessage(item, context);
    case "steered":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "steered",
          status: "completed",
          acceptedUserMessageItemId: item.id,
          markdownText: "Steered conversation",
        },
      ];
    case "imageGeneration":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "generatedImage",
          generatedImage: {
            src: item.src,
            status: item.status,
          },
        },
      ];
    case "imageView":
      return [
        {
          ...buildBaseView(item, context),
          normalizedKind: "systemEvent",
          semanticKind: "imageView",
          status: "completed",
          imageViewPaths: [item.path],
        },
      ];
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "sleep":
      return [];
    default:
      return assertNever(item);
  }
}

/**
 * Projects one canonical raw turn into display views with the bundle's exact
 * per-discriminant 0/1/N policy. Protocol ingress and app-local constructors
 * establish the complete union before this exhaustive projector runs.
 */
export function projectCodexCanonicalTurnItemViews(
  input: ProjectCodexCanonicalTurnItemViewsInput,
): CodexItemView[] {
  const views: CodexItemView[] = [];
  let previousRawItemWasImageView = false;
  const lastNonUserWorkItemIndex = resolveLastNonUserWorkItemIndex(input.items);

  input.items.forEach((item, rawItemIndex) => {
    const projected = projectCanonicalItemViews(item, {
      ...input,
      isLastNonUserWorkItem: rawItemIndex === lastNonUserWorkItemIndex,
    });
    if (item.type !== "imageView") {
      previousRawItemWasImageView = false;
      views.push(...projected);
      return;
    }

    const previous = views.at(-1);
    const next = projected[0];
    if (
      !previousRawItemWasImageView ||
      !previous ||
      previous.semanticKind !== "imageView" ||
      !next?.imageViewPaths
    ) {
      previousRawItemWasImageView = true;
      views.push(...projected);
      return;
    }

    views[views.length - 1] = {
      ...previous,
      imageViewPaths: [...(previous.imageViewPaths ?? []), ...next.imageViewPaths],
      updatedAt: next.updatedAt,
    };
    previousRawItemWasImageView = true;
  });

  return views;
}

export function projectCodexCanonicalVisibleTurnItemViews(
  input: ProjectCodexCanonicalVisibleTurnItemViewsInput,
): CodexItemView[] {
  const duplicateUserMessageIds = collectCodexCanonicalDuplicateUserMessageIds(
    input.items,
    input.params,
  );
  const hasVisibleTurnParamsUserMessage =
    input.hasVisibleTurnParamsUserMessage ??
    projectTurnParamsUserView({
      threadId: input.threadId,
      turnId: input.turnId,
      turnKey: input.turnId ?? "local-turn",
      params: input.params,
      blocked: false,
      observedAtMs: input.observedAtMs,
      goalProjection: null,
    }) !== null;
  return projectCodexCanonicalTurnItemViews(input).flatMap((view) => {
    if (
      hasVisibleTurnParamsUserMessage &&
      input.preserveServerUserMessages !== true &&
      view.rawItemId &&
      duplicateUserMessageIds.has(view.rawItemId)
    ) {
      return [];
    }
    if (
      input.preserveServerUserMessages === true ||
      !hasVisibleTurnParamsUserMessage ||
      view.rawItemType !== "userMessage"
    ) {
      return [view];
    }
    return [projectServerUserMessageAsSteered(view)];
  });
}

/**
 * Projects the complete canonical turn, including the app-owned user input
 * retained in turn params. The raw item projector remains the lower-level
 * boundary for lifecycle diffs; snapshot/read paths should use this adapter.
 */
export function projectCodexCanonicalTurnViews(
  input: ProjectCodexCanonicalTurnViewsInput,
): CodexCanonicalTurnView[] {
  const turnId = input.turn.protocol.id;
  const turnKey = input.turnKey ?? turnId;
  if (turnKey === null) {
    throw new Error("A null-id canonical turn requires its occurrence key");
  }

  const blocked =
    input.turn.sidecar.hookRuns?.some(
      ({ run }) => run.eventName === "userPromptSubmit" && run.status === "blocked",
    ) === true;
  const paramsView = projectTurnParamsUserView({
    threadId: input.threadId,
    turnId,
    turnKey,
    params: input.turn.sidecar.params,
    blocked,
    observedAtMs: input.observedAtMs,
    goalProjection: readCodexCanonicalThreadGoalTranscriptProjection(input.turn),
  });
  const rawViews = projectCodexCanonicalVisibleTurnItemViews({
    threadId: input.threadId,
    turnId,
    items: input.turn.items,
    params: input.turn.sidecar.params,
    hasVisibleTurnParamsUserMessage: paramsView !== null,
    preserveServerUserMessages: input.preserveServerUserMessages,
    observedAtMs: input.observedAtMs,
    turnStatus: input.turn.protocol.status,
    commandExecutionStartedAtMsById: input.turn.sidecar.commandExecutionStartedAtMsById,
    lifecycleStatusByItemId: input.turn.sidecar.lifecycleStatusByItemId,
    interruptedCommandExecutionItemIds: input.turn.sidecar.interruptedCommandExecutionItemIds,
    isBackgroundSubagentsEnabled: input.isBackgroundSubagentsEnabled,
  });

  return paramsView ? [paramsView, ...rawViews] : rawViews;
}
