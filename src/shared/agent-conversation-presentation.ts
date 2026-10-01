import type {
  AgentBackendSessionPresentation,
  AgentCanonicalSessionUpdate,
  AgentInteractionRequest,
  AgentConversationSnapshot,
  AgentConversationTokenUsage,
  AgentConversationTurn,
  AgentInteractionResponse,
} from "./agent-conversation";
import { z } from "zod";
import { buildAgentHistoryImageSource } from "./agent-history-images";
import { isAgentConversationTaskLiveInSnapshot } from "./agent-conversation";
import { projectCodexMcpToolCallResult } from "./codex-mcp-tool-call";
import type {
  CodexConversationItem,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexThreadSummary,
} from "./types";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
const inputOf = (input: string | undefined): unknown => {
  try {
    return JSON.parse(input ?? "{}");
  } catch {
    return input;
  }
};
const breakdownOf = (tokens: AgentConversationTokenUsage | undefined, fallback = 0) => ({
  totalTokens: tokens
    ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    : fallback,
  inputTokens: tokens?.input ?? fallback,
  cachedInputTokens: tokens?.cacheRead ?? 0,
  cacheWriteInputTokens: tokens?.cacheWrite ?? 0,
  outputTokens: tokens?.output ?? 0,
  reasoningOutputTokens: 0,
});

export const agentInteractionResponseFromAnswers = (
  request: AgentInteractionRequest,
  answers: Readonly<Record<string, readonly string[]>>,
): AgentInteractionResponse => {
  if (request.dialog?.kind === "resume_return") {
    const selection = answers["resume-action"]?.[0];
    if (selection === "Compact and continue") return { decision: "dialog", result: "compact" };
    if (selection === "Keep full history") return { decision: "dialog", result: "continue" };
    if (selection === "Never ask again") return { decision: "dialog", result: "never" };
    return { decision: "deny" };
  }
  return {
    decision: "answer",
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [id, values.join(", ")]),
    ),
  };
};

/** Child content is an observation of its native task, never a second execution Thread. */
export const filterAgentConversationForTask = (
  snapshot: AgentConversationSnapshot,
  taskId: string,
): AgentConversationSnapshot => {
  const task = snapshot.tasks?.find((value) => value.id === taskId);
  const belongs = (actor: AgentCanonicalSessionUpdate["actor"]) =>
    actor?.taskId === taskId ||
    (task?.toolUseId !== undefined && actor?.parentToolUseId === task.toolUseId) ||
    (task?.agentId !== undefined && actor?.agentId === task.agentId);
  const live = task ? isAgentConversationTaskLiveInSnapshot(task, snapshot) : false;
  const turns: AgentConversationTurn[] = snapshot.turns.flatMap((turn) => {
    const updates = turn.updates
      .filter((value) => belongs(value.actor))
      .map((value) => ({ ...value, actor: undefined }));
    if (!updates.length) return [];
    return [
      {
        ...turn,
        promptText: null,
        updates,
        status:
          task?.status === "failed"
            ? ("failed" as const)
            : task?.status === "cancelled"
              ? ("cancelled" as const)
              : live
                ? ("running" as const)
                : ("completed" as const),
        stopReason: live
          ? null
          : task?.status === "failed"
            ? "error"
            : task?.status === "cancelled"
              ? "cancelled"
              : "end_turn",
        error: task?.error ?? null,
      },
    ];
  });
  if (!turns.length && task) {
    const text = task.summary ?? task.description ?? task.outputFile ?? "Task";
    turns.push({
      sequence: task.bornTurnSequence,
      clientUserMessageId: null,
      promptText: null,
      stopReason: live
        ? null
        : task.status === "failed"
          ? "error"
          : task.status === "cancelled"
            ? "cancelled"
            : "end_turn",
      status:
        task.status === "failed"
          ? "failed"
          : task.status === "cancelled"
            ? "cancelled"
            : live
              ? "running"
              : "completed",
      error: task.error ?? null,
      updates: [
        {
          kind: "message",
          key: `task-summary:${task.id}`,
          messageId: task.id,
          role: "agent",
          text,
        },
      ],
    });
  }
  return {
    ...snapshot,
    requests: snapshot.requests
      ?.filter((request) => belongs(request.actor))
      .map((request) => ({ ...request, actor: undefined })),
    turns,
    status: live ? "running" : "idle",
  };
};

