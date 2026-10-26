import type {
  CodexCommandAction,
  CodexConversationItem,
  ProtocolAppInfo,
} from "../../../lib/types";
import {
  getCodexFileChangeEntries,
  resolveCodexPatchSuccess,
  summarizeCodexFileChangeLines,
} from "../../../../shared/codex-file-change";
import { normalizeAutomaticApprovalReviewPayload } from "../../../../shared/codex-transcript-special-items";
import { resolveCodexMcpVisualSource } from "../../../../shared/codex-mcp-tool-call";
import { isCodexWebSearchActivityInProgress } from "../../../../shared/codex-web-search";
import {
  extractCommandActions,
  isExplorationAction,
  normalizeExplorationPath,
  resolveExplorationPath,
  resolveExplorationSkillPathInfo,
} from "./tool-metadata/command-actions";
import {
  buildDynamicToolCallSummaryPartKey,
  resolveDynamicToolLabel,
} from "./tool-metadata/dynamic-tool-call-utils";
import { resolveMcpToolActivityLabel } from "./tool-metadata/mcp-tool-call-labels";
import {
  isCurlWebSearchCommand,
  resolveConversationCommandText,
} from "./tool-metadata/command-activity-classification";
import { describeWebSearchAction } from "../web-search-display";
import {
  buildThreadAgentActivityCompletedSummaryParts,
  buildThreadAgentActivityDynamicCompletedParts,
  collectThreadAgentActivitySummaryFacts,
  formatThreadAgentActivityGroupHeader,
  orderThreadAgentActivityMcpSources,
  selectThreadAgentActivityMcpIconItem,
  type ThreadAgentActivityApprovalFailure,
  type ThreadAgentActivityGroupState,
  type ThreadAgentActivityMcpItemEvidence,
  type ThreadAgentActivitySummaryFacts,
  type ThreadAgentActivitySummaryFact,
} from "./agent-activity-v2-summary";
import { resolveThreadVisualizationCommandKind } from "./agent-activity-v2";
import type {
  ThreadAgentActivityGroupBlockModel,
  ThreadAgentActivityGroupActiveSummary,
  ThreadAgentActivityCompletedSummaryPart,
  ThreadAgentActivityGroupEntryModel,
  ThreadAgentActivityGroupMcpSourceStats,
  ThreadAgentEntryModel,
  ThreadAgentItemModel,
  ThreadAgentRenderUnit,
  ThreadTranscriptBlockModel,
} from "../thread-stage-types";

type CommandExecutionBlock = ThreadTranscriptBlockModel & { type: "exec" };

type AutomaticApprovalReviewFailure = ThreadAgentActivityApprovalFailure;
type McpToolCallSummarySource = Omit<
  ThreadAgentActivityGroupMcpSourceStats,
  "count" | "runningCount"
>;
export type AgentActivityGroupSummaryFact = ThreadAgentActivitySummaryFact;

function isTranscriptBlock(
  block: ThreadAgentItemModel | ThreadAgentEntryModel,
): block is ThreadTranscriptBlockModel {
  return "entry" in block;
}

function isExplorationCommandBlock(
  block: ThreadTranscriptBlockModel,
): block is CommandExecutionBlock {
  if (block.type !== "exec") return false;
  const commandActions = extractCommandActions(block.entry);
  return commandActions.length > 0 && commandActions.every(isExplorationAction);
}

