import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationItem } from "../../../lib/types";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { resolveCodexFileChangeActivity } from "../../../../shared/codex-file-change-activity";
import { stripCodexRemarkDirectiveLines } from "../../../../shared/codex-remark-directives";
import type { CodexTurnScopedConversationRequest } from "../conversation-request-helpers";
import type {
  ThreadOpenSubagentStatus,
  ThreadPendingTurnRequestModel,
  ThreadRendererItemModel,
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadSubagentActivityInlineRowModel,
  ThreadSubagentActivityStatus,
  ThreadTranscriptBlockModel,
  ThreadTurnSubagentActivityState,
} from "../thread-stage-types";

export interface BuildRendererItemStreamInput {
  entries: CodexConversationItem[];
  requests: CodexTurnScopedConversationRequest[];
  turnStatus?: "inProgress" | "completed" | "interrupted" | "failed";
  isLatestTurn?: boolean;
  backgroundAgents?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  turnKey?: string;
}

export interface BuildRendererItemStreamProjection {
  items: ThreadRendererItemModel[];
  subagentActivityState: ThreadTurnSubagentActivityState;
}

type ProtocolThreadItemType = ThreadItem["type"];
type RendererTranscriptType = ThreadTranscriptBlockModel["type"];

const SEMANTIC_FALLBACK = "semanticFallback";

const PROTOCOL_THREAD_ITEM_RENDERER_TYPES = {
  userMessage: "userMessage",
  hookPrompt: null,
  agentMessage: "assistantMessage",
  functionCallOutput: null,
  plan: SEMANTIC_FALLBACK,
  reasoning: "reasoning",
  commandExecution: "exec",
  fileChange: "fileChange",
  mcpToolCall: "mcpToolCall",
  dynamicToolCall: "dynamicToolCall",
  collabAgentToolCall: SEMANTIC_FALLBACK,
  subAgentActivity: "subagentActivityInlineGroup",
  webSearch: "webSearch",
  imageView: "imageView",
  sleep: null,
  imageGeneration: null,
  enteredReviewMode: null,
  exitedReviewMode: null,
  contextCompaction: "contextCompaction",
} satisfies Record<
  ProtocolThreadItemType,
  RendererTranscriptType | typeof SEMANTIC_FALLBACK | null
>;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .map((entry) => stringifyValue(entry))
      .filter(Boolean)
      .join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.values(value)
      .map((entry) => stringifyValue(entry))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function resolveSearchableText(entry: CodexConversationItem): string {
  const segments = [
    resolveVisibleMarkdownText(entry) ?? "",
    entry.additionalDetails ?? "",
    entry.toolCall?.toolName ?? "",
    entry.toolCall?.server ?? "",
    entry.dynamicToolCall?.namespace ?? "",
    entry.dynamicToolCall?.tool ?? "",
    stringifyValue(entry.dynamicToolCall?.arguments),
    stringifyValue(entry.dynamicToolCall?.contentItems),
    entry.mcpToolCall?.pluginId ?? "",
    entry.mcpToolCall?.mcpAppResourceUri ?? "",
    stringifyValue(entry.fileChange),
    stringifyValue(entry.toolCall?.args),
    stringifyValue(entry.toolCall?.result),
    stringifyValue(entry.rawItem),
  ]
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return stripCodexRemarkDirectiveLines(segments.join("\n"));
}

function resolveVisibleMarkdownText(entry: CodexConversationItem): string | undefined {
  if (entry.kind !== "assistantMessage" && entry.semanticKind !== "assistantMessage") {
    return entry.markdownText;
  }

  return stripCodexRemarkDirectiveLines(entry.markdownText);
}

