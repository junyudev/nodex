import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationItem } from "../../../lib/types";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import { resolveCodexFileChangeActivity } from "../../../../shared/codex-file-change-activity";
import { normalizeMultiAgentActionPayload } from "../../../../shared/codex-transcript-special-items";
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
  turnId?: string | null;
  showFullTranscript?: boolean;
  canOpenSubagents?: boolean;
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
  if (displayStatus === "completed") return "done";
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

  return Array.from(latestActivityByConversationId).flatMap(([conversationId, activity]) => {
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
        ? activity.displayStatus === "interrupted" || activity.displayStatus === "completed"
          ? "done"
          : "active"
        : belongsToTurn
          ? backgroundAgent.status
          : "done";
    const activityStatus = status === "done" && isFinalForTurn ? "done" : rawActivityStatus;
    const displayName =
      belongsToTurn && backgroundAgent.showInlineActivity === false
        ? backgroundAgent.displayName
        : activity.displayName?.trim()
          ? activity.displayName
          : backgroundAgent?.displayName;
    if (!displayName?.trim() || displayName.trim() === activity.agentThreadId) return [];
    const fallbackStatusSummary = formatSubagentActivityStatusSummary(
      displayName,
      rawActivityStatus,
    );

    return [
      {
        conversationId,
        canOpen: backgroundAgent !== undefined || activity.displayStatus === "active",
        displayName,
        agentRole: backgroundAgent?.agentRole ?? null,
        spawnModel: backgroundAgent?.spawnModel ?? null,
        status,
        activityStatus,
        statusSummary: belongsToTurn
          ? (backgroundAgent?.statusSummary ?? fallbackStatusSummary)
          : fallbackStatusSummary,
        diffStats: backgroundAgent?.diffStats ?? null,
      },
    ];
  });
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
    if (entry.subagentActivity.isMessage) {
      return {
        id: entryId,
        turnId: entry.turnId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        searchableText: `Sent message to ${entry.subagentActivity.displayName ?? "parent"}`,
        type,
        entry,
        status: entry.status,
        isTurnCancelled: turnStatus === "interrupted",
      };
    }
    return {
      id: entryId,
      turnId: entry.turnId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      searchableText: "",
      type,
      entry,
      status: entry.status,
      isTurnCancelled: turnStatus === "interrupted",
      subagentActivityAnchorItemId: entryId,
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

  return groupedBlocks.flatMap((groupedBlock) => {
    if (!("activityItems" in groupedBlock)) return [groupedBlock];

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
    if (rows.length === 0) return [];

    return [
      {
        ...groupedBlock.block,
        searchableText: rows
          .flatMap((row) => [row.displayName, row.statusSummary ?? ""])
          .filter(Boolean)
          .join("\n"),
        subagentActivityRows: rows,
        subagentActivityStatusLabel: resolveSubagentActivityStatusLabel(rows),
      },
    ];
  });
}

function isNamedSubagent(displayName: string | null | undefined, conversationId: string): boolean {
  return Boolean(displayName?.trim() && displayName.trim() !== conversationId);
}

function filterRedundantSpawns(input: BuildRendererItemStreamInput): CodexConversationItem[] {
  const backgroundAgents = input.backgroundAgents ?? [];
  const covered = new Set(
    backgroundAgents
      .filter(
        (agent) =>
          agent.parentTurnKey === input.turnKey &&
          isNamedSubagent(agent.displayName, agent.conversationId),
      )
      .map((agent) => agent.conversationId),
  );
  for (const entry of input.entries) {
    const activity = entry.subagentActivity;
    if (
      !activity ||
      activity.isMessage ||
      !isNamedSubagent(activity.displayName, activity.agentThreadId)
    )
      continue;
    const background = backgroundAgents.find(
      (agent) =>
        agent.conversationId === activity.agentThreadId && agent.parentTurnKey === input.turnKey,
    );
    if (background?.showInlineActivity === false && !background.displayName.trim()) continue;
    covered.add(activity.agentThreadId);
  }
  if (covered.size === 0) return input.entries;
  return input.entries.filter((entry) => {
    if (entry.semanticKind !== "multiAgentAction") return true;
    const action = normalizeMultiAgentActionPayload(entry.rawItem);
    if (
      !action ||
      action.action !== "spawnAgent" ||
      action.status !== "completed" ||
      action.prompt?.trim() ||
      action.receiverThreads.length === 0
    )
      return true;
    return !action.receiverThreads.every((receiver) => covered.has(receiver.threadId));
  });
}

