import type {
  ThreadAgentActivityClassification,
  ThreadAgentActivityGrouping,
  ThreadAgentActivityItem,
  ThreadAgentActivityUnit,
  ThreadAgentItemModel,
  ThreadIndexedAgentActivityItem,
  ThreadWorkedForBlockModel,
  ThreadTranscriptBlockModel,
} from "../thread-stage-types";
import { normalizeAutomaticApprovalReviewPayload } from "../../../../shared/codex-transcript-special-items";
import { resolveCodexMcpAppClassification } from "../../../../shared/codex-mcp-tool-call";
import type {
  CodexConversationItem,
  CodexDynamicToolCallView,
  CodexMcpToolCallView,
  ProtocolListMcpServerStatusResponse,
} from "../../../lib/types";
import {
  isDynamicToolStandaloneInConversation,
  isDynamicToolSummaryOnlyInConversationGroup,
} from "./tool-metadata/dynamic-tool-call-utils";
import {
  resolveExplorationPath,
  resolveExplorationSkillPathInfo,
} from "./tool-metadata/command-actions";
import { resolveCodexFileChangeActivity } from "../../../../shared/codex-file-change-activity";

export type ThreadAgentActivityVisibility = "hidden" | ThreadAgentActivityGrouping;

/** Mirrors the bundle's `Ip`: visible classifications preserve the item by identity. */
export function createThreadAgentActivityItem<TItem>(
  item: TItem,
  grouping: ThreadAgentActivityGrouping,
): ThreadAgentActivityItem<TItem> {
  return { item, grouping };
}

export function resolveThreadAgentActivityVisibility<TItem>(
  classification: ThreadAgentActivityClassification<TItem>,
): ThreadAgentActivityVisibility {
  return classification?.grouping ?? "hidden";
}

export function isThreadAgentActivityGroup<TItem>(
  unit: ThreadAgentActivityUnit<TItem>,
): unit is Extract<ThreadAgentActivityUnit<TItem>, { kind: "group" }> {
  return unit.kind === "group";
}

export type ThreadExecPatchWebActivityItem = ThreadTranscriptBlockModel & {
  type: "exec" | "fileChange" | "webSearch";
};

export function resolveThreadAutomaticApprovalReviewStatus(
  review: ThreadTranscriptBlockModel["entry"],
): NonNullable<ReturnType<typeof normalizeAutomaticApprovalReviewPayload>>["status"] | null {
  return normalizeAutomaticApprovalReviewPayload(review.rawItem)?.status ?? null;
}

/** Mirrors the bundle's `Rp`, including its referential-equality fast paths. */
export function removeApprovedThreadAutomaticApprovalReviews<
  TItem extends ThreadTranscriptBlockModel,
>(item: TItem): TItem {
  const reviews = item.automaticApprovalReviews;
  if (reviews == null) return item;

  const retainedReviews = reviews.filter(
    (review) => resolveThreadAutomaticApprovalReviewStatus(review) !== "approved",
  );
  if (retainedReviews.length > 0 && retainedReviews.length === reviews.length) return item;

  const itemWithoutReviews = { ...item };
  Reflect.deleteProperty(itemWithoutReviews, "automaticApprovalReviews");
  if (retainedReviews.length === 0) return itemWithoutReviews as TItem;

  return {
    ...itemWithoutReviews,
    automaticApprovalReviews: retainedReviews,
  } as TItem;
}

export function classifyThreadExecPatchWebActivityItem<
  TItem extends ThreadExecPatchWebActivityItem,
>(item: TItem): ThreadAgentActivityClassification<TItem> {
  switch (item.type) {
    case "exec":
      return createThreadAgentActivityItem(
        removeApprovedThreadAutomaticApprovalReviews(item),
        "groupable",
      );
    case "fileChange": {
      const activity = resolveCodexFileChangeActivity({
        status: item.entry.status,
        fileChange: item.entry.fileChange,
      });
      if (activity.visibility === "suppressed") return null;
      return createThreadAgentActivityItem(
        removeApprovedThreadAutomaticApprovalReviews(item),
        "groupable",
      );
    }
    case "webSearch":
      return (item.entry.webSearch?.query ?? "").trim().length === 0
        ? null
        : createThreadAgentActivityItem(item, "groupable");
  }
}