function buildSearchableTextFromActivityEntries(
  entries: ThreadAgentActivityGroupEntryModel[],
): string {
  return entries
    .map((entry) => entry.searchableText)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function getRawString(rawItem: unknown, keys: readonly string[]): string | null {
  const record = asRecord(rawItem);
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function getRecordString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const recordValue = record[key];
  return typeof recordValue === "string" && recordValue.length > 0 ? recordValue : null;
}

function getTrimmedRecordString(value: unknown, key: string): string | null {
  const raw = getRecordString(value, key)?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function resolveWebSearchSummaryDetail(entry: CodexConversationItem): string {
  const rawItem = asRecord(entry.rawItem);
  const action =
    rawItem && Object.prototype.hasOwnProperty.call(rawItem, "action")
      ? rawItem.action
      : entry.toolCall?.result;
  const fallbackQuery =
    getTrimmedRecordString(entry.toolCall?.args, "query") ??
    getTrimmedRecordString(rawItem, "query") ??
    "";
  return describeWebSearchAction(action, fallbackQuery).trim();
}

function formatActivePath(path: string | null | undefined): string {
  return normalizeExplorationPath(path)?.replace(/^\/+/, "") ?? path?.trim() ?? "";
}

function formatReadActiveSummary(
  action: Extract<CodexCommandAction, { type: "read" }>,
  cwd: string | null,
): string {
  const resolvedPath = resolveExplorationPath(action.path || action.name, cwd);
  const skillPathInfo = resolveExplorationSkillPathInfo(resolvedPath);
  if (skillPathInfo?.isSkillDefinitionFile === true)
    return `Reading ${skillPathInfo.skillName} skill`;

  const target = formatActivePath(action.path || action.name);
  return target.length > 0 ? `Reading ${target}` : "Reading";
}

function formatSearchActiveSummary(
  action: Extract<CodexCommandAction, { type: "search" }>,
): string {
  const folder = formatActivePath(action.path);
  if (folder.length > 0) return `Searching files in ${folder} folder`;

  const query = action.query?.trim();
  if (query && query.length > 0) return `Searching for ${query}`;
  return "Searching files";
}

function formatListFilesActiveSummary(
  action: Extract<CodexCommandAction, { type: "listFiles" }>,
): string {
  const folder = formatActivePath(action.path);
  return folder.length > 0 ? `Listing files in ${folder} folder` : "Listing files";
}

function formatExplorationActiveSummary(
  action: CodexCommandAction,
  cwd: string | null,
): string | null {
  if (action.type === "read") return formatReadActiveSummary(action, cwd);
  if (action.type === "search") return formatSearchActiveSummary(action);
  if (action.type === "listFiles") return formatListFilesActiveSummary(action);
  return null;
}

function resolveExplorationActiveSummary(
  entries: readonly CodexConversationItem[],
  inProgressOnly: boolean,
): ThreadAgentActivityGroupActiveSummary | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    if (!entry) continue;
    if (inProgressOnly && entry.status !== "inProgress") continue;

    const actions = extractCommandActions(entry);
    for (let actionIndex = actions.length - 1; actionIndex >= 0; actionIndex -= 1) {
      const action = actions[actionIndex];
      if (!action) continue;
      const label = formatExplorationActiveSummary(action, entry.cwd ?? null);
      if (!label) continue;
      return {
        kind: "text",
        key: resolveConversationItemKeyId(entry) ?? `exploration:${entryIndex}:${actionIndex}`,
        label,
      };
    }
  }

  return null;
}

function isPatchActivityActive(entry: ThreadTranscriptBlockModel): boolean {
  return resolveCodexPatchSuccess(entry.status) === null;
}

function resolvePatchActiveSummary(
  entry: ThreadTranscriptBlockModel,
): ThreadAgentActivityGroupActiveSummary | null {
  return {
    kind: "text",
    key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
    label: "Editing files",
  };
}

function resolveWebSearchActiveSummary(
  entries: readonly ThreadTranscriptBlockModel[],
  inProgressOnly: boolean,
): ThreadAgentActivityGroupActiveSummary | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (inProgressOnly && !isCodexWebSearchActivityInProgress(entry.entry)) continue;

    const detail = resolveWebSearchSummaryDetail(entry.entry);
    return {
      kind: "text",
      key: `web-search:${index}`,
      label: detail.length > 0 ? `Searching the web for ${detail}` : "Searching the web",
    };
  }

  return null;
}

function resolveExecActiveSummary(
  entry: ThreadTranscriptBlockModel,
): ThreadAgentActivityGroupActiveSummary | null {
  const explorationSummary = resolveExplorationActiveSummary([entry.entry], false);
  if (explorationSummary) return explorationSummary;

  const command = resolveConversationCommandText(entry.entry);
  if (entry.status === "interrupted") {
    return {
      kind: "text",
      key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
      label: command ? `Stopped ${command}` : "Stopped command",
    };
  }

  return {
    kind: "text",
    key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
    label: command ? `Running ${command}` : "Running command",
  };
}

