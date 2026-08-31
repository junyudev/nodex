import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type {
  GuardianApprovalReviewAction,
  HookRunSummary,
} from "@nodex/codex-app-server-protocol/v2";
import {
  buildCodexCanonicalSyntheticTurnParams,
  createCodexCanonicalHookRun,
  type CodexCanonicalHookRun,
  type CodexCanonicalItem,
  type CodexCanonicalConversationState,
  type CodexCanonicalSafetyBufferingState,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import { ensureCodexCanonicalTurnCollections } from "./codex-turn-mutation";

export interface CodexTurnMetadataResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: "applied" | "foreignConversation" | "missingTurn";
  readonly stateChanged: boolean;
  readonly effects: readonly CodexTurnMetadataEffect[];
}

export type CodexTurnMetadataEffect =
  | {
      readonly type: "markConversationStreaming";
      readonly threadId: string;
    }
  | {
      readonly type: "touchConversationUpdatedAt";
      readonly threadId: string;
      readonly observedAtMs: number;
    };

type NotificationOf<TMethod extends ServerNotification["method"]> = Extract<
  ServerNotification,
  { method: TMethod }
>;

function result(
  state: CodexCanonicalConversationState,
  disposition: CodexTurnMetadataResult["disposition"],
  stateChanged = false,
  effects: readonly CodexTurnMetadataEffect[] = [],
): CodexTurnMetadataResult {
  return { state, disposition, stateChanged, effects };
}

function replaceTurn(
  state: CodexCanonicalConversationState,
  index: number,
  turn: CodexCanonicalTurnState,
): CodexCanonicalConversationState {
  const turns = [...state.turns];
  turns[index] = turn;
  return { ...state, turns };
}

function resolveMetadataTurn(
  state: CodexCanonicalConversationState,
  turnId: string,
  observedAtMs: number,
): { readonly state: CodexCanonicalConversationState; readonly index: number } | null {
  const exactIndex = state.turns.findIndex((turn) => turn.protocol.id === turnId);
  if (exactIndex >= 0) return { state, index: exactIndex };
  const latest = state.turns.at(-1);
  if (
    state.turns.length !== 1 ||
    !latest ||
    latest.protocol.id !== null ||
    latest.protocol.status !== "completed" ||
    latest.protocol.error !== null ||
    latest.items.length !== 0
  )
    return null;
  return {
    state: replaceTurn(state, 0, {
      ...latest,
      protocol: { ...latest.protocol, id: turnId, status: "inProgress" },
      sidecar: {
        ...latest.sidecar,
        turnStartedAtMs: latest.sidecar.turnStartedAtMs ?? observedAtMs,
      },
    }),
    index: 0,
  };
}

export function reduceCodexConversationTurnDiff(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string,
  diff: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.protocol.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = resolved.state.turns[resolved.index]!;
  if (turn.sidecar.diff === diff)
    return result(resolved.state, "applied", resolved.state !== state);
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    sidecar: { ...turn.sidecar, diff },
  });
  return result(next, "applied", true);
}

export function reduceCodexConversationSafetyBuffering(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string,
  safetyBuffering: CodexCanonicalSafetyBufferingState,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.protocol.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = resolved.state.turns[resolved.index]!;
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    sidecar: { ...turn.sidecar, safetyBuffering },
  });
  return result(next, "applied", true);
}

function findHookRunIndex(hooks: readonly CodexCanonicalHookRun[], run: HookRunSummary): number {
  for (let index = hooks.length - 1; index >= 0; index -= 1) {
    const hook = hooks[index];
    if (hook?.run.id === run.id && hook.run.status === "running") return index;
  }
  if (run.completedAt === null) return -1;
  for (let index = hooks.length - 1; index >= 0; index -= 1) {
    const hook = hooks[index];
    if (hook?.run.id === run.id && hook.run.completedAt === run.completedAt) return index;
  }
  return -1;
}

