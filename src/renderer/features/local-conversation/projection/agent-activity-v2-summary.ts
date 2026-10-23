import type {
  ThreadAgentActivityCompletedSummaryPart,
  ThreadAgentActivityGroupMcpSourceStats,
} from "../thread-stage-types";
import type { ThreadAgentActivityItem, ThreadAgentActivityUnit } from "../thread-stage-types";
import {
  normalizeAutomaticApprovalReviewPayload,
  type CodexAutomaticApprovalReviewStatus,
} from "../../../../shared/codex-transcript-special-items";
import { resolveCodexPatchSuccess } from "../../../../shared/codex-file-change";
import { isCodexWebSearchActivityInProgress } from "../../../../shared/codex-web-search";
import { type ThreadClassifiableActivityItem } from "./agent-activity-v2";
import { describeWebSearchAction } from "../web-search-display";
import { isDelegatedTaskLive } from "../delegated-task-presentation";

export type ThreadAgentActivityApprovalFailure = {
  id: string;
  status: Extract<CodexAutomaticApprovalReviewStatus, "denied" | "timedOut">;
};

interface ThreadAgentActivityFactWithApprovalFailures {
  automaticApprovalReviewFailures?: readonly ThreadAgentActivityApprovalFailure[];
}

export type ThreadAgentActivityVisualizationKind = "create" | "update";

export type ThreadAgentActivitySummaryFact =
  | ({
      type: "exploration";
      readPaths: ReadonlySet<string>;
      runningReadPaths: ReadonlySet<string>;
      loadedToolPaths: ReadonlySet<string>;
      runningLoadedToolPaths: ReadonlySet<string>;
      searchCount: number;
      runningSearchCount: number;
      listCount: number;
      runningListCount: number;
    } & ThreadAgentActivityFactWithApprovalFailures)
  | ({
      type: "patch";
      createdPaths: ReadonlySet<string>;
      runningCreatedPaths: ReadonlySet<string>;
      stoppedCreatedPaths: ReadonlySet<string>;
      runningCreatedLineCount: number;
      changedLineCount: number;
      editedPaths: ReadonlySet<string>;
      runningEditedPaths: ReadonlySet<string>;
      deletedPaths: ReadonlySet<string>;
      runningDeletedPaths: ReadonlySet<string>;
      visualizationActivity?: {
        activities: readonly { path: string; kind: ThreadAgentActivityVisualizationKind }[];
        isInProgress: boolean;
      };
    } & ThreadAgentActivityFactWithApprovalFailures)
  | ({
      type: "exec";
      isInProgress: boolean;
      createsFolder?: true;
      searchesWeb?: true;
      visualizationActivityKind?: ThreadAgentActivityVisualizationKind;
    } & ThreadAgentActivityFactWithApprovalFailures)
  | ({
      type: "mcpToolCall";
      isInProgress: boolean;
      source: Omit<ThreadAgentActivityGroupMcpSourceStats, "count" | "runningCount"> | null;
    } & ThreadAgentActivityFactWithApprovalFailures)
  | (ThreadAgentActivityApprovalFailure & { type: "automaticApprovalReview" })
  | { type: "webSearch"; count: number; runningCount: number }
  | { type: "other" };

export interface ThreadAgentActivitySummaryFacts {
  createdFileCount: number;
  runningCreatedFileCount: number;
  stoppedCreatedFileCount: number;
  runningCreatedLineCount: number;
  changedLineCount: number;
  editedFileCount: number;
  runningEditedFileCount: number;
  deletedFileCount: number;
  runningDeletedFileCount: number;
  exploredFileCount: number;
  runningExploredFileCount: number;
  loadedToolCount: number;
  runningLoadedToolCount: number;
  searchCount: number;
  runningSearchCount: number;
  listCount: number;
  runningListCount: number;
  deniedRequestCount: number;
  timedOutRequestCount: number;
  commandCount: number;
  runningCommandCount: number;
  completedWebSearchCommandCount: number;
  runningFolderCreationCommandCount: number;
  visualizationActivity?: {
    kind: ThreadAgentActivityVisualizationKind;
    isInProgress: boolean;
  };
  completedVisualizationCommandCount: number;
  runningVisualizationCommandCount: number;
  runningWebSearchCommandCount: number;
  mcpToolCallCount: number;
  mcpToolCallSources: ThreadAgentActivityGroupMcpSourceStats[];
  webSearchCount: number;
  runningWebSearchCount: number;
}