export type ThreadMcpActivityItem = ThreadTranscriptBlockModel & {
  type: "mcpToolCall";
  entry: CodexConversationItem & { mcpToolCall: CodexMcpToolCallView };
};

export function isThreadMcpActivityStandalone(input: {
  item: ThreadMcpActivityItem;
  mcpServerStatuses: ProtocolListMcpServerStatusResponse | null;
}): boolean {
  const payload = input.item.entry.mcpToolCall;
  if (payload.source?.kind === "computerUse") return true;
  if (payload.invocation.server === "computer-use") return true;

  return (
    resolveCodexMcpAppClassification({
      payload,
      mcpServerStatuses: input.mcpServerStatuses,
      isMcpAppWidgetSuperseded: input.item.isMcpAppWidgetSuperseded,
    }) === "mcp-app"
  );
}

export function classifyThreadMcpActivityItem<TItem extends ThreadMcpActivityItem>(
  item: TItem,
  mcpServerStatuses: ProtocolListMcpServerStatusResponse | null,
): ThreadAgentActivityClassification<TItem> {
  const cleanedItem = removeApprovedThreadAutomaticApprovalReviews(item);
  return createThreadAgentActivityItem(
    cleanedItem,
    isThreadMcpActivityStandalone({ item: cleanedItem, mcpServerStatuses })
      ? "standalone"
      : "groupable",
  );
}

export type ThreadDynamicActivityItem = ThreadTranscriptBlockModel & {
  type: "dynamicToolCall";
  entry: CodexConversationItem & { dynamicToolCall: CodexDynamicToolCallView };
};

export function classifyThreadDynamicActivityItem<TItem extends ThreadDynamicActivityItem>(
  item: TItem,
): ThreadAgentActivityClassification<TItem> {
  return createThreadAgentActivityItem(
    item,
    isDynamicToolStandaloneInConversation(item.entry.dynamicToolCall) ? "standalone" : "groupable",
  );
}

export type ThreadClassifiableActivityTranscriptType =
  | "assistantMessage"
  | "autoReviewInterruptionWarning"
  | "automaticApprovalReview"
  | "automationUpdate"
  | "contextCompaction"
  | "dynamicToolCall"
  | "exec"
  | "fileChange"
  | "forkedFromConversation"
  | "generatedImage"
  | "hook"
  | "imageView"
  | "mcpServerElicitation"
  | "mcpToolCall"
  | "modelChanged"
  | "modelRerouted"
  | "multiAgentAction"
  | "permissionRequest"
  | "personalityChanged"
  | "planImplementation"
  | "proposedPlan"
  | "realtimeTranscript"
  | "reasoning"
  | "remoteTaskCreated"
  | "steered"
  | "streamError"
  | "subagentActivityInlineGroup"
  | "systemError"
  | "todoList"
  | "turnDiff"
  | "userInput"
  | "userInputResponse"
  | "userMessage"
  | "webSearch"
  | "worktreeInit";

export type ThreadClassifiableActivityItem =
  | ThreadWorkedForBlockModel
  | (ThreadTranscriptBlockModel & { type: ThreadClassifiableActivityTranscriptType });