function buildFallbackSubagentBlock(
  input: BuildRendererItemStreamInput,
  representedIds: ReadonlySet<string>,
): ThreadTranscriptBlockModel | null {
  const rows: ThreadSubagentActivityInlineRowModel[] = (input.backgroundAgents ?? [])
    .filter(
      (agent) =>
        agent.parentTurnKey === input.turnKey &&
        !representedIds.has(agent.conversationId) &&
        isNamedSubagent(agent.displayName, agent.conversationId),
    )
    .map((agent) => ({
      conversationId: agent.conversationId,
      displayName: agent.displayName,
      canOpen: true,
      agentRole: agent.agentRole,
      spawnModel: agent.spawnModel,
      status: agent.status,
      activityStatus: agent.status === "done" ? "done" : "started",
      statusSummary: agent.statusSummary,
      diffStats: agent.diffStats,
    }));
  if (rows.length === 0) return null;
  const id = `subagent-fallback:${input.turnKey ?? "unscoped"}`;
  const lastEntry = input.entries.at(-1);
  const entry: CodexConversationItem = {
    threadId: lastEntry?.threadId ?? input.backgroundAgents?.[0]?.parentConversationId ?? "",
    turnId: input.turnId !== undefined ? input.turnId : (lastEntry?.turnId ?? null),
    itemId: id,
    type: "subagent_activity_fallback",
    kind: "systemEvent",
    semanticKind: "subAgentActivity",
    createdAt: lastEntry?.createdAt ?? 0,
    updatedAt: lastEntry?.updatedAt ?? 0,
  };
  return {
    id,
    turnId: entry.turnId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    type: "subagentActivityInlineGroup",
    entry,
    searchableText: rows.map((row) => row.displayName).join("\n"),
    subagentActivityAnchorItemId: null,
    subagentActivityRows: rows,
    subagentActivityStatusLabel: resolveSubagentActivityStatusLabel(rows),
  };
}

export function buildRendererItemStreamProjection(
  input: BuildRendererItemStreamInput,
): BuildRendererItemStreamProjection {
  const projectedTranscriptEntries = filterRedundantSpawns(input).map(
    (entry): ProjectedTranscriptEntry => {
      const block = buildTranscriptBlock(entry, input.turnStatus);
      return {
        block,
        subagentActivity:
          block?.type === "subagentActivityInlineGroup" && !entry.subagentActivity?.isMessage
            ? (entry.subagentActivity ?? null)
            : null,
      };
    },
  );
  const transcriptBlocks = resolveSubagentActivityGroups(projectedTranscriptEntries, input);
  // Raw lifecycle membership owns fallback exclusion even when its name is not renderable.
  const representedIds = new Set(
    projectedTranscriptEntries.flatMap(({ subagentActivity }) =>
      subagentActivity ? [subagentActivity.agentThreadId] : [],
    ),
  );
  const fallback = buildFallbackSubagentBlock(input, representedIds);
  if (fallback) transcriptBlocks.push(fallback);
  const groups = transcriptBlocks.filter(
    (block) =>
      block.type === "subagentActivityInlineGroup" && !block.entry.subagentActivity?.isMessage,
  );
  const visibleRecipients = new Set(
    !input.showFullTranscript && input.canOpenSubagents
      ? groups.flatMap((group) =>
          (group.subagentActivityRows ?? [])
            .slice(0, 4)
            .filter((row) => row.canOpen)
            .map((row) => row.conversationId),
        )
      : [],
  );
  const visibleBlocks = transcriptBlocks.filter(
    (block) =>
      !block.entry.subagentActivity?.isMessage ||
      !visibleRecipients.has(block.entry.subagentActivity.agentThreadId),
  );
  const rows = groups.flatMap((group) => group.subagentActivityRows ?? []);
  const requestBlocks = input.requests.map((request) => buildPendingRequestBlock(request));

  return {
    items: [...visibleBlocks, ...requestBlocks],
    subagentActivityState: {
      hasActivity: rows.length > 0,
      hasActiveActivity: rows.some((row) => row.status !== "done"),
    },
  };
}

export function buildRendererItemStream(
  input: BuildRendererItemStreamInput,
): ThreadRendererItemModel[] {
  return buildRendererItemStreamProjection(input).items;
}