// These are application presentation types, not generated app-server wire items. Native
// sessions never enter the Codex canonical reducer or fabricate its raw request authority.
function projectUpdate(
  update: AgentCanonicalSessionUpdate,
  base: Pick<CodexConversationItem, "threadId" | "turnId" | "createdAt" | "updatedAt">,
  running: boolean,
  sessionId: string,
): CodexConversationItem[] {
  const common = {
    ...base,
    itemId: update.key,
    entryId: update.key,
    type: update.kind,
    additionalDetails: update.truncated ? "Content truncated" : undefined,
    ...(update.kind === "tool-call" &&
    update.truncated &&
    update.outputRecordId &&
    update.status !== "pending" &&
    update.status !== "in_progress"
      ? {
          toolOutputReference: {
            sessionId,
            nativeMessageId: update.outputRecordId,
            toolUseId: update.toolCallId,
          },
        }
      : {}),
  };
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
        userAttachments: update.promptImages?.map((image) => ({
          type: "image" as const,
          id: `${update.key}:image:${image.index}`,
          source: buildAgentHistoryImageSource({
            sessionId,
            nativeMessageId: image.nativeMessageId,
            index: image.index,
          }),
          sourceKind: "remote-pointer" as const,
          caption: image.mediaType,
        })),
        role: update.role === "user" ? "user" : "assistant",
        status: running && update.role !== "user" ? "inProgress" : "completed",
      },
    ];
  }
  if (update.kind === "tool-call") {
    const status =
      update.status === "pending" || update.status === "in_progress"
        ? "inProgress"
        : update.status === "cancelled"
          ? "interrupted"
          : update.status;
    const input = inputOf(update.input);
    const args = record(input);
    const output = record(update.output);
    if (update.presentation === "command")
      return [
        {
          ...common,
          kind: "commandExecution",
          semanticKind: "exec",
          status,
          executionStatus: status,
          callId: update.toolCallId,
          command: typeof args.command === "string" ? args.command : update.title,
          cwd: typeof args.cwd === "string" ? args.cwd : null,
          aggregatedOutput:
            [
              typeof output.stdout === "string" ? output.stdout : "",
              typeof output.stderr === "string" ? output.stderr : "",
            ]
              .filter(Boolean)
              .join("\n") || update.detail,
          exitCode:
            typeof output.exitCode === "number"
              ? output.exitCode
              : typeof output.exit_code === "number"
                ? output.exit_code
                : null,
          durationMs: update.elapsedSeconds === undefined ? null : update.elapsedSeconds * 1000,
          markdownText: update.detail,
        },
      ];
    if (update.presentation === "file-change" && update.changes?.length)
      return [
        {
          ...common,
          kind: "fileChange",
          semanticKind: "patch",
          status,
          fileChange: {
            success: update.status === "completed",
            changes: Object.fromEntries(
              update.changes.map((change) => [
                change.path,
                change.kind === "update"
                  ? { type: "update", unifiedDiff: change.diff ?? "", movePath: null }
                  : { type: change.kind, content: change.diff ?? "" },
              ]),
            ),
          },
          markdownText: update.detail,
        },
      ];
    if (update.presentation === "web-search")
      return [
        {
          ...common,
          kind: "toolCall",
          semanticKind: "webSearch",
          status,
          webSearch: {
            query: typeof args.query === "string" ? args.query : update.title,
            action: update.output ?? null,
            completed: status !== "inProgress",
          },
          markdownText: update.detail,
        },
      ];
    if (update.presentation === "mcp") {
      const content = z
        .array(z.json())
        .safeParse(
          output.content ??
            (Array.isArray(update.output)
              ? update.output
              : [{ type: "text", text: update.detail }]),
        );
      const structured = z
        .json()
        .safeParse(output.structuredContent ?? output.structured_content ?? null);
      const parsedInput = z.json().safeParse(input);
      const parts = (update.name ?? update.title).split("__");
      const server = parts.length >= 3 ? parts[1]! : "MCP";
      const name = parts.length >= 3 ? parts.slice(2).join("__") : update.title;
      return [
        {
          ...common,
          kind: "toolCall",
          semanticKind: "mcpToolCall",
          status,
          mcpToolCall: {
            callId: update.toolCallId,
            functionName: name,
            pluginId: null,
            readOnlyHint: null,
            mcpAppResourceUri: undefined,
            source: null,
            invocation: {
              server,
              tool: name,
              arguments: parsedInput.success ? parsedInput.data : null,
            },
            result:
              status === "inProgress"
                ? null
                : projectCodexMcpToolCallResult(
                    content.success
                      ? {
                          content: content.data,
                          structuredContent: structured.success ? structured.data : null,
                          _meta: null,
                        }
                      : null,
                    update.status === "failed" ? { message: update.detail } : null,
                  ),
            durationMs: update.elapsedSeconds === undefined ? null : update.elapsedSeconds * 1000,
            completed: status !== "inProgress",
          },
          markdownText: update.detail,
        },
      ];
    }
    if (update.name === "Read" && output.type === "image")
      return [
        {
          ...common,
          kind: "toolCall",
          semanticKind: "imageView",
          status,
          imageViewPaths: [...update.locations],
          markdownText: update.detail,
        },
      ];
    return [
      {
        ...common,
        kind: "toolCall",
        semanticKind: "toolCall",
        status,
        toolCall: {
          subtype: "generic",
          toolName: update.title || update.name || "Tool",
          args: input,
          result: update.output ?? (update.detail || undefined),
          error: update.status === "failed" ? update.detail : undefined,
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
        semanticKind: update.markdown === null ? "todoList" : "proposedPlan",
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
        status:
          update.status === "in_progress"
            ? "inProgress"
            : update.status === "failed"
              ? "failed"
              : "completed",
        contextCompaction: {
          completed: update.status !== "in_progress",
          source: update.trigger === "manual" ? "manual" : "automatic",
        },
        markdownText: update.summary,
      },
    ];
  }
  if (update.kind === "diagnostic")
    return [
      {
        ...common,
        kind: "systemEvent",
        semanticKind: update.severity === "error" ? "systemError" : "systemEvent",
        status: update.severity === "error" ? "failed" : "completed",
        markdownText: update.message,
        additionalDetails: update.details ? JSON.stringify(update.details) : null,
      },
    ];
  if (update.kind === "rate-limit" && update.status !== "allowed")
    return [
      {
        ...common,
        kind: "systemEvent",
        semanticKind: "systemEvent",
        status: update.status === "rejected" ? "failed" : "completed",
        markdownText: `Claude usage limit ${update.status === "rejected" ? "reached" : "approaching"}${update.resetsAt ? ` · resets ${new Date(update.resetsAt * 1000).toISOString()}` : ""}.`,
      },
    ];
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
    itemId: request.toolUseId ? `tool:${request.toolUseId}` : request.id,
    createdAt: summary.updatedAt,
  };
  if (request.dialog?.kind === "resume_return")
    return {
      ...base,
      type: "userInput",
      isBlocking: true,
      questions: [
        {
          id: "resume-action",
          header: "Resume conversation",
          question: "Compact this conversation before continuing?",
          isOther: false,
          options: [
            { label: "Compact and continue", description: "" },
            { label: "Keep full history", description: "" },
            { label: "Never ask again", description: "" },
          ],
        },
      ],
    };
  if (request.elicitation)
    return {
      ...base,
      type: "mcpServerElicitation",
      kind: "generic",
      serverName: request.mcpServer?.name ?? request.title,
      ...request.elicitation,
    };
  if (request.toolName === "ExitPlanMode")
    return {
      ...base,
      type: "implementPlan",
      planContent:
        typeof request.dialog?.payload.plan === "string"
          ? request.dialog.payload.plan
          : typeof record(inputOf(request.detail)).plan === "string"
            ? String(record(inputOf(request.detail)).plan)
            : request.detail,
    };
  if (request.questions.length)
    return {
      ...base,
      type: "userInput",
      isBlocking: true,
      questions: request.questions.map((question) => ({
        ...question,
        header: question.header ?? request.title,
        isOther: true,
        options: [...question.options],
      })),
    };
  return {
    ...base,
    type: "approval",
    kind: "command",
    command: request.detail,
    reason: request.description ?? request.decisionReason ?? `Allow ${request.title}?`,
    availableDecisions:
      request.constraints?.allowForSession && !request.constraints.suppressAlwaysAllowRule
        ? ["accept", "acceptForSession", "decline"]
        : ["accept", "decline"],
    defaultToNo: request.constraints?.defaultToNo,
    suppressAlwaysAllowRule: request.constraints?.suppressAlwaysAllowRule,
  };
}

