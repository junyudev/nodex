import type {
  AgentBackendSessionPresentation,
  AgentCanonicalSessionUpdate,
  AgentInteractionRequest,
} from "./agent-conversation";
import type {
  CodexConversationItem,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexThreadSummary,
} from "./types";

// These are application presentation types, not generated app-server wire items. Native
// sessions never enter the Codex canonical reducer or fabricate its raw request authority.
function projectUpdate(
  update: AgentCanonicalSessionUpdate,
  base: Pick<CodexConversationItem, "threadId" | "turnId" | "createdAt" | "updatedAt">,
  running: boolean,
): CodexConversationItem[] {
  const common = { ...base, itemId: update.key, entryId: update.key, type: update.kind };
  if (update.kind === "message") {
    const kind =
      update.role === "user"
        ? "userMessage"
        : update.role === "thought"
          ? "reasoning"
          : "assistantMessage";
    return [
      {
        ...common,
        kind,
        semanticKind: kind,
        markdownText: update.text,
        role: update.role === "user" ? "user" : "assistant",
        status: running && update.role !== "user" ? "inProgress" : "completed",
      },
    ];
  }
  if (update.kind === "tool-call") {
    const status =
      update.status === "pending" || update.status === "in_progress" ? "inProgress" : update.status;
    return [
      {
        ...common,
        kind: "toolCall",
        semanticKind: "toolCall",
        status,
        toolCall: {
          subtype: "generic",
          toolName: update.title || update.name || "Tool",
          args: update.input,
          result: update.detail || undefined,
        },
        markdownText: update.detail,
      },
    ];
  }
  if (update.kind === "plan" && update.state === "present") {
    return [
      {
        ...common,
        kind: "plan",
        semanticKind: "proposedPlan",
        status: "completed",
        markdownText:
          update.markdown ??
          update.entries
            .map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`)
            .join("\n"),
      },
    ];
  }
  if (update.kind === "compaction") {
    return [
      {
        ...common,
        kind: "systemEvent",
        semanticKind: "contextCompaction",
        status: "completed",
        contextCompaction: { completed: update.status !== "in_progress", source: "automatic" },
        markdownText: update.summary,
      },
    ];
  }
  return [];
}

function projectRequest(
  request: AgentInteractionRequest,
  summary: CodexThreadSummary,
  turnId: string,
): CodexConversationServerRequest {
  const base = {
    requestId: request.id,
    projectId: summary.projectId,
    threadId: summary.threadId,
    turnId,
    itemId: request.id,
    createdAt: summary.updatedAt,
  };
  if (request.questions.length)
    return {
      ...base,
      type: "userInput",
      isBlocking: true,
      questions: request.questions.map((question) => ({
        ...question,
        header: request.title,
        isOther: true,
        options: [...question.options],
      })),
    };
  return {
    ...base,
    type: "approval",
    kind: "command",
    command: request.detail,
    reason: `Allow ${request.title}?`,
    availableDecisions: ["accept", "decline"],
  };
}

/** Stable provider turn/item IDs feed the same Markdown, activity, request and composer UI. */
export function projectAgentConversation(
  presentation: AgentBackendSessionPresentation,
  summary: CodexThreadSummary,
): CodexConversationSnapshot {
  const { snapshot } = presentation;
  const turns: CodexConversationTurn[] = snapshot.turns.flatMap(
    (turn, index): CodexConversationTurn[] => {
      const turnId = `${snapshot.sessionId}:${turn.sequence ?? "history"}`;
      const running =
        snapshot.status === "running" &&
        index === snapshot.turns.length - 1 &&
        turn.stopReason === null;
      const base = {
        threadId: snapshot.threadId,
        turnId,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
      const items: CodexConversationItem[] = turn.promptText
        ? [
            {
              ...base,
              itemId: `${turnId}:user`,
              type: "userMessage",
              kind: "userMessage",
              semanticKind: "userMessage",
              role: "user",
              markdownText: turn.promptText,
              status: "completed",
            },
          ]
        : [];
      items.push(...turn.updates.flatMap((update) => projectUpdate(update, base, running)));
      if (!items.length && !running) return [];
      return [
        {
          threadId: snapshot.threadId,
          turnId,
          entityKey: turnId,
          clientUserMessageId: turn.clientUserMessageId,
          items,
          itemIds: items.map((item) => item.itemId),
          status: running
            ? "inProgress"
            : snapshot.status === "failed" && index === snapshot.turns.length - 1
              ? "failed"
              : turn.stopReason === "cancelled" || turn.stopReason === "interrupted"
                ? "interrupted"
                : "completed",
        },
      ];
    },
  );
  const model = presentation.configOptions.find((option) => option.category === "model");
  const modelId = model?.type === "select" ? model.currentValue : null;
  const mode = presentation.modes?.currentModeId === "plan" ? "plan" : "default";
  const requests = (snapshot.requests ?? []).map((request) =>
    projectRequest(request, summary, turns.at(-1)?.turnId ?? snapshot.sessionId),
  );
  const usage = snapshot.turns
    .flatMap((turn) => turn.updates)
    .findLast((update) => update.kind === "usage");
  const breakdown = {
    totalTokens: usage?.used ?? 0,
    inputTokens: usage?.used ?? 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  return {
    ...summary,
    statusType: snapshot.status === "running" ? "active" : "idle",
    statusActiveFlags: requests.length
      ? [
          requests.some((request) => request.type === "userInput")
            ? "waitingOnUserInput"
            : "waitingOnApproval",
        ]
      : [],
    resumeState: "resumed",
    turns,
    requests,
    pendingSteers: [],
    backgroundTerminalRows: [],
    latestThreadSettings: {
      model: modelId ?? "default",
      modelProvider: snapshot.backend,
      reasoningEffort: null,
      collaborationMode: {
        mode,
        settings: {
          model: modelId ?? "default",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
      personality: null,
    },
    latestCollaborationMode: {
      mode,
      settings: {
        model: modelId ?? "default",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
    latestTokenUsageInfo: usage
      ? { total: breakdown, last: breakdown, modelContextWindow: usage.size }
      : null,
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    capabilityFlags: {
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}