function resolveAutomaticApprovalReviewActiveSummary(
  entry: ThreadTranscriptBlockModel,
): ThreadAgentActivityGroupActiveSummary | null {
  const status = getAutomaticApprovalReviewStatus(entry.entry) ?? entry.status;
  if (status === "approved") {
    return {
      kind: "text",
      key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
      label: "Approved request",
    };
  }
  if (status === "denied") {
    return {
      kind: "text",
      key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
      label: "Denied request",
    };
  }
  if (status === "inProgress") {
    return {
      kind: "text",
      key: resolveConversationItemKeyId(entry.entry) ?? entry.id,
      label: "Thinking",
    };
  }
  return null;
}

function resolveMcpActiveSummary(
  entry: ThreadTranscriptBlockModel,
  resolvedApps: readonly ProtocolAppInfo[],
): ThreadAgentActivityGroupActiveSummary | null {
  const payload = entry.entry.mcpToolCall;
  if (!payload) return null;
  return {
    kind: "text",
    key: payload.callId,
    label: resolveMcpToolActivityLabel({
      payload,
      resolvedApps,
      completed: false,
    }),
  };
}

function resolveDynamicActiveSummary(
  entry: ThreadTranscriptBlockModel,
): ThreadAgentActivityGroupActiveSummary | null {
  if (!entry.entry.dynamicToolCall) return null;
  return {
    kind: "text",
    key: entry.entry.dynamicToolCall.callId,
    label: resolveDynamicToolLabel(entry.entry),
  };
}

function isCollapsedActivityEntryActive(entry: ThreadAgentActivityGroupEntryModel): boolean {
  if (entry.type === "fileChange") return isPatchActivityActive(entry);
  if (entry.type === "webSearch") return isCodexWebSearchActivityInProgress(entry.entry);
  if (entry.type === "exec") return entry.status === "inProgress";
  if (entry.type === "mcpToolCall") return entry.entry.mcpToolCall?.completed === false;
  if (entry.type === "dynamicToolCall") return entry.entry.dynamicToolCall?.completed === false;
  if (entry.type === "automaticApprovalReview") {
    return (getAutomaticApprovalReviewStatus(entry.entry) ?? entry.status) === "inProgress";
  }
  return false;
}

function resolveCollapsedActivityActiveSummaryPass(
  entries: readonly ThreadAgentActivityGroupEntryModel[],
  inProgressOnly: boolean,
  resolvedApps: readonly ProtocolAppInfo[],
): ThreadAgentActivityGroupActiveSummary | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (inProgressOnly && !isCollapsedActivityEntryActive(entry)) continue;

    if (entry.type === "fileChange") {
      const summary = resolvePatchActiveSummary(entry);
      if (summary) return summary;
      continue;
    }
    if (entry.type === "webSearch") {
      const summary = resolveWebSearchActiveSummary([entry], inProgressOnly);
      if (summary) return summary;
      continue;
    }
    if (entry.type === "exec") return resolveExecActiveSummary(entry);
    if (entry.type === "mcpToolCall") return resolveMcpActiveSummary(entry, resolvedApps);
    if (entry.type === "dynamicToolCall") return resolveDynamicActiveSummary(entry);
    if (entry.type === "automaticApprovalReview") {
      const summary = resolveAutomaticApprovalReviewActiveSummary(entry);
      if (summary) return summary;
    }
  }

  return null;
}

export function resolveAgentActivityGroupActiveSummary(
  entries: readonly ThreadAgentActivityGroupEntryModel[],
  resolvedApps: readonly ProtocolAppInfo[] = [],
): ThreadAgentActivityGroupActiveSummary | null {
  return resolveCollapsedActivityActiveSummaryPass(entries, true, resolvedApps);
}

function resolveConversationItemKeyId(entry: CodexConversationItem): string | null {
  if (entry.callId) return entry.callId;
  const rawId = getRawString(entry.rawItem, ["id", "callId", "call_id"]);
  if (rawId) return rawId;
  if (entry.mcpToolCall?.callId) return entry.mcpToolCall.callId;
  if (entry.dynamicToolCall?.callId) return entry.dynamicToolCall.callId;
  return entry.itemId || entry.entryId || null;
}

