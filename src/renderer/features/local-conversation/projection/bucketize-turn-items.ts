import type {
  ThreadAgentItemModel,
  ThreadPendingTurnRequestModel,
  ThreadRendererItemModel,
  ThreadTranscriptBlockModel,
  ThreadTurnRenderBuckets,
} from "../thread-stage-types";

interface BucketizeTurnItemsInput {
  items: ThreadRendererItemModel[];
  turnStatus?: "inProgress" | "completed" | "interrupted" | "failed";
}

function createEmptyBuckets(): ThreadTurnRenderBuckets {
  return {
    preUserItems: [],
    userItems: [],
    latestAssistantMessage: null,
    assistantItem: null,
    systemEventItem: null,
    approvalItem: null,
    userInputItem: null,
    interactiveRequestItem: null,
    permissionRequestItems: [],
    mcpServerElicitationItems: [],
    toolOutputItems: [],
    todoListItem: null,
    unifiedDiffItem: null,
    proposedPlanItem: null,
    planImplementationItem: null,
    postAssistantItems: [],
    agentItems: [],
    remoteTaskCreatedItems: [],
    personalityChangedItems: [],
    forkedFromConversationItems: [],
    modelChangedItems: [],
    modelReroutedItems: [],
  };
}

function isPendingRequestItem(
  item: ThreadRendererItemModel,
): item is ThreadPendingTurnRequestModel {
  return (
    item.type === "approval" ||
    item.type === "userInput" ||
    item.type === "optionPicker" ||
    item.type === "setupCodexStep" ||
    item.type === "permissionRequest" ||
    item.type === "implementPlan"
  );
}

function isTranscriptBlock(item: ThreadRendererItemModel): item is ThreadTranscriptBlockModel {
  return "entry" in item;
}

function isPendingApproval(item: ThreadTranscriptBlockModel): boolean {
  return item.type === "fileChange"
    ? item.entry.approvalRequestId != null && item.entry.fileChange == null
    : item.type === "exec"
      ? item.entry.approvalRequestId != null && item.entry.exitCode == null
      : false;
}

function hasRenderableAssistantContent(item: ThreadTranscriptBlockModel | null): boolean {
  if (!item || item.type !== "assistantMessage") return false;
  return (item.entry.markdownText?.trim().length ?? 0) > 0;
}

function isTrailingAutomaticApprovalReview(item: ThreadTranscriptBlockModel): boolean {
  return item.type === "automaticApprovalReview";
}

function isRenderableAgentItem(item: ThreadRendererItemModel): item is ThreadAgentItemModel {
  if (item.type === "workedFor") return true;
  if (!isTranscriptBlock(item)) return false;

  switch (item.type) {
    case "assistantMessage":
    case "exec":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "automaticApprovalReview":
    case "multiAgentAction":
    case "subagentActivityInlineGroup":
    case "streamError":
    case "systemError":
    case "contextCompaction":
    case "worktreeInit":
    case "autoReviewInterruptionWarning":
    case "steered":
    case "reasoning":
    case "userInputResponse":
    case "mcpServerElicitation":
      return true;
    case "webSearch":
      return item.searchableText.trim().length > 0;
    default:
      return false;
  }
}