const THREAD_CLASSIFIABLE_ACTIVITY_TYPES = new Set<ThreadTranscriptBlockModel["type"]>([
  "assistantMessage",
  "autoReviewInterruptionWarning",
  "automaticApprovalReview",
  "automationUpdate",
  "contextCompaction",
  "dynamicToolCall",
  "exec",
  "fileChange",
  "forkedFromConversation",
  "generatedImage",
  "hook",
  "imageView",
  "mcpServerElicitation",
  "mcpToolCall",
  "modelChanged",
  "modelRerouted",
  "multiAgentAction",
  "permissionRequest",
  "personalityChanged",
  "planImplementation",
  "proposedPlan",
  "realtimeTranscript",
  "reasoning",
  "remoteTaskCreated",
  "steered",
  "streamError",
  "subagentActivityInlineGroup",
  "systemError",
  "todoList",
  "turnDiff",
  "userInput",
  "userInputResponse",
  "userMessage",
  "webSearch",
  "worktreeInit",
]);

export function isThreadClassifiableActivityItem(
  item: ThreadAgentItemModel,
): item is ThreadClassifiableActivityItem {
  return item.type === "workedFor" || THREAD_CLASSIFIABLE_ACTIVITY_TYPES.has(item.type);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isThreadOpenAiFormInteractiveProperty(value: unknown): boolean {
  return asRecord(value)?.type === "openai/imagePicker";
}

function classifyThreadMcpServerElicitationActivityItem<
  TItem extends ThreadClassifiableActivityItem,
>(item: TItem): ThreadAgentActivityClassification<TItem> {
  const rawItem = asRecord("entry" in item ? item.entry.rawItem : null);
  const elicitation = asRecord(rawItem?.elicitation);
  if (rawItem?.completed !== true || elicitation == null) return null;
  if (elicitation.kind === "unsupportedOpenAIForm") return null;

  if (elicitation.kind !== "openaiForm") {
    return createThreadAgentActivityItem(item, "standalone");
  }

  const schema = asRecord(elicitation.schema);
  const properties = asRecord(schema?.properties);
  const hasInteractiveProperty = Object.values(properties ?? {}).some(
    isThreadOpenAiFormInteractiveProperty,
  );
  return createThreadAgentActivityItem(item, hasInteractiveProperty ? "groupable" : "standalone");
}

function classifyThreadAutomaticApprovalReviewActivityItem<
  TItem extends ThreadClassifiableActivityItem,
>(item: TItem): ThreadAgentActivityClassification<TItem> {
  if (!("entry" in item)) return null;
  const status = resolveThreadAutomaticApprovalReviewStatus(item.entry);
  switch (status) {
    case "approved":
    case null:
      return null;
    case "inProgress":
      return createThreadAgentActivityItem(item, "groupable");
    case "aborted":
    case "denied":
    case "timedOut":
      return createThreadAgentActivityItem(item, "standalone");
  }
}

export function classifyThreadAgentActivityItem<TItem extends ThreadClassifiableActivityItem>(
  item: TItem,
  options: {
    mcpServerStatuses: ProtocolListMcpServerStatusResponse | null;
  } = { mcpServerStatuses: null },
): ThreadAgentActivityClassification<TItem> {
  switch (item.type) {
    case "exec":
    case "fileChange":
    case "webSearch":
      return classifyThreadExecPatchWebActivityItem(item as TItem & ThreadExecPatchWebActivityItem);
    case "mcpToolCall":
      return classifyThreadMcpActivityItem(
        item as TItem & ThreadMcpActivityItem,
        options.mcpServerStatuses,
      );
    case "dynamicToolCall":
      return classifyThreadDynamicActivityItem(item as TItem & ThreadDynamicActivityItem);
    case "mcpServerElicitation":
      return classifyThreadMcpServerElicitationActivityItem(item);
    case "automaticApprovalReview":
      return classifyThreadAutomaticApprovalReviewActivityItem(item);
    case "assistantMessage":
    case "autoReviewInterruptionWarning":
    case "contextCompaction":
    case "hook":
    case "imageView":
    case "multiAgentAction":
    case "realtimeTranscript":
    case "streamError":
    case "subagentActivityInlineGroup":
    case "systemError":
    case "userInputResponse":
    case "userMessage":
    case "workedFor":
    case "worktreeInit":
      return createThreadAgentActivityItem(item, "standalone");
    case "automationUpdate":
    case "forkedFromConversation":
    case "generatedImage":
    case "modelChanged":
    case "modelRerouted":
    case "permissionRequest":
    case "personalityChanged":
    case "planImplementation":
    case "proposedPlan":
    case "reasoning":
    case "remoteTaskCreated":
    case "steered":
    case "todoList":
    case "turnDiff":
    case "userInput":
      return null;
  }
}

const VISUALIZATION_PATH_PATTERN = /(?:^|[\\/])visualizations(?:[\\/"'\s;]|$)/i;
const VISUALIZATION_WRITE_PATTERN =
  /(?:^|\s)(?:apply_patch|mkdir|tee|touch|cp|mv|install)(?:\s|$)|(?:^|[^<])>>?/;
const VISUALIZATION_ADD_PATCH_PATTERN =
  /\*\*\* Add File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i;
const VISUALIZATION_UPDATE_PATCH_PATTERN =
  /\*\*\* Update File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i;
const VISUALIZATION_DELETE_PATCH_PATTERN =
  /\*\*\* Delete File:[^\r\n]*[\\/]visualizations(?:[\\/"'\s;]|$)/i;

export type ThreadVisualizationCommandKind = "create" | "update";

export function resolveThreadVisualizationCommandKind(
  command: string,
): ThreadVisualizationCommandKind | null {
  if (!VISUALIZATION_PATH_PATTERN.test(command) || !VISUALIZATION_WRITE_PATTERN.test(command)) {
    return null;
  }
  if (VISUALIZATION_ADD_PATCH_PATTERN.test(command)) return "create";
  if (VISUALIZATION_UPDATE_PATCH_PATTERN.test(command)) return "update";
  if (VISUALIZATION_DELETE_PATCH_PATTERN.test(command)) return null;
  return "create";
}

function isVisualizationPairableExecutionStatus(
  status: CodexConversationItem["executionStatus"],
): boolean {
  return status == null || status === "inProgress" || status === "completed";
}

function isThreadVisualizeSkillDefinitionRead(item: ThreadClassifiableActivityItem): boolean {
  if (item.type !== "exec" || !("entry" in item)) return false;
  const parsedCommand = item.entry.parsedCmd;
  if (parsedCommand?.type !== "read") return false;

  const path = resolveExplorationPath(parsedCommand.path ?? parsedCommand.name, item.entry.cwd);
  const skill = resolveExplorationSkillPathInfo(path);
  return skill?.skillId.toLowerCase() === "visualize" && skill.isSkillDefinitionFile;
}

export function shouldFilterThreadAgentActivitySourceItem(
  item: ThreadClassifiableActivityItem,
  nextItem: ThreadClassifiableActivityItem | undefined,
): boolean {
  if (item.type === "exec" && "entry" in item) {
    const parsedCommand = item.entry.parsedCmd;
    const isVisualizationPair =
      isVisualizationPairableExecutionStatus(item.entry.executionStatus) &&
      parsedCommand != null &&
      resolveThreadVisualizationCommandKind(parsedCommand.cmd) != null &&
      nextItem?.type === "fileChange" &&
      "entry" in nextItem &&
      (nextItem.entry.fileChange?.visualizationActivities?.length ?? 0) > 0;
    if (isVisualizationPair) return true;
  }

  return isThreadVisualizeSkillDefinitionRead(item);
}

export function projectThreadIndexedAgentActivityItems(
  sourceItems: readonly ThreadClassifiableActivityItem[],
  options: {
    mcpServerStatuses: ProtocolListMcpServerStatusResponse | null;
  } = { mcpServerStatuses: null },
): ThreadIndexedAgentActivityItem<ThreadClassifiableActivityItem>[] {
  return sourceItems.flatMap((item, sourceIndex) => {
    if (shouldFilterThreadAgentActivitySourceItem(item, sourceItems[sourceIndex + 1])) return [];
    const activityItem = classifyThreadAgentActivityItem(item, options);
    return activityItem == null ? [] : [{ activityItem, sourceIndex }];
  });
}

export function buildThreadAgentActivityUnits(
  indexedItems: readonly ThreadIndexedAgentActivityItem<ThreadClassifiableActivityItem>[],
): ThreadAgentActivityUnit<ThreadClassifiableActivityItem>[] {
  const units: ThreadAgentActivityUnit<ThreadClassifiableActivityItem>[] = [];
  let pendingGroup: ThreadAgentActivityItem<ThreadClassifiableActivityItem>[] = [];
  let pendingGroupSourceIndex = 0;

  const flushPendingGroup = () => {
    const firstItem = pendingGroup[0];
    if (firstItem == null) return;
    units.push({
      kind: "group",
      key: `agent-activity-group:${resolveThreadAgentActivityIdentity(firstItem, pendingGroupSourceIndex)}`,
      items: [firstItem, ...pendingGroup.slice(1)],
    });
    pendingGroup = [];
  };

  for (const { activityItem, sourceIndex } of indexedItems) {
    if (activityItem.grouping === "groupable") {
      if (pendingGroup.length === 0) pendingGroupSourceIndex = sourceIndex;
      pendingGroup.push(activityItem);
      continue;
    }

    flushPendingGroup();
    units.push({
      kind: "standalone",
      key: `agent-activity-standalone:${resolveThreadAgentActivityIdentity(activityItem, sourceIndex)}`,
      item: activityItem,
    });
  }

  flushPendingGroup();
  return units;
}

function shouldRenderThreadActivityItemInGroupBody(
  activityItem: ThreadAgentActivityItem<ThreadClassifiableActivityItem>,
  isTurnCancelled: boolean,
): boolean {
  const item = activityItem.item;
  if (!("entry" in item)) return true;
  if (item.type === "fileChange") {
    const activity = resolveCodexFileChangeActivity({
      status: item.entry.status,
      fileChange: item.entry.fileChange,
    });
    if (activity.hasMaterializedChanges) return true;
    const hasVisualization = activity.visualizationActivities.length > 0;
    if (!hasVisualization) return false;
    return (
      activity.success !== false &&
      (activity.success === true || item.entry.approvalRequestId != null || !isTurnCancelled)
    );
  }
  if (item.type !== "exec") return true;

  const parsedCommand = item.entry.parsedCmd;
  const isFinished =
    parsedCommand != null ? parsedCommand.isFinished : item.entry.status !== "inProgress";
  if (isFinished) return true;

  const firstAction = item.entry.commandActions?.[0];
  const actionType = parsedCommand?.type ?? firstAction?.type;
  if (actionType === "read") {
    const parsedReadPath =
      parsedCommand?.type === "read" ? (parsedCommand.path ?? parsedCommand.name) : undefined;
    const actionReadPath =
      firstAction?.type === "read" ? (firstAction.path ?? firstAction.name) : undefined;
    const path = resolveExplorationPath(parsedReadPath ?? actionReadPath, item.entry.cwd);
    return resolveExplorationSkillPathInfo(path)?.isSkillDefinitionFile === true;
  }
  return actionType !== "search" && actionType !== "list_files" && actionType !== "listFiles";
}

export function filterThreadAgentActivityGroupBodyItems(
  items: readonly ThreadAgentActivityItem<ThreadClassifiableActivityItem>[],
  isTurnCancelled: boolean,
): {
  items: ThreadAgentActivityItem<ThreadClassifiableActivityItem>[];
  canExpand: boolean;
} {
  const bodyItems = items.filter((item) =>
    shouldRenderThreadActivityItemInGroupBody(item, isTurnCancelled),
  );
  return {
    items: bodyItems,
    canExpand:
      bodyItems.length > 0 &&
      !bodyItems.every(
        (activityItem) =>
          activityItem.item.type === "dynamicToolCall" &&
          "entry" in activityItem.item &&
          isDynamicToolSummaryOnlyInConversationGroup(activityItem.item.entry.dynamicToolCall),
      ),
  };
}

export interface ThreadAgentActivityIdentityCandidates {
  id?: unknown;
  callId?: unknown;
  requestId?: unknown;
  handoffId?: unknown;
  type: string;
}

function resolveThreadAgentActivityBundleType(
  type: ThreadClassifiableActivityItem["type"],
): string {
  switch (type) {
    case "assistantMessage":
      return "assistant-message";
    case "autoReviewInterruptionWarning":
      return "auto-review-interruption-warning";
    case "automaticApprovalReview":
      return "automatic-approval-review";
    case "automationUpdate":
      return "automation-update";
    case "contextCompaction":
      return "context-compaction";
    case "dynamicToolCall":
      return "dynamic-tool-call";
    case "exec":
      return "exec";
    case "fileChange":
      return "patch";
    case "forkedFromConversation":
      return "forked-from-conversation";
    case "generatedImage":
      return "generated-image";
    case "imageView":
      return "image-view";
    case "mcpServerElicitation":
      return "mcp-server-elicitation";
    case "mcpToolCall":
      return "mcp-tool-call";
    case "modelChanged":
      return "model-changed";
    case "modelRerouted":
      return "model-rerouted";
    case "multiAgentAction":
      return "multi-agent-action";
    case "permissionRequest":
      return "permission-request";
    case "personalityChanged":
      return "personality-changed";
    case "planImplementation":
      return "plan-implementation";
    case "proposedPlan":
      return "proposed-plan";
    case "realtimeTranscript":
      return "realtime-transcript";
    case "reasoning":
      return "reasoning";
    case "remoteTaskCreated":
      return "remote-task-created";
    case "steered":
      return "steered";
    case "streamError":
      return "stream-error";
    case "subagentActivityInlineGroup":
      return "subagent-activity";
    case "systemError":
      return "system-error";
    case "todoList":
      return "todo-list";
    case "turnDiff":
      return "turn-diff";
    case "userInput":
      return "userInput";
    case "userInputResponse":
      return "user-input-response";
    case "userMessage":
      return "user-message";
    case "webSearch":
      return "web-search";
    case "workedFor":
      return "worked-for";
    case "worktreeInit":
      return "worktree-init";
  }
  return type;
}

const PROJECTED_ID_ACTIVITY_TYPES = new Set<ThreadClassifiableActivityItem["type"]>([
  "assistantMessage",
  "autoReviewInterruptionWarning",
  "automaticApprovalReview",
  "contextCompaction",
  "forkedFromConversation",
  "generatedImage",
  "imageView",
  "modelChanged",
  "modelRerouted",
  "multiAgentAction",
  "personalityChanged",
  "planImplementation",
  "realtimeTranscript",
  "reasoning",
  "remoteTaskCreated",
  "steered",
  "streamError",
  "subagentActivityInlineGroup",
  "systemError",
  "userMessage",
  "worktreeInit",
]);

export function resolveThreadAgentActivityIdentityCandidates(
  item: ThreadClassifiableActivityItem,
): ThreadAgentActivityIdentityCandidates {
  const entry = "entry" in item ? item.entry : null;
  const rawItem = asRecord(entry?.rawItem);
  // A single Agent message can project several independently interactive questions.
  const id =
    entry?.asyncQuestion?.id ??
    (PROJECTED_ID_ACTIVITY_TYPES.has(item.type) ? rawItem?.id : undefined);
  let callId: unknown;

  switch (item.type) {
    case "exec":
      callId = entry?.callId;
      break;
    case "fileChange":
      callId = entry?.itemId;
      break;
    case "mcpToolCall":
      callId = entry?.mcpToolCall?.callId;
      break;
    case "dynamicToolCall":
      callId = entry?.dynamicToolCall?.callId;
      break;
    case "automationUpdate":
      callId = entry?.automationUpdate?.callId;
      break;
    default:
      callId = rawItem?.callId;
      break;
  }

  return {
    type: resolveThreadAgentActivityBundleType(item.type),
    id,
    callId,
    requestId: entry?.requestId ?? rawItem?.requestId,
    handoffId: rawItem?.handoffId,
  };
}

export function resolveThreadAgentActivityIdentity(
  activityItem: ThreadAgentActivityItem<ThreadClassifiableActivityItem>,
  sourceIndex: number,
): string {
  const candidates = resolveThreadAgentActivityIdentityCandidates(activityItem.item);
  if (typeof candidates.id === "string") return candidates.id;
  if (typeof candidates.callId === "string") return candidates.callId;
  if (typeof candidates.requestId === "string") return candidates.requestId;
  if (typeof candidates.handoffId === "string") return candidates.handoffId;
  return `${candidates.type}:${sourceIndex}`;
}

export function collectThreadAgentActivityTargetIds(
  unit: ThreadAgentActivityUnit<ThreadClassifiableActivityItem>,
): string[] {
  const activityItems = unit.kind === "group" ? unit.items : [unit.item];
  return activityItems.flatMap(({ item }) => {
    const { id, callId } = resolveThreadAgentActivityIdentityCandidates(item);
    if (typeof id === "string") return [id];
    return typeof callId === "string" ? [callId] : [];
  });
}

export function buildThreadAgentActivityTargetAttribute(
  unit: ThreadAgentActivityUnit<ThreadClassifiableActivityItem>,
): Record<"data-local-conversation-item-target-ids", string> | undefined {
  const targetIds = collectThreadAgentActivityTargetIds(unit);
  if (targetIds.length === 0) return undefined;
  return {
    "data-local-conversation-item-target-ids": targetIds.map(encodeURIComponent).join(" "),
  };
}

export type ThreadAgentActivitySliceKind = "main" | "preToggle" | "persistent" | "postAssistant";

export interface ThreadAgentActivitySlice {
  kind: ThreadAgentActivitySliceKind;
  units: readonly ThreadAgentActivityUnit<ThreadClassifiableActivityItem>[];
  isActivitySliceClosed: boolean;
  isExploring: boolean;
}

export interface ThreadAgentActivityUnitContext {
  sliceKind: ThreadAgentActivitySliceKind;
  unit: ThreadAgentActivityUnit<ThreadClassifiableActivityItem>;
  unitIndex: number;
  isLatestVisibleUnit: boolean;
  isTurnInProgress: boolean;
  isTurnCancelled: boolean;
  isActivitySliceClosed: boolean;
  isActivitySliceOpen: boolean;
  isExploring: boolean;
}

export function resolveThreadPrimaryActivitySliceClosed(input: {
  hasRenderableAssistant: boolean;
  isTurnInProgress: boolean;
  keepOpenWhileStreaming: boolean;
}): boolean {
  return input.hasRenderableAssistant && (!input.isTurnInProgress || !input.keepOpenWhileStreaming);
}

export function buildThreadAgentActivityUnitContexts(input: {
  slices: readonly ThreadAgentActivitySlice[];
  isTurnInProgress: boolean;
  isTurnCancelled: boolean;
}): ThreadAgentActivityUnitContext[] {
  return input.slices.flatMap((slice) =>
    slice.units.map((unit, unitIndex) => ({
      sliceKind: slice.kind,
      unit,
      unitIndex,
      isLatestVisibleUnit: unitIndex === slice.units.length - 1,
      isTurnInProgress: input.isTurnInProgress,
      isTurnCancelled: input.isTurnCancelled,
      isActivitySliceClosed: slice.isActivitySliceClosed,
      isActivitySliceOpen: input.isTurnInProgress && !slice.isActivitySliceClosed,
      isExploring: slice.kind === "main" ? slice.isExploring : false,
    })),
  );
}