const NODE_REPL_MCP_SOURCE_KEY = "server:node_repl";
const BROWSER_USE_MCP_SOURCE_KEY = "browser-use";
const NON_INTEGRATION_MCP_SOURCE_KEY = "navigate_to_codex_page";

export interface ThreadAgentActivityMcpItemEvidence<TItem = unknown> {
  item: TItem;
  sourceKey: string | null;
  server: string;
  visuallyIdentified: boolean;
}

export interface ThreadAgentActivityMcpSourcesWording {
  names: string[];
  sourceCount: number;
  subject: "integrations" | "sources";
}

export interface ThreadAgentActivityDynamicCompletedEvidence<TItem = unknown> {
  item: TItem;
  key: string;
}

export type ThreadAgentActivityGroupState<TItem = ThreadClassifiableActivityItem> =
  | { kind: "summary" }
  | { kind: "thinking" }
  | { kind: "active"; item: ThreadAgentActivityItem<TItem> };

export function isThreadExplorationActivityItem(item: ThreadClassifiableActivityItem): boolean {
  if (item.type !== "exec" || !("entry" in item)) return false;
  const parsedType = item.entry.parsedCmd?.type;
  if (parsedType === "read" || parsedType === "search" || parsedType === "list_files") return true;
  const actions = item.entry.commandActions ?? [];
  return (
    actions.length > 0 &&
    actions.every(
      (action) => action.type === "read" || action.type === "search" || action.type === "listFiles",
    )
  );
}

export function isThreadAgentActivityItemInProgress(
  activityItem: ThreadAgentActivityItem<ThreadClassifiableActivityItem>,
): boolean {
  const item = activityItem.item;
  if (!("entry" in item)) return item.status === "working";
  switch (item.type) {
    case "delegatedTask":
      return (item.delegatedTaskEntries ?? [item.entry]).some(
        (entry) => entry.delegatedTask && isDelegatedTaskLive(entry.delegatedTask.status),
      );
    case "exec":
      return (
        item.entry.executionStatus !== "interrupted" &&
        (item.entry.parsedCmd != null
          ? item.entry.parsedCmd.isFinished === false
          : item.entry.status === "inProgress")
      );
    case "automaticApprovalReview":
      return normalizeAutomaticApprovalReviewPayload(item.entry.rawItem)?.status === "inProgress";
    case "dynamicToolCall":
      return item.entry.dynamicToolCall?.completed === false;
    case "mcpToolCall":
      return item.entry.mcpToolCall?.completed === false;
    case "webSearch":
      return isCodexWebSearchActivityInProgress(item.entry);
    case "fileChange":
      return resolveCodexPatchSuccess(item.entry.status) === null;
    default:
      return item.entry.status === "inProgress";
  }
}

function selectThreadExplorationActivityItem(
  unit: Extract<ThreadAgentActivityUnit<ThreadClassifiableActivityItem>, { kind: "group" }>,
): ThreadAgentActivityItem<ThreadClassifiableActivityItem> | null {
  let latestExplorationItem: ThreadAgentActivityItem<ThreadClassifiableActivityItem> | null = null;
  for (let index = unit.items.length - 1; index >= 0; index -= 1) {
    const activityItem = unit.items[index];
    if (activityItem == null) continue;
    if (!isThreadExplorationActivityItem(activityItem.item)) {
      if (latestExplorationItem != null) break;
      continue;
    }
    latestExplorationItem ??= activityItem;
    if (isThreadAgentActivityItemInProgress(activityItem)) return activityItem;
  }
  return latestExplorationItem;
}