function resolveTranscriptBlockItemType(block: ThreadTranscriptBlockModel): string {
  switch (block.type) {
    case "userMessage":
      return "user-message";
    case "assistantMessage":
      return "assistant-message";
    case "todoList":
      return "todo-list";
    case "proposedPlan":
      return "proposed-plan";
    case "fileChange":
      return "patch";
    case "turnDiff":
      return "turn-diff";
    case "mcpToolCall":
      return "mcp-tool-call";
    case "dynamicToolCall":
      return "dynamic-tool-call";
    case "webSearch":
      return "web-search";
    case "mcpServerElicitation":
      return "mcp-server-elicitation";
    case "streamError":
      return "stream-error";
    case "systemError":
      return "system-error";
    case "remoteTaskCreated":
      return "remote-task-created";
    case "personalityChanged":
      return "personality-changed";
    case "forkedFromConversation":
      return "forked-from-conversation";
    case "modelChanged":
      return "model-changed";
    case "modelRerouted":
      return "model-rerouted";
    case "contextCompaction":
      return "context-compaction";
    case "worktreeInit":
      return "worktree-init";
    case "automaticApprovalReview":
      return "automatic-approval-review";
    case "autoReviewInterruptionWarning":
      return "auto-review-interruption-warning";
    case "multiAgentAction":
      return "multi-agent-action";
    case "subagentActivityInlineGroup":
      return "subagent-activity-inline-group";
    case "userInputResponse":
      return "user-input-response";
    case "planImplementation":
      return "plan-implementation";
    default:
      return block.type;
  }
}

function resolveTranscriptBlockRenderKey(block: ThreadTranscriptBlockModel, index: number): string {
  const itemType = resolveTranscriptBlockItemType(block);
  const itemId = resolveConversationItemKeyId(block.entry);
  return `item:${itemType}:${itemId ?? index}`;
}

function resolveAgentEntryBlockRenderKey(block: ThreadAgentEntryModel, index: number): string {
  if (block.type === "workedFor") return `item:worked-for:${block.id || index}`;
  if ("entry" in block) return resolveTranscriptBlockRenderKey(block, index);
  return block.renderKey ?? `${block.type}:${block.id || index}`;
}

export function resolveAgentRenderUnitKey(unit: ThreadAgentRenderUnit, index: number): string {
  if (unit.kind === "agentActivityGroup") {
    const seed = unit.block.entries[0];
    const seedKey =
      seed?.renderKey ?? (seed ? resolveAgentEntryBlockRenderKey(seed, index) : `unknown-${index}`);
    return `agent-activity-group:${seedKey}:${index}`;
  }
  return resolveAgentEntryBlockRenderKey(unit.block, index);
}

function withRenderKey<TBlock extends ThreadAgentEntryModel>(
  block: TBlock,
  renderKey: string,
): TBlock {
  return {
    ...block,
    renderKey,
  };
}

export function materializeAgentRenderUnits(
  units: ThreadAgentRenderUnit[],
): ThreadAgentEntryModel[] {
  return units.map((unit, index) =>
    unit.block.renderKey
      ? unit.block
      : withRenderKey(unit.block, resolveAgentRenderUnitKey(unit, index)),
  );
}

function mergeActivityStatus(
  entries: ThreadAgentActivityGroupEntryModel[],
): CodexConversationItem["status"] {
  const statuses = entries
    .map((entry) => entry.status)
    .filter(
      (status): status is NonNullable<CodexConversationItem["status"]> => status !== undefined,
    );
  if (statuses.length === 0) return undefined;
  if (statuses.includes("inProgress")) return "inProgress";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("declined")) return "declined";
  return "completed";
}