/** The accepted client identity survives the later native UUID acknowledgement. */
export const agentConversationTurnId = (
  snapshot: Pick<AgentConversationSnapshot, "sessionId">,
  turn: Pick<AgentConversationTurn, "nativeUserMessageId" | "clientUserMessageId" | "sequence">,
): string =>
  `${snapshot.sessionId}:${turn.clientUserMessageId ?? turn.nativeUserMessageId ?? turn.sequence ?? "history"}`;

/** Stable provider turn/item IDs feed the same Markdown, activity, request and composer UI. */
export function projectAgentConversation(
  presentation: AgentBackendSessionPresentation,
  summary: CodexThreadSummary,
): CodexConversationSnapshot {
  const { snapshot } = presentation;
  const turns: CodexConversationTurn[] = snapshot.turns.flatMap(
    (turn, index): CodexConversationTurn[] => {
      const turnId = agentConversationTurnId(snapshot, turn);
      const running =
        snapshot.status === "running" &&
        index === snapshot.turns.length - 1 &&
        turn.stopReason === null;
      const base = {
        threadId: snapshot.threadId,
        turnId,
        createdAt:
          turn.createdAt && Number.isFinite(Date.parse(turn.createdAt))
            ? Date.parse(turn.createdAt)
            : summary.createdAt,
        updatedAt:
          turn.completedAt && Number.isFinite(Date.parse(turn.completedAt))
            ? Date.parse(turn.completedAt)
            : summary.updatedAt,
      };
      const items: CodexConversationItem[] =
        turn.promptText || turn.promptImages?.length
          ? [
              {
                ...base,
                itemId: `${turnId}:user`,
                type: "userMessage",
                kind: "userMessage",
                semanticKind: "userMessage",
                role: "user",
                markdownText: turn.promptText ?? "",
                userAttachments: turn.promptImages?.map((image) => ({
                  type: "image" as const,
                  id: `${turnId}:image:${image.index}`,
                  source: buildAgentHistoryImageSource({
                    sessionId: snapshot.sessionId,
                    nativeMessageId: image.nativeMessageId,
                    index: image.index,
                  }),
                  sourceKind: "remote-pointer" as const,
                  caption: image.mediaType,
                })),
                status: "completed",
              },
            ]
          : [];
      items.push(
        ...turn.updates
          .filter(
            (update) =>
              !update.actor?.parentToolUseId && !update.actor?.taskId && !update.actor?.agentId,
          )
          .flatMap((update) => projectUpdate(update, base, running, snapshot.sessionId)),
      );
      if (!items.length && !running) return [];
      return [
        {
          threadId: snapshot.threadId,
          turnId,
          entityKey: turnId,
          clientUserMessageId: turn.clientUserMessageId,
          ...(!running && !turn.status && !turn.stopReason
            ? { outcomeUnknown: true as const }
            : {}),
          items,
          itemIds: items.map((item) => item.itemId),
          status: running
            ? "inProgress"
            : turn.status === "failed" ||
                turn.stopReason === "error" ||
                (snapshot.status === "failed" && index === snapshot.turns.length - 1)
              ? "failed"
              : turn.status === "cancelled" ||
                  turn.stopReason === "cancelled" ||
                  turn.stopReason === "interrupted"
                ? "interrupted"
                : "completed",
          errorMessage: turn.error ?? undefined,
          startedAt: turn.createdAt ? Date.parse(turn.createdAt) : null,
          completedAt: turn.completedAt ? Date.parse(turn.completedAt) : null,
        },
      ];
    },
  );
  const configOptions = snapshot.metadata?.configOptions ?? presentation.configOptions;
  const model = configOptions.find((option) => option.category === "model");
  const modelId =
    snapshot.metadata?.effectiveSelection?.model ??
    (model?.type === "select" ? model.currentValue : null);
  const effort = configOptions.find(
    (option) => option.category === "reasoning_effort" || option.id === "effort",
  );
  const effortId =
    snapshot.metadata?.effectiveSelection?.effort ??
    (effort?.type === "select" ? effort.currentValue : null);
  const mode =
    (snapshot.metadata?.modes ?? presentation.modes)?.currentModeId === "plan" ? "plan" : "default";
  const requests = (snapshot.requests ?? []).map((request) =>
    projectRequest(request, summary, turns.at(-1)?.turnId ?? snapshot.sessionId),
  );
  const usage = snapshot.turns
    .flatMap((turn) => turn.updates)
    .findLast((update) => update.kind === "usage");
  const breakdown = breakdownOf(usage?.tokens, usage?.used);
  const total = breakdownOf(usage?.cumulativeTokens ?? usage?.tokens, usage?.used);
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
      reasoningEffort: effortId,
      collaborationMode: {
        mode,
        settings: {
          model: modelId ?? "default",
          reasoning_effort: effortId,
          developer_instructions: null,
        },
      },
      personality: null,
    },
    latestCollaborationMode: {
      mode,
      settings: {
        model: modelId ?? "default",
        reasoning_effort: effortId,
        developer_instructions: null,
      },
    },
    latestTokenUsageInfo: usage ? { total, last: breakdown, modelContextWindow: usage.size } : null,
    contextUsage: usage ? { used: usage.used, size: usage.size, cost: usage.cost } : undefined,
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
      canEditLastUserTurn:
        (snapshot.metadata?.capabilities ?? presentation.capabilities).controls?.rollback === true,
      canForkFromTurn:
        (snapshot.metadata?.capabilities ?? presentation.capabilities).controls?.fork === true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}