function hasRenderableFileChangeEntry(entry: CodexConversationItem): boolean {
  return (
    resolveCodexFileChangeActivity({
      status: entry.status,
      fileChange: entry.fileChange,
      hasToolError: Boolean(entry.toolCall?.error),
    }).visibility !== "suppressed"
  );
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function getStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function getWebSearchVisibleQuery(entry: CodexConversationItem): string {
  const toolArgsQuery = getStringField(getRecord(entry.toolCall?.args), "query")?.trim();
  if (toolArgsQuery) return toolArgsQuery;

  const rawItemQuery = getStringField(getRecord(entry.rawItem), "query")?.trim();
  if (rawItemQuery) return rawItemQuery;

  return "";
}

function hasRenderableWebSearchEntry(entry: CodexConversationItem): boolean {
  return getWebSearchVisibleQuery(entry).length > 0;
}

function normalizeSubagentActivityStatus(
  displayStatus: NonNullable<CodexConversationItem["subagentActivity"]>["displayStatus"],
): ThreadSubagentActivityStatus {
  if (displayStatus === "updated") return "updated";
  if (displayStatus === "interrupted") return "interrupted";
  return "started";
}

function formatSubagentActivityStatusSummary(
  displayName: string,
  activityStatus: ThreadSubagentActivityStatus,
): string {
  if (activityStatus === "updated") return `${displayName} updated`;
  if (activityStatus === "interrupted") return `${displayName} interrupted`;
  if (activityStatus === "done") return `${displayName} finished`;
  return `${displayName} started working`;
}

function resolveSubagentActivityStatusLabel(
  rows: readonly ThreadSubagentActivityInlineRowModel[],
): string {
  if (rows.some((row) => row.activityStatus === "interrupted")) return "interrupted";
  if (rows.some((row) => row.activityStatus === "updated")) return "updated";
  if (rows.length > 0 && rows.every((row) => row.activityStatus === "done")) return "finished";
  return "started working";
}

type SubagentActivity = NonNullable<CodexConversationItem["subagentActivity"]>;

interface SubagentActivityGroup {
  block: ThreadTranscriptBlockModel;
  activityItems: SubagentActivity[];
}

interface ProjectedTranscriptEntry {
  block: ThreadTranscriptBlockModel | null;
  subagentActivity: SubagentActivity | null;
}

function normalizeSubagentConversationId(agentThreadId: string): string {
  return agentThreadId;
}

function resolveSubagentActivityRows(input: {
  activityItems: readonly SubagentActivity[];
  backgroundAgents: readonly ThreadComposerShellBackgroundAgentRowModel[];
  laterActivityItems: readonly SubagentActivity[];
  turnKey?: string;
}): ThreadSubagentActivityInlineRowModel[] {
  const backgroundAgentsByConversationId = new Map(
    input.backgroundAgents.map((agent) => [agent.conversationId, agent]),
  );
  const latestActivityByConversationId = new Map<string, SubagentActivity>();
  for (const activity of input.activityItems) {
    latestActivityByConversationId.set(
      normalizeSubagentConversationId(activity.agentThreadId),
      activity,
    );
  }

  return Array.from(latestActivityByConversationId, ([conversationId, activity]) => {
    const backgroundAgent = backgroundAgentsByConversationId.get(conversationId);
    const hasLaterActivity = input.laterActivityItems.some(
      (laterActivity) => laterActivity.agentThreadId === activity.agentThreadId,
    );
    const belongsToTurn =
      backgroundAgent !== undefined && backgroundAgent.parentTurnKey === input.turnKey;
    const isFinalForTurn = belongsToTurn && !hasLaterActivity;
    const rawActivityStatus = normalizeSubagentActivityStatus(activity.displayStatus);
    const status: ThreadOpenSubagentStatus =
      backgroundAgent === undefined
        ? activity.displayStatus === "interrupted"
          ? "done"
          : "active"
        : belongsToTurn
          ? backgroundAgent.status
          : "done";
    const activityStatus =
      activity.displayStatus !== "interrupted" && status === "done" && isFinalForTurn
        ? "done"
        : rawActivityStatus;
    const displayName = activity.displayName ?? "Agent";
    const fallbackStatusSummary = formatSubagentActivityStatusSummary(
      displayName,
      rawActivityStatus,
    );

    return {
      conversationId,
      displayName,
      agentRole: backgroundAgent?.agentRole ?? null,
      spawnModel: backgroundAgent?.spawnModel ?? null,
      status,
      activityStatus,
      statusSummary: belongsToTurn
        ? (backgroundAgent?.statusSummary ?? fallbackStatusSummary)
        : fallbackStatusSummary,
      diffStats: backgroundAgent?.diffStats ?? null,
    };
  });
}

function buildProvisionalSubagentActivityRow(
  activity: SubagentActivity,
): ThreadSubagentActivityInlineRowModel {
  const activityStatus = normalizeSubagentActivityStatus(activity.displayStatus);
  const displayName = activity.displayName ?? "Agent";
  return {
    conversationId: activity.agentThreadId,
    displayName,
    agentRole: null,
    spawnModel: null,
    status: activity.displayStatus === "interrupted" ? "done" : "active",
    activityStatus,
    statusSummary: formatSubagentActivityStatusSummary(displayName, activityStatus),
    diffStats: null,
  };
}

function isProtocolThreadItemType(type: string): type is ProtocolThreadItemType {
  return Object.prototype.hasOwnProperty.call(PROTOCOL_THREAD_ITEM_RENDERER_TYPES, type);
}

function getProtocolThreadItemType(entry: CodexConversationItem): ProtocolThreadItemType | null {
  if (typeof entry.rawItem !== "object" || entry.rawItem === null) return null;
  const rawType = (entry.rawItem as { type?: unknown }).type;
  if (typeof rawType !== "string") return null;
  return isProtocolThreadItemType(rawType) ? rawType : null;
}

function resolveProtocolRendererType(
  protocolType: ProtocolThreadItemType | null,
): RendererTranscriptType | typeof SEMANTIC_FALLBACK | null {
  if (!protocolType) return SEMANTIC_FALLBACK;
  return PROTOCOL_THREAD_ITEM_RENDERER_TYPES[protocolType];
}

function resolveSemanticRendererType(entry: CodexConversationItem): RendererTranscriptType | null {
  switch (entry.semanticKind) {
    case "userMessage":
      return "userMessage";
    case "assistantMessage":
      return "assistantMessage";
    case "reasoning":
      return "reasoning";
    case "todoList":
      return "todoList";
    case "proposedPlan":
      return "proposedPlan";
    case "exec":
      return "exec";
    case "diff":
      return "turnDiff";
    case "mcpToolCall":
      return "mcpToolCall";
    case "dynamicToolCall":
      return "dynamicToolCall";
    case "webSearch":
      return "webSearch";
    case "imageView":
      return "imageView";
    case "generatedImage":
      return "generatedImage";
    case "subAgentActivity":
      return "subagentActivityInlineGroup";
    case "mcpServerElicitation":
      return "mcpServerElicitation";
    case "hook":
      return "hook";
    case "planImplementation":
      return "planImplementation";
    case "streamError":
      return "streamError";
    case "systemError":
      return "systemError";
    case "remoteTaskCreated":
      return "remoteTaskCreated";
    case "personalityChanged":
      return "personalityChanged";
    case "forkedFromConversation":
      return "forkedFromConversation";
    case "modelChanged":
      return "modelChanged";
    case "modelRerouted":
      return "modelRerouted";
    case "contextCompaction":
      return "contextCompaction";
    case "worktreeInit":
      return "worktreeInit";
    case "automaticApprovalReview":
      return "automaticApprovalReview";
    case "autoReviewInterruptionWarning":
      return "autoReviewInterruptionWarning";
    case "multiAgentAction":
      return "multiAgentAction";
    case "steered":
      return "steered";
    case "userInputResponse":
      return "userInputResponse";
    case "systemEvent":
      return "systemEvent";
    default:
      return null;
  }
}

function resolveRendererType(
  entry: CodexConversationItem,
): ThreadTranscriptBlockModel["type"] | null {
  const protocolType = getProtocolThreadItemType(entry);

  if (entry.kind === "fileChange" || protocolType === "fileChange") {
    return hasRenderableFileChangeEntry(entry) ? "fileChange" : null;
  }

  if (entry.semanticKind === "webSearch" || protocolType === "webSearch") {
    return hasRenderableWebSearchEntry(entry) ? "webSearch" : null;
  }

  if (entry.kind === "userInputRequest") {
    return null;
  }

  if (entry.kind === "userInputResponse" && entry.semanticKind !== "userInputResponse") {
    return null;
  }

  if (
    (entry.semanticKind === "reasoning" || protocolType === "reasoning") &&
    (entry.markdownText?.trim().length ?? 0) === 0
  ) {
    return null;
  }

  const semanticType = resolveSemanticRendererType(entry);
  if (semanticType && entry.semanticKind !== "systemEvent") return semanticType;

  const protocolTypeResolution = resolveProtocolRendererType(protocolType);
  if (protocolTypeResolution !== SEMANTIC_FALLBACK) return protocolTypeResolution;

  return semanticType;
}

function buildTranscriptBlock(
  entry: CodexConversationItem,
  turnStatus: BuildRendererItemStreamInput["turnStatus"],
): ThreadTranscriptBlockModel | null {
  const type = resolveRendererType(entry);
  if (!type) return null;
  const entryId = entry.entryId ?? entry.itemId;

  if (type === "subagentActivityInlineGroup") {
    if (!entry.subagentActivity) return null;
    const row = buildProvisionalSubagentActivityRow(entry.subagentActivity);
    return {
      id: entryId,
      turnId: entry.turnId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      searchableText: [
        row.displayName,
        row.statusSummary ?? "",
        resolveSubagentActivityStatusLabel([row]),
      ]
        .filter((segment) => segment.trim().length > 0)
        .join("\n"),
      type,
      entry,
      status: entry.status,
      isTurnCancelled: turnStatus === "interrupted",
      subagentActivityRows: [row],
      subagentActivityStatusLabel: resolveSubagentActivityStatusLabel([row]),
    };
  }

  if (type === "imageView") {
    const imageViewPaths = entry.imageViewPaths ?? [];
    if (imageViewPaths.length === 0) return null;
    return {
      id: entryId,
      turnId: entry.turnId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      searchableText: imageViewPaths.join("\n"),
      type,
      entry,
      status: "completed",
      isTurnCancelled: turnStatus === "interrupted",
      imageViewPaths,
    };
  }

  return {
    id: entryId,
    turnId: entry.turnId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    searchableText: resolveSearchableText(entry),
    type,
    entry,
    status: entry.status,
    isTurnCancelled: turnStatus === "interrupted",
  };
}

function resolveRequestSearchableText(request: CodexTurnScopedConversationRequest): string {
  if (request.type === "approval") {
    return [request.reason ?? "", request.command ?? "", request.cwd ?? ""]
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join("\n");
  }

  if (request.type === "userInput") {
    return request.questions
      .map((question) => question.question)
      .join("\n")
      .trim();
  }

  if (request.type === "permissionRequest") {
    return [request.reason ?? "", request.cwd, JSON.stringify(request.permissions)]
      .join("\n")
      .trim();
  }

  if (request.type === "optionPicker") {
    return [
      request.question,
      ...request.options.flatMap((option) => [option.label, option.description ?? ""]),
    ]
      .join("\n")
      .trim();
  }

  if (request.type === "setupCodexStep") {
    return request.step;
  }

  if (request.type === "nodexAgentAuthorization") {
    return [
      request.preview.summary,
      ...request.preview.details.map((detail) => `${detail.label} ${detail.value}`),
      request.preview.markdownPreview ?? request.preview.nfmPreview ?? "",
    ]
      .join("\n")
      .trim();
  }

  return request.planContent.trim();
}

function buildPendingRequestBlock(
  request: CodexTurnScopedConversationRequest,
): ThreadPendingTurnRequestModel {
  return {
    id: buildCodexCanonicalRequestIdentityKey(request.requestId),
    turnId: request.turnId,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
    searchableText: resolveRequestSearchableText(request),
    type: request.type,
    request,
  };
}

function resolveSubagentActivityGroups(
  projectedEntries: readonly ProjectedTranscriptEntry[],
  input: Pick<BuildRendererItemStreamInput, "backgroundAgents" | "turnKey">,
): ThreadTranscriptBlockModel[] {
  const groupedBlocks: Array<ThreadTranscriptBlockModel | SubagentActivityGroup> = [];
  let previousEntryWasSubagentActivity = false;

  for (const projectedEntry of projectedEntries) {
    const { block, subagentActivity } = projectedEntry;
    if (block === null || subagentActivity === null) {
      if (block !== null) groupedBlocks.push(block);
      previousEntryWasSubagentActivity = false;
      continue;
    }

    const previousGroup = groupedBlocks.at(-1);
    if (
      previousEntryWasSubagentActivity &&
      previousGroup !== undefined &&
      "activityItems" in previousGroup
    ) {
      previousGroup.activityItems.push(subagentActivity);
      previousGroup.block = {
        ...previousGroup.block,
        updatedAt: block.updatedAt,
      };
    } else {
      groupedBlocks.push({
        block,
        activityItems: [subagentActivity],
      });
    }
    previousEntryWasSubagentActivity = true;
  }

  const activityGroups = groupedBlocks.filter(
    (block): block is SubagentActivityGroup => "activityItems" in block,
  );
  let activityGroupIndex = 0;

  return groupedBlocks.map((groupedBlock) => {
    if (!("activityItems" in groupedBlock)) return groupedBlock;

    const laterActivityItems = activityGroups
      .slice(activityGroupIndex + 1)
      .flatMap((group) => group.activityItems);
    const rows = resolveSubagentActivityRows({
      activityItems: groupedBlock.activityItems,
      backgroundAgents: input.backgroundAgents ?? [],
      laterActivityItems,
      turnKey: input.turnKey,
    });
    activityGroupIndex += 1;

    return {
      ...groupedBlock.block,
      searchableText: rows
        .flatMap((row) => [row.displayName, row.statusSummary ?? ""])
        .filter(Boolean)
        .join("\n"),
      subagentActivityRows: rows,
      subagentActivityStatusLabel: resolveSubagentActivityStatusLabel(rows),
    };
  });
}

function resolveTurnSubagentActivityState(
  blocks: readonly ThreadTranscriptBlockModel[],
  input: Pick<BuildRendererItemStreamInput, "backgroundAgents" | "turnKey">,
): ThreadTurnSubagentActivityState {
  const anchoredGroups = blocks.filter((block) => block.type === "subagentActivityInlineGroup");
  const rows =
    anchoredGroups.length > 0
      ? anchoredGroups.flatMap((group) => group.subagentActivityRows ?? [])
      : (input.backgroundAgents ?? []).filter(
          (agent) => agent.showInlineActivity && agent.parentTurnKey === input.turnKey,
        );

  return {
    hasActivity: rows.length > 0,
    hasActiveActivity: rows.some((row) => row.status !== "done"),
  };
}

export function buildRendererItemStreamProjection(
  input: BuildRendererItemStreamInput,
): BuildRendererItemStreamProjection {
  const projectedTranscriptEntries = input.entries.map((entry): ProjectedTranscriptEntry => {
    const block = buildTranscriptBlock(entry, input.turnStatus);
    return {
      block,
      subagentActivity:
        block?.type === "subagentActivityInlineGroup" ? (entry.subagentActivity ?? null) : null,
    };
  });
  const transcriptBlocks = resolveSubagentActivityGroups(projectedTranscriptEntries, input);
  const requestBlocks = input.requests.map((request) => buildPendingRequestBlock(request));

  return {
    items: [...transcriptBlocks, ...requestBlocks],
    subagentActivityState: resolveTurnSubagentActivityState(transcriptBlocks, input),
  };
}

export function buildRendererItemStream(
  input: BuildRendererItemStreamInput,
): ThreadRendererItemModel[] {
  return buildRendererItemStreamProjection(input).items;
}