function buildExplorationSummaryFact(
  entries: readonly CodexConversationItem[],
  automaticApprovalReviews: readonly CodexConversationItem[] = [],
): AgentActivityGroupSummaryFact {
  const readPaths = new Set<string>();
  const runningReadPaths = new Set<string>();
  const loadedToolPaths = new Set<string>();
  const runningLoadedToolPaths = new Set<string>();
  const automaticApprovalReviewFailures =
    buildAutomaticApprovalReviewFailures(automaticApprovalReviews);
  let searchCount = 0;
  let runningSearchCount = 0;
  let listCount = 0;
  let runningListCount = 0;

  for (const entry of entries) {
    const isRunning = entry.status === "inProgress";
    for (const action of extractCommandActions(entry)) {
      if (action.type === "read") {
        const path = resolveExplorationPath(action.path || action.name, entry.cwd ?? null);
        if (!path) continue;
        const skillPathInfo = resolveExplorationSkillPathInfo(path);
        if (skillPathInfo?.isSkillDefinitionFile === true) {
          loadedToolPaths.add(path);
          if (isRunning) runningLoadedToolPaths.add(path);
          continue;
        }
        readPaths.add(path);
        if (isRunning) runningReadPaths.add(path);
        continue;
      }
      if (action.type === "search") {
        searchCount += 1;
        if (isRunning) runningSearchCount += 1;
        continue;
      }
      if (action.type === "listFiles") {
        listCount += 1;
        if (isRunning) runningListCount += 1;
      }
    }
  }

  return {
    type: "exploration",
    readPaths,
    runningReadPaths,
    loadedToolPaths,
    runningLoadedToolPaths,
    searchCount,
    runningSearchCount,
    listCount,
    runningListCount,
    ...(automaticApprovalReviewFailures.length > 0 ? { automaticApprovalReviewFailures } : {}),
  };
}

function countContentLines(content: string): number {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized.length === 0) return 0;
  const lines = normalized.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function buildAutomaticApprovalReviewFailures(
  reviews: readonly CodexConversationItem[],
): AutomaticApprovalReviewFailure[] {
  const failures: AutomaticApprovalReviewFailure[] = [];
  for (const review of reviews) {
    const reviewStatus = getAutomaticApprovalReviewStatus(review) ?? review.status;
    if (reviewStatus !== "denied" && reviewStatus !== "timedOut") continue;
    const reviewId =
      (resolveConversationItemKeyId(review) ?? review.itemId) || review.entryId || review.type;
    failures.push({
      id: reviewId,
      status: reviewStatus,
    });
  }
  return failures;
}

function buildPatchSummaryFact(entry: ThreadTranscriptBlockModel): AgentActivityGroupSummaryFact {
  const automaticApprovalReviewFailures = buildAutomaticApprovalReviewFailures(
    entry.automaticApprovalReviews ?? [],
  );
  const changes = getCodexFileChangeEntries(entry.entry.fileChange?.changes);
  const createdPaths = new Set<string>();
  const runningCreatedPaths = new Set<string>();
  const stoppedCreatedPaths = new Set<string>();
  const editedPaths = new Set<string>();
  const runningEditedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const runningDeletedPaths = new Set<string>();
  let runningCreatedLineCount = 0;
  let changedLineCount = 0;

  const isRunning = entry.status === "inProgress";
  const isStopped = isRunning && entry.isTurnCancelled === true;
  for (const [path, change] of changes) {
    const diffStats = summarizeCodexFileChangeLines(path, change);
    changedLineCount += (diffStats?.additions ?? 0) + (diffStats?.deletions ?? 0);

    if (change.type === "add") {
      createdPaths.add(path);
      if (isStopped) {
        stoppedCreatedPaths.add(path);
        continue;
      }
      if (isRunning) {
        runningCreatedPaths.add(path);
        runningCreatedLineCount += countContentLines(change.content);
      }
      continue;
    }
    if (change.type === "delete") {
      deletedPaths.add(path);
      if (isRunning) runningDeletedPaths.add(path);
      continue;
    }
    editedPaths.add(path);
    if (isRunning) runningEditedPaths.add(path);
  }

  const visualizationActivities = entry.entry.fileChange?.visualizationActivities;
  const visualizationActivity =
    visualizationActivities != null &&
    visualizationActivities.length > 0 &&
    entry.status !== "failed" &&
    entry.status !== "declined" &&
    entry.status !== "interrupted"
      ? {
          activities: visualizationActivities.flatMap((activity) => {
            const path = normalizeExplorationPath(activity.path);
            return path == null ? [] : [{ path, kind: activity.kind }];
          }),
          isInProgress: entry.status === "inProgress",
        }
      : undefined;

  return {
    type: "patch",
    createdPaths,
    runningCreatedPaths,
    stoppedCreatedPaths,
    runningCreatedLineCount,
    changedLineCount,
    editedPaths,
    runningEditedPaths,
    deletedPaths,
    runningDeletedPaths,
    ...(visualizationActivity ? { visualizationActivity } : {}),
    ...(automaticApprovalReviewFailures.length > 0 ? { automaticApprovalReviewFailures } : {}),
  };
}