export function resolveThreadAgentActivityGroupState(input: {
  unit: Extract<ThreadAgentActivityUnit<ThreadClassifiableActivityItem>, { kind: "group" }>;
  isLatestVisibleUnit: boolean;
  isTurnInProgress: boolean;
  isActivitySliceClosed: boolean;
  isExploring: boolean;
}): ThreadAgentActivityGroupState {
  const isOpenLatestUnit =
    input.isLatestVisibleUnit && input.isTurnInProgress && !input.isActivitySliceClosed;
  if (!isOpenLatestUnit) return { kind: "summary" };

  if (input.isExploring) {
    const explorationItem = selectThreadExplorationActivityItem(input.unit);
    if (explorationItem != null) return { kind: "active", item: explorationItem };
  }

  for (let index = input.unit.items.length - 1; index >= 0; index -= 1) {
    const activityItem = input.unit.items[index];
    if (activityItem == null || !isThreadAgentActivityItemInProgress(activityItem)) continue;
    if (activityItem.item.type === "automaticApprovalReview") return { kind: "thinking" };
    return { kind: "active", item: activityItem };
  }
  return { kind: "thinking" };
}

export function demoteSettledThreadAgentActivitySingleton(
  unit: Extract<ThreadAgentActivityUnit<ThreadClassifiableActivityItem>, { kind: "group" }>,
  state: ThreadAgentActivityGroupState,
): ThreadAgentActivityUnit<ThreadClassifiableActivityItem> {
  if (state.kind !== "summary" || unit.items.length !== 1) return unit;
  const onlyItem = unit.items[0];
  if (isThreadAgentActivityItemInProgress(onlyItem)) return unit;

  const item = onlyItem.item;
  if (item.type === "fileChange" && "entry" in item) {
    const changedFileCount = Object.keys(item.entry.fileChange?.changes ?? {}).length;
    const visualizationCount = item.entry.fileChange?.visualizationActivities?.length ?? 0;
    if (changedFileCount !== 1 || visualizationCount > 0) return unit;
  }

  return {
    kind: "standalone",
    key: unit.key,
    item: onlyItem,
  };
}

export function buildThreadAgentActivityDynamicCompletedParts<TItem>(
  items: readonly ThreadAgentActivityDynamicCompletedEvidence<TItem>[],
): Array<Extract<ThreadAgentActivityCompletedSummaryPart<TItem>, { kind: "dynamicToolCall" }>> {
  const parts: Array<
    Extract<ThreadAgentActivityCompletedSummaryPart<TItem>, { kind: "dynamicToolCall" }>
  > = [];
  const seenKeys = new Set<string>();
  for (const { item, key } of items) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    parts.push({ kind: "dynamicToolCall", item, key });
  }
  return parts;
}

