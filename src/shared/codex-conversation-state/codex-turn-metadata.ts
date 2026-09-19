import { produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
  appendConversationTurnDraft,
} from "./codex-turn-mutation";
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

export interface CodexTurnMetadataResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: "applied" | "foreignConversation" | "missingTurn";
  readonly stateChanged: boolean;
  readonly effects: readonly CodexTurnMetadataEffect[];
}

export type CodexTurnMetadataEffect = {
  readonly type: "markConversationStreaming";
  readonly threadId: string;
};

type NotificationOf<TMethod extends ServerNotification["method"]> = Extract<
  ServerNotification,
  {
    method: TMethod;
  }
>;

function result(
  state: Draft<CodexCanonicalConversationState>,
  disposition: CodexTurnMetadataResult["disposition"],
  stateChanged = false,
  effects: readonly CodexTurnMetadataEffect[] = [],
): CodexTurnMetadataResult {
  return { state, disposition, stateChanged, effects };
}

function replaceTurn(
  state: Draft<CodexCanonicalConversationState>,
  index: number,
  turn: CodexCanonicalTurnState,
): Draft<CodexCanonicalConversationState> {
  const entry = residentConversationTurnEntries(state)[index];
  if (!entry) return state;
  const target = conversationTurnDraft(state, entry.address);
  if (target) Object.assign(target, turn);
  return state;
}

function resolveMetadataTurn(
  state: Draft<CodexCanonicalConversationState>,
  turnId: string,
  observedAtMs: number,
): {
  readonly state: Draft<CodexCanonicalConversationState>;
  readonly index: number;
} | null {
  const exactIndex = residentConversationTurns(state).findIndex((turn) => turn.turnId === turnId);
  if (exactIndex >= 0) return { state, index: exactIndex };
  const latest = residentConversationTurns(state).at(-1);
  if (
    residentConversationTurns(state).length !== 1 ||
    !latest ||
    latest.turnId !== null ||
    latest.status !== "completed" ||
    latest.error !== null ||
    latest.items.length !== 0
  )
    return null;
  return {
    state: replaceTurn(state, 0, {
      ...latest,
      turnId: turnId,
      status: "inProgress",
      turnStartedAtMs: latest.turnStartedAtMs ?? observedAtMs,
    }),
    index: 0,
  };
}

function applyCodexConversationTurnDiff(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string,
  diff: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = residentConversationTurns(resolved.state)[resolved.index]!;
  if (turn.diff === diff) return result(resolved.state, "applied", resolved.state !== state);
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    diff,
  });
  return result(next, "applied", true);
}