function getAutomaticApprovalReviewStatus(entry: CodexConversationItem): string | null {
  return normalizeAutomaticApprovalReviewPayload(entry.rawItem)?.status ?? null;
}

function resolveMcpToolCallSummarySource(
  entry: CodexConversationItem,
  resolvedApps: readonly ProtocolAppInfo[],
): McpToolCallSummarySource | null {
  const payload = entry.mcpToolCall;
  if (!payload) return null;
  return resolveCodexMcpVisualSource({
    functionName: payload.functionName,
    invocation: payload.invocation,
    resolvedApps,
    source: payload.source,
  });
}

export function buildAgentActivityGroupSummaryFact(
  entry: ThreadAgentActivityGroupEntryModel,
  resolvedApps: readonly ProtocolAppInfo[] = [],
): AgentActivityGroupSummaryFact {
  if (entry.type === "fileChange") return buildPatchSummaryFact(entry);
  if (entry.type === "exec") {
    if (isExplorationCommandBlock(entry)) {
      return buildExplorationSummaryFact([entry.entry], entry.automaticApprovalReviews);
    }
    const isInProgress = entry.status === "inProgress";
    const command = resolveConversationCommandText(entry.entry);
    const automaticApprovalReviewFailures = buildAutomaticApprovalReviewFailures(
      entry.automaticApprovalReviews ?? [],
    );
    return {
      type: "exec",
      isInProgress,
      ...(command && resolveThreadVisualizationCommandKind(command) != null
        ? { visualizationActivityKind: resolveThreadVisualizationCommandKind(command) ?? undefined }
        : {}),
      ...(command && /^\s*mkdir(?:\s|$)/.test(command) ? { createsFolder: true } : {}),
      ...(command && isCurlWebSearchCommand(command) && (isInProgress || entry.entry.exitCode === 0)
        ? { searchesWeb: true }
        : {}),
      ...(automaticApprovalReviewFailures.length > 0 ? { automaticApprovalReviewFailures } : {}),
    };
  }
  if (entry.type === "automaticApprovalReview") {
    const [failure] = buildAutomaticApprovalReviewFailures([entry.entry]);
    return failure
      ? { type: "automaticApprovalReview", id: failure.id, status: failure.status }
      : { type: "other" };
  }
  if (entry.type === "mcpToolCall") {
    const automaticApprovalReviewFailures = buildAutomaticApprovalReviewFailures(
      entry.automaticApprovalReviews ?? [],
    );
    return {
      type: "mcpToolCall",
      isInProgress: entry.entry.mcpToolCall?.completed === false,
      source: resolveMcpToolCallSummarySource(entry.entry, resolvedApps),
      ...(automaticApprovalReviewFailures.length > 0 ? { automaticApprovalReviewFailures } : {}),
    };
  }
  if (entry.type === "webSearch") {
    return {
      type: "webSearch",
      count: 1,
      runningCount: isCodexWebSearchActivityInProgress(entry.entry) ? 1 : 0,
    };
  }
  return { type: "other" };
}

export function collectAgentActivityGroupCanonicalFacts(
  entries: ThreadAgentActivityGroupEntryModel[],
  resolvedApps: readonly ProtocolAppInfo[] = [],
): ThreadAgentActivitySummaryFacts {
  return collectThreadAgentActivitySummaryFacts(
    entries.map((entry) => buildAgentActivityGroupSummaryFact(entry, resolvedApps)),
  );
}

function isLoadedToolEntry(entry: ThreadAgentActivityGroupEntryModel): boolean {
  if (!isExplorationCommandBlock(entry)) return false;
  return extractCommandActions(entry.entry).some((action) => {
    if (action.type !== "read") return false;
    const path = resolveExplorationPath(action.path || action.name, entry.entry.cwd ?? null);
    return resolveExplorationSkillPathInfo(path)?.isSkillDefinitionFile === true;
  });
}

function isVisualizationEntry(entry: ThreadAgentActivityGroupEntryModel): boolean {
  if (entry.type === "fileChange") {
    return (entry.entry.fileChange?.visualizationActivities?.length ?? 0) > 0;
  }
  if (entry.type !== "exec") return false;
  const command = resolveConversationCommandText(entry.entry);
  return command != null && resolveThreadVisualizationCommandKind(command) != null;
}