function formatEnglishConjunction(values: readonly string[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(values);
}

export function formatThreadAgentActivityCompletedSummaryPart<TDynamicItem>(
  part: ThreadAgentActivityCompletedSummaryPart<TDynamicItem>,
  options: {
    isLeading: boolean;
    formatDynamicToolCall?: (item: TDynamicItem) => string | null;
  },
): string | null {
  const leading = options.isLeading;
  switch (part.kind) {
    case "mcpSources": {
      const wording = buildThreadAgentActivityMcpSourcesWording(part.sources);
      const sourceNames = formatEnglishConjunction(wording.names);
      const verb = leading ? "Used" : "used";
      if (wording.subject === "sources") return `${verb} ${sourceNames}`;
      return `${verb} ${sourceNames} ${wording.sourceCount === 1 ? "integration" : "integrations"}`;
    }
    case "unnamedMcpCalls":
      return leading
        ? part.count === 1
          ? "Called a tool"
          : "Called tools"
        : part.count === 1
          ? "called a tool"
          : "called tools";
    case "loadedTools":
      return leading
        ? part.count === 1
          ? "Loaded a tool"
          : "Loaded tools"
        : part.count === 1
          ? "loaded a tool"
          : "loaded tools";
    case "fileChanges":
      return leading
        ? part.count === 1
          ? "Edited a file"
          : "Edited files"
        : part.count === 1
          ? "edited a file"
          : "edited files";
    case "stoppedFileCreation":
      return leading
        ? part.count === 1
          ? "Stopped creating a file"
          : "Stopped creating files"
        : part.count === 1
          ? "stopped creating a file"
          : "stopped creating files";
    case "exploration":
      return leading ? "Read files" : "read files";
    case "visualization": {
      const verb = part.activity.kind === "create" ? "created" : "updated";
      return leading
        ? `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} visualization`
        : `${verb} visualization`;
    }
    case "commands":
      return leading
        ? part.count === 1
          ? "Ran a command"
          : "Ran commands"
        : part.count === 1
          ? "ran a command"
          : "ran commands";
    case "webSearch":
      return leading ? "Searched the web" : "searched the web";
    case "dynamicToolCall":
      return options.formatDynamicToolCall?.(part.item)?.trim() || null;
  }
}

export function formatThreadAgentActivityCompletedSummary<TDynamicItem>(
  parts: readonly ThreadAgentActivityCompletedSummaryPart<TDynamicItem>[],
  options: {
    formatDynamicToolCall?: (item: TDynamicItem) => string | null;
  } = {},
): string {
  const labels = parts.flatMap((part, index) => {
    const label = formatThreadAgentActivityCompletedSummaryPart(part, {
      isLeading: index === 0,
      formatDynamicToolCall: options.formatDynamicToolCall,
    });
    return label == null ? [] : [label];
  });
  return labels.length === 0 ? "Worked" : labels.join(", ");
}

export function formatThreadAgentActivityGroupHeader(input: {
  state: ThreadAgentActivityGroupState;
  completedParts: readonly ThreadAgentActivityCompletedSummaryPart<ThreadClassifiableActivityItem>[];
  conversationDetailLevel?: "STEPS_PROSE" | string | null;
  activeExplorationLabel?: string | null;
  formatMcpToolCall?: (item: ThreadClassifiableActivityItem) => string | null;
  formatDynamicToolCall?: (
    item: ThreadClassifiableActivityItem,
    completed: boolean,
  ) => string | null;
}): string {
  if (input.state.kind === "summary") {
    return formatThreadAgentActivityCompletedSummary(input.completedParts, {
      formatDynamicToolCall: (item) => input.formatDynamicToolCall?.(item, true) ?? null,
    });
  }
  if (input.state.kind === "thinking") return "Thinking";

  const item = input.state.item.item;
  if (!("entry" in item)) return "Thinking";
  switch (item.type) {
    case "exec": {
      const explorationLabel = input.activeExplorationLabel?.trim();
      if (explorationLabel) return explorationLabel;
      if (input.conversationDetailLevel === "STEPS_PROSE") return "Running command";
      const command = item.entry.parsedCmd?.cmd?.trim() || item.entry.command?.trim() || "";
      return command ? `Running ${command}` : "Running command";
    }
    case "fileChange":
      return "Editing files";
    case "webSearch": {
      const detail = describeWebSearchAction(
        item.entry.webSearch?.action ?? null,
        item.entry.webSearch?.query ?? "",
      ).trim();
      return detail ? `Searching the web for ${detail}` : "Searching the web";
    }
    case "mcpToolCall":
      return (
        input.formatMcpToolCall?.(item)?.trim() ||
        item.entry.mcpToolCall?.invocation.tool ||
        "Thinking"
      );
    case "dynamicToolCall":
      return (
        input.formatDynamicToolCall?.(item, false)?.trim() ||
        item.entry.dynamicToolCall?.tool ||
        "Thinking"
      );
    default:
      return "Thinking";
  }
}

export function orderThreadAgentActivityMcpSources(
  sources: readonly ThreadAgentActivityGroupMcpSourceStats[],
  items: readonly ThreadAgentActivityMcpItemEvidence[],
): ThreadAgentActivityGroupMcpSourceStats[] {
  const visuallyIdentifiedSourceKeys = new Set(
    items.flatMap((item) =>
      item.sourceKey != null &&
      item.sourceKey !== NODE_REPL_MCP_SOURCE_KEY &&
      item.visuallyIdentified
        ? [item.sourceKey]
        : [],
    ),
  );
  const visibleSources = sources.filter((source) => source.key !== NODE_REPL_MCP_SOURCE_KEY);
  return [
    ...visibleSources.filter((source) => visuallyIdentifiedSourceKeys.has(source.key)),
    ...visibleSources.filter((source) => !visuallyIdentifiedSourceKeys.has(source.key)),
  ];
}

export function buildThreadAgentActivityMcpSourcesWording(
  sources: readonly ThreadAgentActivityGroupMcpSourceStats[],
): ThreadAgentActivityMcpSourcesWording {
  const names = [
    ...new Set(
      sources.map((source) =>
        source.key === BROWSER_USE_MCP_SOURCE_KEY ? "the browser" : source.name,
      ),
    ),
  ];
  return {
    names,
    sourceCount: names.length,
    subject: sources.every((source) => source.key !== NON_INTEGRATION_MCP_SOURCE_KEY)
      ? "integrations"
      : "sources",
  };
}

export function selectThreadAgentActivityMcpIconItem<TItem>(
  firstPart: ThreadAgentActivityCompletedSummaryPart | undefined,
  items: readonly ThreadAgentActivityMcpItemEvidence<TItem>[],
): TItem | null {
  if (firstPart?.kind === "mcpSources") {
    const sourceKey = firstPart.sources[0]?.key;
    if (sourceKey == null) return null;
    return (
      items.find((item) => item.sourceKey === sourceKey && item.visuallyIdentified)?.item ??
      items.find((item) => item.sourceKey === sourceKey)?.item ??
      null
    );
  }
  if (firstPart?.kind !== "unnamedMcpCalls") return null;
  return items.find((item) => item.server !== "node_repl" && item.sourceKey == null)?.item ?? null;
}

function appendPositiveCountPart<TDynamicItem>(
  parts: ThreadAgentActivityCompletedSummaryPart<TDynamicItem>[],
  part:
    | { kind: "loadedTools"; count: number }
    | { kind: "unnamedMcpCalls"; count: number }
    | { kind: "fileChanges"; count: number }
    | { kind: "stoppedFileCreation"; count: number }
    | { kind: "commands"; count: number },
): void {
  if (part.count <= 0) return;
  parts.push(part);
}

export function buildThreadAgentActivityCompletedSummaryParts<TDynamicItem = unknown>(
  facts: ThreadAgentActivitySummaryFacts,
  options: {
    orderedMcpSources?: ThreadAgentActivityGroupMcpSourceStats[];
    dynamicParts?: Array<
      Extract<ThreadAgentActivityCompletedSummaryPart<TDynamicItem>, { kind: "dynamicToolCall" }>
    >;
  } = {},
): ThreadAgentActivityCompletedSummaryPart<TDynamicItem>[] {
  const parts: ThreadAgentActivityCompletedSummaryPart<TDynamicItem>[] = [];
  const orderedMcpSources =
    options.orderedMcpSources ??
    facts.mcpToolCallSources.filter((source) => source.key !== NODE_REPL_MCP_SOURCE_KEY);
  if (orderedMcpSources.length > 0) parts.push({ kind: "mcpSources", sources: orderedMcpSources });

  appendPositiveCountPart(parts, { kind: "loadedTools", count: facts.loadedToolCount });
  const namedMcpCallCount = facts.mcpToolCallSources.reduce(
    (count, source) => count + source.count,
    0,
  );
  appendPositiveCountPart(parts, {
    kind: "unnamedMcpCalls",
    count: facts.mcpToolCallCount - namedMcpCallCount,
  });
  appendPositiveCountPart(parts, {
    kind: "fileChanges",
    count:
      facts.createdFileCount +
      facts.editedFileCount +
      facts.deletedFileCount -
      facts.stoppedCreatedFileCount,
  });
  appendPositiveCountPart(parts, {
    kind: "stoppedFileCreation",
    count: facts.stoppedCreatedFileCount,
  });
  if (facts.exploredFileCount > 0 || facts.searchCount > 0 || facts.listCount > 0) {
    parts.push({ kind: "exploration" });
  }
  if (facts.visualizationActivity != null) {
    parts.push({ kind: "visualization", activity: facts.visualizationActivity });
  }

  const nodeReplCallCount =
    facts.mcpToolCallSources.find((source) => source.key === NODE_REPL_MCP_SOURCE_KEY)?.count ?? 0;
  const webSearchCommandCount =
    facts.completedWebSearchCommandCount + facts.runningWebSearchCommandCount;
  appendPositiveCountPart(parts, {
    kind: "commands",
    count:
      facts.commandCount -
      facts.completedVisualizationCommandCount -
      facts.runningVisualizationCommandCount +
      nodeReplCallCount -
      webSearchCommandCount,
  });
  if (facts.webSearchCount > 0 || webSearchCommandCount > 0) {
    parts.push({ kind: "webSearch" });
  }
  parts.push(...(options.dynamicParts ?? []));
  return parts;
}

interface ThreadAgentActivitySummaryFactAccumulator {
  createdPaths: Set<string>;
  runningCreatedPaths: Set<string>;
  stoppedCreatedPaths: Set<string>;
  runningCreatedLineCount: number;
  changedLineCount: number;
  editedPaths: Set<string>;
  runningEditedPaths: Set<string>;
  deletedPaths: Set<string>;
  runningDeletedPaths: Set<string>;
  visualizationActivitiesByPath: Map<
    string,
    {
      kind: ThreadAgentActivityVisualizationKind;
      isInProgress: boolean;
    }
  >;
  visualizationCommandKind: ThreadAgentActivityVisualizationKind | null;
  exploredPaths: Set<string>;
  runningExploredPaths: Set<string>;
  loadedToolPaths: Set<string>;
  runningLoadedToolPaths: Set<string>;
  searchCount: number;
  runningSearchCount: number;
  listCount: number;
  runningListCount: number;
  automaticApprovalReviewFailureIds: Set<string>;
  deniedRequestCount: number;
  timedOutRequestCount: number;
  commandCount: number;
  runningCommandCount: number;
  completedWebSearchCommandCount: number;
  runningFolderCreationCommandCount: number;
  completedVisualizationCommandCount: number;
  runningVisualizationCommandCount: number;
  runningWebSearchCommandCount: number;
  mcpToolCallCount: number;
  mcpToolCallSources: Map<string, Omit<ThreadAgentActivityGroupMcpSourceStats, "key">>;
  webSearchCount: number;
  runningWebSearchCount: number;
}

export function createThreadAgentActivitySummaryFactAccumulator(): ThreadAgentActivitySummaryFactAccumulator {
  return {
    createdPaths: new Set(),
    runningCreatedPaths: new Set(),
    stoppedCreatedPaths: new Set(),
    runningCreatedLineCount: 0,
    changedLineCount: 0,
    editedPaths: new Set(),
    runningEditedPaths: new Set(),
    deletedPaths: new Set(),
    runningDeletedPaths: new Set(),
    visualizationActivitiesByPath: new Map(),
    visualizationCommandKind: null,
    exploredPaths: new Set(),
    runningExploredPaths: new Set(),
    loadedToolPaths: new Set(),
    runningLoadedToolPaths: new Set(),
    searchCount: 0,
    runningSearchCount: 0,
    listCount: 0,
    runningListCount: 0,
    automaticApprovalReviewFailureIds: new Set(),
    deniedRequestCount: 0,
    timedOutRequestCount: 0,
    commandCount: 0,
    runningCommandCount: 0,
    completedWebSearchCommandCount: 0,
    runningFolderCreationCommandCount: 0,
    completedVisualizationCommandCount: 0,
    runningVisualizationCommandCount: 0,
    runningWebSearchCommandCount: 0,
    mcpToolCallCount: 0,
    mcpToolCallSources: new Map(),
    webSearchCount: 0,
    runningWebSearchCount: 0,
  };
}

function accumulateApprovalFailure(
  accumulator: ThreadAgentActivitySummaryFactAccumulator,
  failure: ThreadAgentActivityApprovalFailure,
): void {
  if (accumulator.automaticApprovalReviewFailureIds.has(failure.id)) return;
  accumulator.automaticApprovalReviewFailureIds.add(failure.id);
  if (failure.status === "denied") {
    accumulator.deniedRequestCount += 1;
    return;
  }
  accumulator.timedOutRequestCount += 1;
}

function accumulateApprovalFailures(
  accumulator: ThreadAgentActivitySummaryFactAccumulator,
  failures: readonly ThreadAgentActivityApprovalFailure[] | undefined,
): void {
  for (const failure of failures ?? []) accumulateApprovalFailure(accumulator, failure);
}

function mergeVisualizationKind(
  current: ThreadAgentActivityVisualizationKind | null,
  next: ThreadAgentActivityVisualizationKind,
): ThreadAgentActivityVisualizationKind {
  return current === "create" || next === "create" ? "create" : "update";
}

export function accumulateThreadAgentActivitySummaryFact(
  accumulator: ThreadAgentActivitySummaryFactAccumulator,
  fact: ThreadAgentActivitySummaryFact,
): void {
  switch (fact.type) {
    case "exploration":
      accumulateApprovalFailures(accumulator, fact.automaticApprovalReviewFailures);
      for (const path of fact.readPaths) accumulator.exploredPaths.add(path);
      for (const path of fact.runningReadPaths) accumulator.runningExploredPaths.add(path);
      for (const path of fact.loadedToolPaths) accumulator.loadedToolPaths.add(path);
      for (const path of fact.runningLoadedToolPaths) accumulator.runningLoadedToolPaths.add(path);
      accumulator.searchCount += fact.searchCount;
      accumulator.runningSearchCount += fact.runningSearchCount;
      accumulator.listCount += fact.listCount;
      accumulator.runningListCount += fact.runningListCount;
      return;
    case "patch":
      accumulateApprovalFailures(accumulator, fact.automaticApprovalReviewFailures);
      for (const path of fact.createdPaths) accumulator.createdPaths.add(path);
      for (const path of fact.runningCreatedPaths) accumulator.runningCreatedPaths.add(path);
      for (const path of fact.stoppedCreatedPaths) accumulator.stoppedCreatedPaths.add(path);
      accumulator.runningCreatedLineCount += fact.runningCreatedLineCount;
      accumulator.changedLineCount += fact.changedLineCount;
      for (const path of fact.editedPaths) accumulator.editedPaths.add(path);
      for (const path of fact.runningEditedPaths) accumulator.runningEditedPaths.add(path);
      for (const path of fact.deletedPaths) accumulator.deletedPaths.add(path);
      for (const path of fact.runningDeletedPaths) accumulator.runningDeletedPaths.add(path);
      for (const activity of fact.visualizationActivity?.activities ?? []) {
        const existing = accumulator.visualizationActivitiesByPath.get(activity.path);
        accumulator.visualizationActivitiesByPath.set(activity.path, {
          kind: mergeVisualizationKind(existing?.kind ?? null, activity.kind),
          isInProgress:
            existing?.isInProgress === true || fact.visualizationActivity?.isInProgress === true,
        });
      }
      return;
    case "exec":
      accumulateApprovalFailures(accumulator, fact.automaticApprovalReviewFailures);
      accumulator.commandCount += 1;
      if (fact.visualizationActivityKind != null) {
        accumulator.visualizationCommandKind = mergeVisualizationKind(
          accumulator.visualizationCommandKind,
          fact.visualizationActivityKind,
        );
        if (fact.isInProgress) accumulator.runningVisualizationCommandCount += 1;
        else accumulator.completedVisualizationCommandCount += 1;
      }
      if (fact.isInProgress) {
        accumulator.runningCommandCount += 1;
        if (fact.createsFolder === true) accumulator.runningFolderCreationCommandCount += 1;
        if (fact.searchesWeb === true) accumulator.runningWebSearchCommandCount += 1;
        return;
      }
      if (fact.searchesWeb === true) accumulator.completedWebSearchCommandCount += 1;
      return;
    case "automaticApprovalReview":
      accumulateApprovalFailure(accumulator, fact);
      return;
    case "mcpToolCall": {
      accumulateApprovalFailures(accumulator, fact.automaticApprovalReviewFailures);
      accumulator.mcpToolCallCount += 1;
      if (fact.source == null) return;
      const existing = accumulator.mcpToolCallSources.get(fact.source.key);
      accumulator.mcpToolCallSources.set(fact.source.key, {
        logoUrl: fact.source.logoUrl,
        logoUrlDark: fact.source.logoUrlDark,
        name: fact.source.name,
        nativeAppReference: fact.source.nativeAppReference,
        count: (existing?.count ?? 0) + 1,
        runningCount: (existing?.runningCount ?? 0) + (fact.isInProgress ? 1 : 0),
      });
      return;
    }
    case "webSearch":
      accumulator.webSearchCount += fact.count;
      accumulator.runningWebSearchCount += fact.runningCount;
      return;
    case "other":
      return;
  }
}

export function materializeThreadAgentActivitySummaryFacts(
  accumulator: ThreadAgentActivitySummaryFactAccumulator,
): ThreadAgentActivitySummaryFacts {
  const visualizationActivities = [...accumulator.visualizationActivitiesByPath.values()];
  const hasVisualizationActivity =
    accumulator.visualizationCommandKind != null || visualizationActivities.length > 0;
  const visualizationActivity = hasVisualizationActivity
    ? {
        kind:
          accumulator.visualizationCommandKind === "create" ||
          visualizationActivities.some((activity) => activity.kind === "create")
            ? ("create" as const)
            : ("update" as const),
        isInProgress:
          accumulator.runningVisualizationCommandCount > 0 ||
          visualizationActivities.some((activity) => activity.isInProgress),
      }
    : undefined;

  return {
    createdFileCount: accumulator.createdPaths.size,
    runningCreatedFileCount: accumulator.runningCreatedPaths.size,
    stoppedCreatedFileCount: accumulator.stoppedCreatedPaths.size,
    runningCreatedLineCount: accumulator.runningCreatedLineCount,
    changedLineCount: accumulator.changedLineCount,
    editedFileCount: accumulator.editedPaths.size,
    runningEditedFileCount: accumulator.runningEditedPaths.size,
    deletedFileCount: accumulator.deletedPaths.size,
    runningDeletedFileCount: accumulator.runningDeletedPaths.size,
    exploredFileCount: accumulator.exploredPaths.size,
    runningExploredFileCount: accumulator.runningExploredPaths.size,
    loadedToolCount: accumulator.loadedToolPaths.size,
    runningLoadedToolCount: accumulator.runningLoadedToolPaths.size,
    searchCount: accumulator.searchCount,
    runningSearchCount: accumulator.runningSearchCount,
    listCount: accumulator.listCount,
    runningListCount: accumulator.runningListCount,
    deniedRequestCount: accumulator.deniedRequestCount,
    timedOutRequestCount: accumulator.timedOutRequestCount,
    commandCount: accumulator.commandCount,
    runningCommandCount: accumulator.runningCommandCount,
    completedWebSearchCommandCount: accumulator.completedWebSearchCommandCount,
    runningFolderCreationCommandCount: accumulator.runningFolderCreationCommandCount,
    ...(visualizationActivity ? { visualizationActivity } : {}),
    completedVisualizationCommandCount: accumulator.completedVisualizationCommandCount,
    runningVisualizationCommandCount: accumulator.runningVisualizationCommandCount,
    runningWebSearchCommandCount: accumulator.runningWebSearchCommandCount,
    mcpToolCallCount: accumulator.mcpToolCallCount,
    mcpToolCallSources: [...accumulator.mcpToolCallSources.entries()].map(([key, source]) => ({
      key,
      ...source,
    })),
    webSearchCount: accumulator.webSearchCount,
    runningWebSearchCount: accumulator.runningWebSearchCount,
  };
}

export function collectThreadAgentActivitySummaryFacts(
  facts: readonly ThreadAgentActivitySummaryFact[],
): ThreadAgentActivitySummaryFacts {
  const accumulator = createThreadAgentActivitySummaryFactAccumulator();
  for (const fact of facts) accumulateThreadAgentActivitySummaryFact(accumulator, fact);
  return materializeThreadAgentActivitySummaryFacts(accumulator);
}