function normalizeMcpServerName(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function resolveMcpToolCallServer(item: ThreadTranscriptBlockModel): string | null {
  if (item.type !== "mcpToolCall") return null;
  return normalizeMcpServerName(
    item.entry.mcpToolCall?.invocation.server ?? item.entry.toolCall?.server,
  );
}

function resolveMcpElicitationServer(item: ThreadTranscriptBlockModel): string | null {
  if (item.type !== "mcpServerElicitation" || item.status === "completed") return null;
  const rawItem = item.entry.rawItem;
  if (typeof rawItem !== "object" || rawItem === null) return null;

  const serverName =
    "serverName" in rawItem && typeof rawItem.serverName === "string" ? rawItem.serverName : null;
  return normalizeMcpServerName(serverName ?? undefined);
}

export function bucketizeTurnItems(input: BucketizeTurnItemsInput): ThreadTurnRenderBuckets {
  const buckets = createEmptyBuckets();
  const agentCandidates: ThreadAgentItemModel[] = [];
  const pendingMcpElicitationServers = new Set<string>();
  let beforeAgentSequence = true;

  for (const item of input.items) {
    // Hook execution is turn metadata, never an activity or assistant body row.
    if (item.type === "hook") continue;
    if (isPendingRequestItem(item)) {
      if (item.type === "approval") {
        buckets.approvalItem = item;
        continue;
      }

      if (item.type === "userInput") {
        buckets.userInputItem = item;
        continue;
      }

      if (item.type === "optionPicker" || item.type === "setupCodexStep") {
        buckets.interactiveRequestItem = item;
        continue;
      }

      if (item.type === "permissionRequest") {
        if (item.request.type === "permissionRequest" && !item.request.completed) {
          buckets.permissionRequestItems.push(item);
        }
      }
      continue;
    }

    if (beforeAgentSequence && item.type === "userMessage") {
      buckets.userItems.push(item);
      continue;
    }

    // Worktree initialization is inserted before app-server items, but it is
    // authored as agent activity for the same first Turn. Keep looking for the
    // Turn's user prefix after staging this transparent preface.
    if (beforeAgentSequence && item.type === "worktreeInit") {
      agentCandidates.push(item);
      continue;
    }

    beforeAgentSequence = false;

    if (item.type === "turnDiff") {
      buckets.unifiedDiffItem = item;
      continue;
    }

    if (item.type === "todoList") {
      buckets.todoListItem = item;
      continue;
    }

    if (item.type === "proposedPlan") {
      buckets.proposedPlanItem = item;
      continue;
    }

    if (item.type === "planImplementation") {
      buckets.planImplementationItem = item;
      continue;
    }

    if (item.type === "remoteTaskCreated") {
      buckets.remoteTaskCreatedItems.push(item);
      continue;
    }

    if (item.type === "personalityChanged") {
      buckets.personalityChangedItems.push(item);
      continue;
    }

    if (item.type === "forkedFromConversation") {
      buckets.forkedFromConversationItems.push(item);
      continue;
    }

    if (item.type === "modelChanged") {
      buckets.modelChangedItems.push(item);
      continue;
    }

    if (item.type === "modelRerouted") {
      buckets.modelReroutedItems.push(item);
      continue;
    }

    if (item.type === "generatedImage") {
      buckets.toolOutputItems.push(item);
      continue;
    }

    if (item.type === "mcpServerElicitation" && item.status !== "completed") {
      const serverName = resolveMcpElicitationServer(item);
      if (serverName) pendingMcpElicitationServers.add(serverName);
      buckets.mcpServerElicitationItems.push(item);
      continue;
    }

    if (isTranscriptBlock(item) && isPendingApproval(item)) {
      continue;
    }

    if (item.type === "userMessage") {
      agentCandidates.push(item);
      continue;
    }

    if (item.type === "assistantMessage") {
      buckets.latestAssistantMessage = item;
      agentCandidates.push(item);
      continue;
    }

    if (item.type === "mcpToolCall" && item.status === "inProgress") {
      const serverName = resolveMcpToolCallServer(item);
      if (serverName && pendingMcpElicitationServers.has(serverName)) {
        continue;
      }
    }

    if (isRenderableAgentItem(item)) {
      agentCandidates.push(item);
    }
  }

  const trailingReviews: ThreadTranscriptBlockModel[] = [];
  while (agentCandidates.length > 0) {
    const reviewCandidate = agentCandidates[agentCandidates.length - 1];
    if (
      !reviewCandidate ||
      !isTranscriptBlock(reviewCandidate) ||
      !isTrailingAutomaticApprovalReview(reviewCandidate)
    ) {
      break;
    }
    const review = agentCandidates.pop();
    if (!review || !isTranscriptBlock(review)) break;
    trailingReviews.unshift(review);
  }

  const trailingAssistantCandidate = agentCandidates[agentCandidates.length - 1] ?? null;
  if (trailingAssistantCandidate?.type === "assistantMessage") {
    buckets.assistantItem = trailingAssistantCandidate;
    agentCandidates.pop();
  }

  if (buckets.assistantItem) {
    buckets.postAssistantItems.unshift(...trailingReviews);
  } else {
    agentCandidates.push(...trailingReviews);
  }

  const trailingSystemCandidate = agentCandidates[agentCandidates.length - 1] ?? null;
  const canPromoteSystemError =
    input.turnStatus !== "inProgress" &&
    !hasRenderableAssistantContent(buckets.assistantItem) &&
    trailingSystemCandidate?.type === "systemError";

  if (canPromoteSystemError && trailingSystemCandidate) {
    buckets.systemEventItem = trailingSystemCandidate;
    agentCandidates.pop();
  }

  buckets.agentItems.push(...agentCandidates);
  return buckets;
}