function isWebSearchEntry(entry: ThreadAgentActivityGroupEntryModel): boolean {
  if (entry.type === "webSearch") return true;
  if (entry.type !== "exec") return false;
  const command = resolveConversationCommandText(entry.entry);
  return command != null && isCurlWebSearchCommand(command);
}

function selectCompletedHeaderIconItem(
  firstPart: ThreadAgentActivityCompletedSummaryPart | undefined,
  entries: readonly ThreadAgentActivityGroupEntryModel[],
  mcpItemEvidence: readonly ThreadAgentActivityMcpItemEvidence<ThreadAgentActivityGroupEntryModel>[],
): ThreadAgentActivityGroupEntryModel | null {
  if (firstPart == null) return null;
  if (firstPart.kind === "mcpSources" || firstPart.kind === "unnamedMcpCalls") {
    return selectThreadAgentActivityMcpIconItem(firstPart, mcpItemEvidence);
  }
  if (firstPart.kind === "dynamicToolCall") return firstPart.item;
  if (firstPart.kind === "loadedTools") return entries.find(isLoadedToolEntry) ?? null;
  if (firstPart.kind === "fileChanges" || firstPart.kind === "stoppedFileCreation") {
    return entries.find((entry) => entry.type === "fileChange") ?? null;
  }
  if (firstPart.kind === "exploration") return entries.find(isExplorationCommandBlock) ?? null;
  if (firstPart.kind === "visualization") return entries.find(isVisualizationEntry) ?? null;
  if (firstPart.kind === "commands") return entries.find((entry) => entry.type === "exec") ?? null;
  if (firstPart.kind === "webSearch") return entries.find(isWebSearchEntry) ?? null;
  return null;
}

function buildAgentActivityGroupHeader(input: {
  state: ThreadAgentActivityGroupState;
  thinkingFallbackMessage: string | null;
  resolvedApps: readonly ProtocolAppInfo[];
}): ThreadAgentActivityGroupBlockModel["header"] {
  if (input.state.kind === "summary") return { kind: "summary", key: "summary" };
  if (input.state.kind === "thinking") {
    return {
      kind: "thinking",
      key: "thinking",
      message: input.thinkingFallbackMessage,
    };
  }

  const item = input.state.item.item;
  if (!("entry" in item)) {
    throw new Error("A group active header requires a transcript activity item");
  }
  const activeSummary = resolveAgentActivityGroupActiveSummary([item], input.resolvedApps);
  const label = formatThreadAgentActivityGroupHeader({
    state: input.state,
    completedParts: [],
    activeExplorationLabel: activeSummary?.label,
    formatMcpToolCall: () => activeSummary?.label ?? null,
    formatDynamicToolCall: () => activeSummary?.label ?? null,
  });
  return {
    kind: "active",
    key: activeSummary?.key ?? item.id,
    item,
    label,
  };
}