export function mutateCodexConversationTurnDiff(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string,
  diff: string,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationTurnDiff(
    state,
    conversationId,
    turnId,
    diff,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationTurnDiff(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string,
  diff: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationTurnDiff(draft, conversationId, turnId, diff, observedAtMs);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

function applyCodexConversationSafetyBuffering(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string,
  safetyBuffering: CodexCanonicalSafetyBufferingState,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = residentConversationTurns(resolved.state)[resolved.index]!;
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    safetyBuffering,
  });
  return result(next, "applied", true);
}

export function mutateCodexConversationSafetyBuffering(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string,
  safetyBuffering: CodexCanonicalSafetyBufferingState,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationSafetyBuffering(
    state,
    conversationId,
    turnId,
    safetyBuffering,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationSafetyBuffering(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string,
  safetyBuffering: CodexCanonicalSafetyBufferingState,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationSafetyBuffering(
      draft,
      conversationId,
      turnId,
      safetyBuffering,
      observedAtMs,
    );
  });
  return { ...operation, state: next, stateChanged: next !== state };
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
  state: Draft<CodexCanonicalConversationState>,
  turnId: string,
  observedAtMs: number,
): {
  readonly state: Draft<CodexCanonicalConversationState>;
  readonly index: number;
} {
  const previous = residentConversationTurns(state).at(-1) ?? null;
  const turn: CodexCanonicalTurnState = {
    turnId: turnId,
    itemsView: "full",
    status: "inProgress",
    error: null,
    durationMs: null,
    items: [],
    params: previous?.params ?? buildCodexCanonicalSyntheticTurnParams(state, previous),
    diff: null,
    turnStartedAtMs: observedAtMs,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    hookRuns: [],
  };
  const index = residentConversationTurns(state).length;
  appendConversationTurnDraft(state, turn, () => globalThis.crypto.randomUUID());
  return { state, index };
}

function resolveHookTurn(
  state: Draft<CodexCanonicalConversationState>,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  observedAtMs: number,
): {
  readonly state: Draft<CodexCanonicalConversationState>;
  readonly index: number;
} | null {
  if (turnId === null) {
    const latestIndex = residentConversationTurns(state).length - 1;
    return latestIndex < 0 ? null : { state, index: latestIndex };
  }
  const exactIndex = residentConversationTurns(state).findIndex((turn) => turn.turnId === turnId);
  if (exactIndex >= 0) return { state, index: exactIndex };
  if (method === "hook/completed") return resolveMetadataTurn(state, turnId, observedAtMs);
  const latestIndex = residentConversationTurns(state).length - 1;
  const latest = residentConversationTurns(state)[latestIndex];
  if (latest?.turnId === null && latest.status === "inProgress") {
    return {
      state: replaceTurn(state, latestIndex, {
        ...latest,
        turnId: turnId,
      }),
      index: latestIndex,
    };
  }
  return synthesizeHookTurn(state, turnId, observedAtMs);
}

function applyCodexConversationHookRun(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  run: HookRunSummary,
  observedAtMs: number,
): CodexTurnMetadataResult {
  if (state.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveHookTurn(state, turnId, method, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const turn = residentConversationTurns(resolved.state)[resolved.index]!;
  const hooks = turn.hookRuns ?? [];
  const next = replaceTurn(resolved.state, resolved.index, {
    ...turn,
    hookRuns: upsertHookRun(hooks, run),
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

export function mutateCodexConversationHookRun(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  run: HookRunSummary,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationHookRun(
    state,
    conversationId,
    turnId,
    method,
    run,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationHookRun(
  state: CodexCanonicalConversationState,
  conversationId: string,
  turnId: string | null,
  method: "hook/started" | "hook/completed",
  run: HookRunSummary,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationHookRun(
      draft,
      conversationId,
      turnId,
      method,
      run,
      observedAtMs,
    );
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

function replaceResolvedTurnItem(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  turnId: string,
  observedAtMs: number,
  update: (items: Draft<CodexCanonicalItem>[]) => void,
): CodexTurnMetadataResult {
  if (state.id !== conversationId) return result(state, "foreignConversation");
  const resolved = resolveMetadataTurn(state, turnId, observedAtMs);
  if (!resolved) return result(state, "missingTurn");
  const entry = residentConversationTurnEntries(resolved.state)[resolved.index]!;
  const turn = conversationTurnDraft(state, entry.address)!;
  turn.hookRuns ??= [];
  update(turn.items);
  return result(state, "applied", true);
}

function applyCodexConversationTurnPlan(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"turn/plan/updated">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, explanation, plan } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => {
    items.push({ id: itemId, type: "todo-list", explanation, plan });
  });
}

export function mutateCodexConversationTurnPlan(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"turn/plan/updated">,
  itemId: string,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationTurnPlan(
    state,
    notification,
    itemId,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationTurnPlan(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"turn/plan/updated">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationTurnPlan(draft, notification, itemId, observedAtMs);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

function applyCodexConversationModelRerouted(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"model/rerouted">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, fromModel, toModel, reason } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => {
    items.push({ id: itemId, type: "modelRerouted", fromModel, toModel, reason });
  });
}

export function mutateCodexConversationModelRerouted(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"model/rerouted">,
  itemId: string,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationModelRerouted(
    state,
    notification,
    itemId,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationModelRerouted(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"model/rerouted">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationModelRerouted(draft, notification, itemId, observedAtMs);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

function applyCodexConversationError(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"error">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  const { threadId, turnId, error, willRetry } = notification.params;
  return replaceResolvedTurnItem(state, threadId, turnId, observedAtMs, (items) => {
    items.push({
      id: itemId,
      type: "error",
      message: error.message,
      willRetry,
      errorInfo: error.codexErrorInfo,
      additionalDetails: error.additionalDetails,
    });
  });
}

export function mutateCodexConversationError(
  state: Draft<CodexCanonicalConversationState>,
  notification: NotificationOf<"error">,
  itemId: string,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationError(
    state,
    notification,
    itemId,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationError(
  state: CodexCanonicalConversationState,
  notification: NotificationOf<"error">,
  itemId: string,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationError(draft, notification, itemId, observedAtMs);
  });
  return { ...operation, state: next, stateChanged: next !== state };
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

function applyCodexConversationAutomaticApprovalReview(
  state: Draft<CodexCanonicalConversationState>,
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
      if (index < 0) {
        items.push(item as Draft<CodexCanonicalItem>);
        return;
      }
      items[index] = item as Draft<CodexCanonicalItem>;
    },
  );
  if (reduced.disposition !== "applied") return reduced;
  state.updatedAt = observedAtMs;
  return reduced;
}

export function mutateCodexConversationAutomaticApprovalReview(
  state: Draft<CodexCanonicalConversationState>,
  notification:
    | NotificationOf<"item/autoApprovalReview/started">
    | NotificationOf<"item/autoApprovalReview/completed">,
  observedAtMs: number,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationAutomaticApprovalReview(
    state,
    notification,
    observedAtMs,
  );
  return { disposition, effects };
}

export function reduceCodexConversationAutomaticApprovalReview(
  state: CodexCanonicalConversationState,
  notification:
    | NotificationOf<"item/autoApprovalReview/started">
    | NotificationOf<"item/autoApprovalReview/completed">,
  observedAtMs: number,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationAutomaticApprovalReview(draft, notification, observedAtMs);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

function applyCodexConversationGuardianWarning(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  itemId: string,
): CodexTurnMetadataResult {
  if (state.id !== conversationId) return result(state, "foreignConversation");
  const index = residentConversationTurns(state).length - 1;
  if (index < 0) return result(state, "missingTurn");
  const entry = residentConversationTurnEntries(state)[index]!;
  const turn = conversationTurnDraft(state, entry.address)!;
  turn.hookRuns ??= [];
  turn.items.push({ id: itemId, type: "autoReviewInterruptionWarning" });
  return result(state, "applied", true);
}

export function mutateCodexConversationGuardianWarning(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  itemId: string,
): Omit<CodexTurnMetadataResult, "state" | "stateChanged"> {
  const { disposition, effects } = applyCodexConversationGuardianWarning(
    state,
    conversationId,
    itemId,
  );
  return { disposition, effects };
}

export function reduceCodexConversationGuardianWarning(
  state: CodexCanonicalConversationState,
  conversationId: string,
  itemId: string,
): CodexTurnMetadataResult {
  let operation: Omit<CodexTurnMetadataResult, "state" | "stateChanged"> = {
    disposition: "missingTurn",
    effects: [],
  };
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationGuardianWarning(draft, conversationId, itemId);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}