function upsertHookRun(
  hooks: readonly CodexCanonicalHookRun[],
  run: HookRunSummary,
): readonly CodexCanonicalHookRun[] {
  const index = findHookRunIndex(hooks, run);
  if (index >= 0) {
    const next = [...hooks];
    next[index] = createCodexCanonicalHookRun(run, hooks[index]!.id);
    return next;
  }
  const occurrence = hooks.filter((hook) => hook.run.id === run.id).length;
  const id = occurrence === 0 ? run.id : `${run.id}:${occurrence}`;
  return [...hooks, createCodexCanonicalHookRun(run, id)];
}

function synthesizeHookTurn(
  state: CodexCanonicalConversationState,
  turnId: string,
  observedAtMs: number,
): { readonly state: CodexCanonicalConversationState; readonly index: number } {
  const previous = state.turns.at(-1) ?? null;
  const turn: CodexCanonicalTurnState = {
    protocol: {
      id: turnId,
      itemsView: "full",
      status: "inProgress",
      error: null,
      durationMs: null,
    },
    items: [],
    sidecar: {
      params: previous?.sidecar.params ?? buildCodexCanonicalSyntheticTurnParams(state, previous),
      diff: null,
      turnStartedAtMs: observedAtMs,
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      hookRuns: [],
    },
  };
  return { state: { ...state, turns: [...state.turns, turn] }, index: state.turns.length };
}

function resolveHookTurn(
  state: CodexCanonicalConversationState,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  observedAtMs: number,
): { readonly state: CodexCanonicalConversationState; readonly index: number } | null {
  if (turnId === null) {
    const latestIndex = state.turns.length - 1;
    return latestIndex < 0 ? null : { state, index: latestIndex };
  }
  const exactIndex = state.turns.findIndex((turn) => turn.protocol.id === turnId);
  if (exactIndex >= 0) return { state, index: exactIndex };
  if (method === "hook/completed") return resolveMetadataTurn(state, turnId, observedAtMs);
  const latestIndex = state.turns.length - 1;
  const latest = state.turns[latestIndex];
  if (latest?.protocol.id === null && latest.protocol.status === "inProgress") {
    return {
      state: replaceTurn(state, latestIndex, {
        ...latest,
        protocol: { ...latest.protocol, id: turnId },
      }),
      index: latestIndex,
    };
  }
  return synthesizeHookTurn(state, turnId, observedAtMs);
}

export function reduceCodexConversationHookRun(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  run: HookRunSummary,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.protocol.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveHookTurn(state, turnId, method, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = resolved.state.turns[resolved.index]!;
  const hooks = turn.sidecar.hookRuns ?? [];
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    sidecar: {
      ...turn.sidecar,
      hookRuns: upsertHookRun(hooks, run),
    },
  });
  return result(
    next,
    "applied",
    true,
    method === "hook/started"
      ? [{ type: "markConversationStreaming", threadId: conversationId }]
      : [],
  );
}

function replaceResolvedTurnItem(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string,
  observedAtMs: number,
  update: (items: readonly CodexCanonicalItem[]) => readonly CodexCanonicalItem[],
): CodexTurnMetadataResult {
  if (state.protocol.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = ensureCodexCanonicalTurnCollections(resolved.state.turns[resolved.index]!);
  return result(
    replaceTurn(resolved.state, resolved.index, {
      ...turn,
      items: update(turn.items),
    }),
    "applied",
    true,
  );
}

export function reduceCodexConversationTurnPlan(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"turn/plan/updated">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, explanation, plan } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => [
    ...items,
    { id: itemId, type: "todo-list", explanation, plan },
  ]);
}

export function reduceCodexConversationModelRerouted(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"model/rerouted">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, fromModel, toModel, reason } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => [
    ...items,
    { id: itemId, type: "modelRerouted", fromModel, toModel, reason },
  ]);
}

export function reduceCodexConversationError(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"error">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, error, willRetry } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => [
    ...items,
    {
      id: itemId,
      type: "error",
      message: error.message,
      willRetry,
      errorInfo: error.codexErrorInfo,
      additionalDetails: error.additionalDetails,
    },
  ]);
}