export function buildV2AgentActivityGroupBlock(
  entries: ThreadAgentActivityGroupEntryModel[],
  renderKey: string,
  options: {
    bodyEntries?: ThreadAgentActivityGroupEntryModel[];
    canExpand?: boolean;
    resolvedApps?: readonly ProtocolAppInfo[];
    state?: ThreadAgentActivityGroupState;
    thinkingFallbackMessage?: string | null;
    shouldAnimateInitialCollapse?: boolean;
  } = {},
): ThreadAgentActivityGroupBlockModel {
  const seed = entries[0];
  if (!seed) {
    throw new Error("A v2 activity group must contain at least one renderer entry");
  }
  const resolvedApps = options.resolvedApps ?? [];
  const facts = collectAgentActivityGroupCanonicalFacts(entries, resolvedApps);
  const mcpItemEvidence = entries.flatMap((entry) => {
    if (entry.type !== "mcpToolCall" || entry.entry.mcpToolCall == null) return [];
    const source = resolveMcpToolCallSummarySource(entry.entry, resolvedApps);
    const payload = entry.entry.mcpToolCall;
    return [
      {
        item: entry,
        sourceKey: source?.key ?? null,
        server: payload.invocation.server,
        visuallyIdentified:
          source?.logoUrl != null ||
          source?.logoUrlDark != null ||
          source?.nativeAppReference != null ||
          (payload.mcpAppResourceUri != null && payload.pluginId != null),
      },
    ];
  });
  const orderedMcpSources = orderThreadAgentActivityMcpSources(
    facts.mcpToolCallSources,
    mcpItemEvidence,
  );
  const dynamicParts = buildThreadAgentActivityDynamicCompletedParts(
    entries.flatMap((entry) =>
      entry.type === "dynamicToolCall"
        ? [
            {
              item: entry,
              key: buildDynamicToolCallSummaryPartKey(entry.entry.dynamicToolCall),
            },
          ]
        : [],
    ),
  );
  const completedParts = buildThreadAgentActivityCompletedSummaryParts(facts, {
    orderedMcpSources,
    dynamicParts,
  });
  const completedHeader = {
    parts: completedParts,
    iconItem: selectCompletedHeaderIconItem(completedParts[0], entries, mcpItemEvidence),
  };
  const state = options.state ?? { kind: "summary" as const };
  const header = buildAgentActivityGroupHeader({
    state,
    thinkingFallbackMessage: options.thinkingFallbackMessage ?? null,
    resolvedApps,
  });

  return {
    id: `${seed.id}::agent-activity-group`,
    renderKey,
    turnId: seed.turnId,
    createdAt: seed.createdAt,
    updatedAt: Math.max(...entries.map((entry) => entry.updatedAt)),
    searchableText: buildSearchableTextFromActivityEntries(entries),
    type: "agentActivityGroup",
    entries,
    bodyEntries: options.bodyEntries ?? entries,
    completedHeader,
    header,
    mcpApps: resolvedApps,
    canExpand: options.canExpand ?? entries.length > 0,
    shouldAnimateInitialCollapse: options.shouldAnimateInitialCollapse ?? false,
    status: mergeActivityStatus(entries),
  };
}

function getAutomaticApprovalReviewTargetItemId(entry: CodexConversationItem): string | null {
  return normalizeAutomaticApprovalReviewPayload(entry.rawItem)?.targetItemId ?? null;
}

function resolveAutomaticApprovalTargetKey(entry: ThreadTranscriptBlockModel): string | null {
  if (entry.type === "exec") {
    return entry.entry.commandExecutionItemId ?? entry.entry.callId ?? null;
  }
  if (entry.type === "fileChange") return entry.entry.callId ?? null;
  if (entry.type === "mcpToolCall") return entry.entry.mcpToolCall?.callId ?? null;
  return null;
}

export function attachAutomaticApprovalReviewsToToolTargets(
  entries: ThreadAgentEntryModel[],
): ThreadAgentEntryModel[] {
  const targetKeys = new Set<string>();
  for (const entry of entries) {
    if (!isTranscriptBlock(entry)) continue;
    const key = resolveAutomaticApprovalTargetKey(entry);
    if (key) targetKeys.add(key);
  }
  if (targetKeys.size === 0) return entries;

  const reviewsByTarget = new Map<string, CodexConversationItem[]>();
  const consumedReviewIds = new Set<string>();
  for (const entry of entries) {
    if (!isTranscriptBlock(entry) || entry.type !== "automaticApprovalReview") continue;
    const targetItemId = getAutomaticApprovalReviewTargetItemId(entry.entry);
    if (!targetItemId || !targetKeys.has(targetItemId)) continue;
    const reviews = reviewsByTarget.get(targetItemId) ?? [];
    reviews.push(entry.entry);
    reviewsByTarget.set(targetItemId, reviews);
    consumedReviewIds.add(entry.id);
  }

  if (consumedReviewIds.size === 0) return entries;

  const attachedEntries: ThreadAgentEntryModel[] = [];
  for (const entry of entries) {
    if (consumedReviewIds.has(entry.id)) continue;
    if (!isTranscriptBlock(entry)) {
      attachedEntries.push(entry);
      continue;
    }
    const targetKey = resolveAutomaticApprovalTargetKey(entry);
    const reviews = targetKey ? (reviewsByTarget.get(targetKey) ?? []) : [];
    if (reviews.length === 0) {
      attachedEntries.push(entry);
      continue;
    }
    attachedEntries.push({
      ...entry,
      automaticApprovalReviews: [...(entry.automaticApprovalReviews ?? []), ...reviews],
    });
  }

  return attachedEntries;
}