function projectGuardianAction(action: GuardianApprovalReviewAction): unknown {
  if (action.type === "command") {
    return { ...action, source: action.source === "unifiedExec" ? "unified_exec" : "shell" };
  }
  if (action.type === "execve") {
    return { ...action, source: action.source === "unifiedExec" ? "unified_exec" : "shell" };
  }
  if (action.type === "applyPatch") {
    return { type: "apply_patch", cwd: action.cwd, files: action.files };
  }
  if (action.type === "networkAccess") {
    const protocols = {
      http: "http",
      https: "https",
      socks5Tcp: "socks5_tcp",
      socks5Udp: "socks5_udp",
    } as const;
    return {
      type: "network_access",
      target: action.target,
      host: action.host,
      protocol: protocols[action.protocol],
      port: action.port,
    };
  }
  if (action.type === "mcpToolCall") {
    return {
      type: "mcp_tool_call",
      server: action.server,
      tool_name: action.toolName,
      connector_id: action.connectorId,
      connector_name: action.connectorName,
      tool_title: action.toolTitle,
    };
  }
  if (action.type === "writeStdin") {
    return {
      type: "write_stdin",
      approval_id: action.approvalId,
      process_id: action.processId,
      stdin: action.stdin,
      cwd: action.cwd,
    };
  }
  return {
    type: "request_permissions",
    reason: action.reason,
    permissions: {
      network: action.permissions.network,
      file_system: action.permissions.fileSystem,
    },
  };
}

function buildDeniedGuardianEvent(
  params:
    | NotificationOf<"item/autoApprovalReview/started">["params"]
    | NotificationOf<"item/autoApprovalReview/completed">["params"],
): unknown | null {
  if (params.review.status !== "denied") return null;
  const statuses = {
    aborted: "aborted",
    approved: "approved",
    denied: "denied",
    inProgress: "in_progress",
    timedOut: "timed_out",
  } as const;
  return {
    id: params.reviewId,
    target_item_id: params.targetItemId,
    turn_id: params.turnId,
    status: statuses[params.review.status],
    risk_level: params.review.riskLevel,
    user_authorization: params.review.userAuthorization,
    rationale: params.review.rationale,
    decision_source: "decisionSource" in params ? params.decisionSource : null,
    action: projectGuardianAction(params.action),
  };
}

export function reduceCodexConversationAutomaticApprovalReview(
  state: CodexCanonicalConversationState,
  notification:
    | NotificationOf<"item/autoApprovalReview/started">
    | NotificationOf<"item/autoApprovalReview/completed">,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { params } = notification;
  const itemId = `automatic-approval-review:${params.reviewId}`;
  const reduced = replaceResolvedTurnItem(
    state,
    params.threadId,
    params.turnId,
    observedAtMs,
    (items) => {
      const index = items.findIndex(
        (item) => item.id === itemId && item.type === "automaticApprovalReview",
      );
      const existing = index < 0 ? null : items[index];
      const item: CodexCanonicalItem = {
        id: itemId,
        type: "automaticApprovalReview",
        targetItemId: params.targetItemId,
        action: params.action,
        startedAtMs:
          existing?.type === "automaticApprovalReview" ? existing.startedAtMs : observedAtMs,
        completedAtMs: params.review.status === "inProgress" ? null : observedAtMs,
        event: buildDeniedGuardianEvent(params),
        ...params.review,
      };
      if (index < 0) return [...items, item];
      const next = [...items];
      next[index] = item;
      return next;
    },
  );
  if (reduced.disposition !== "applied") return reduced;
  return {
    ...reduced,
    effects: [
      {
        type: "touchConversationUpdatedAt",
        threadId: params.threadId,
        observedAtMs,
      },
    ],
  };
}

export function reduceCodexConversationGuardianWarning(
  state: CodexCanonicalConversationState,
  conversationId: string,
  itemId: string,
): CodexTurnMetadataResult {
  if (state.protocol.id !== conversationId) return result(state, "foreignConversation");
  const index = state.turns.length - 1;
  if (index < 0) return result(state, "missingTurn");
  const turn = ensureCodexCanonicalTurnCollections(state.turns[index]!);
  return result(
    replaceTurn(state, index, {
      ...turn,
      items: [...turn.items, { id: itemId, type: "autoReviewInterruptionWarning" }],
    }),
    "applied",
    true,
  );
}
