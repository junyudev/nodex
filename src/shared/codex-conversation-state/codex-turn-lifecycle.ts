import { decodeCodexAsyncQuestionReplies } from "../codex-async-user-input";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import { buildPlanImplementationRequestId } from "../codex-conversation-request";
import {
  buildCodexCanonicalSyntheticTurnParams,
  type CodexCanonicalConversationState,
  type CodexCanonicalPlanImplementationItem,
  type CodexCanonicalSteeringUserMessageItem,
  type CodexCanonicalSyntheticTurnParams,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import type { CodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import {
  applyCodexCanonicalPlanImplementationTurnStartedState,
  createCodexCanonicalPlanImplementationRequest,
  reduceCodexConversationServerRequest,
} from "./codex-server-request-lifecycle";

export type CodexTurnLifecycleMethod = "turn/started" | "turn/completed";

export interface CodexTurnLifecycleUpdate {
  readonly conversationId: string;
  readonly method: CodexTurnLifecycleMethod;
  readonly turn: Pick<Turn, "id" | "status" | "error" | "startedAt" | "completedAt" | "durationMs">;
  readonly observedAtMs: number;
}

export interface CodexTurnLifecycleResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: "applied" | "foreignConversation" | "missingTurn";
  readonly stateChanged: boolean;
  readonly effects: readonly CodexTurnLifecycleEffect[];
}

export interface CodexRestoreUnacceptedSteersEffect {
  readonly type: "restoreUnacceptedSteers";
  readonly terminalStatus: Turn["status"];
  readonly rows: readonly CodexQueuedFollowUp[];
}

export type CodexTurnLifecycleEffect = CodexRestoreUnacceptedSteersEffect;

function protocolSecondsToMilliseconds(value: number | null): number | null {
  return value === null ? null : value * 1_000;
}

function buildStartedTurnParams(
  state: CodexCanonicalConversationState,
  previousTurn: CodexCanonicalTurnState | null,
): CodexCanonicalSyntheticTurnParams {
  const fallback = buildCodexCanonicalSyntheticTurnParams(state, previousTurn);
  const hydration = state.sidecar.hydrationContext;
  const settings = hydration?.latestThreadSettings;
  return {
    ...fallback,
    cwd: settings?.cwd ?? previousTurn?.sidecar.params.cwd ?? hydration?.cwd ?? null,
    approvalPolicy:
      settings?.approvalPolicy ??
      previousTurn?.sidecar.params.approvalPolicy ??
      hydration?.currentPermissions.approvalPolicy ??
      fallback.approvalPolicy,
    approvalsReviewer:
      settings?.approvalsReviewer ??
      previousTurn?.sidecar.params.approvalsReviewer ??
      hydration?.currentPermissions.approvalsReviewer ??
      fallback.approvalsReviewer,
    sandboxPolicy:
      settings?.sandboxPolicy ??
      previousTurn?.sidecar.params.sandboxPolicy ??
      hydration?.currentPermissions.sandboxPolicy ??
      fallback.sandboxPolicy,
    model: settings?.model ?? previousTurn?.sidecar.params.model ?? hydration?.latestModel ?? null,
    serviceTier: settings?.serviceTier ?? previousTurn?.sidecar.params.serviceTier ?? null,
    effort:
      settings?.effort ??
      previousTurn?.sidecar.params.effort ??
      hydration?.latestReasoningEffort ??
      "minimal",
    personality: settings?.personality ?? previousTurn?.sidecar.params.personality ?? null,
    outputSchema: previousTurn?.sidecar.params.outputSchema ?? null,
    collaborationMode:
      settings?.collaborationMode ?? previousTurn?.sidecar.params.collaborationMode ?? null,
  };
}

function buildStartedTurn(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): CodexCanonicalTurnState {
  const previousTurn = state.turns.at(-1) ?? null;
  return {
    protocol: {
      id: update.turn.id,
      itemsView: "full",
      status: update.turn.status,
      error: update.turn.error,
      durationMs: update.turn.durationMs,
    },
    items: [],
    sidecar: {
      params: buildStartedTurnParams(state, previousTurn),
      diff: null,
      turnStartedAtMs: update.observedAtMs,
      completedAtMs: protocolSecondsToMilliseconds(update.turn.completedAt),
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      hookRuns: [],
    },
  };
}

function completeStalePlanImplementationItems(
  turns: readonly CodexCanonicalTurnState[],
  activeTurnId: string,
): readonly CodexCanonicalTurnState[] {
  return turns.map((turn) => {
    if (turn.protocol.id === activeTurnId) return turn;
    let changed = false;
    const items = turn.items.map((item) => {
      if (item.type !== "planImplementation" || item.isCompleted) return item;
      changed = true;
      return { ...item, isCompleted: true };
    });
    return changed ? { ...turn, items } : turn;
  });
}

function applyTurnStarted(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): CodexCanonicalConversationState {
  const existingIndex = state.turns.findIndex((turn) => turn.protocol.id === update.turn.id);
  const placeholderIndex =
    existingIndex < 0
      ? state.turns.findLastIndex(
          (turn) => turn.protocol.id === null && turn.protocol.status === "inProgress",
        )
      : -1;
  const targetIndex = existingIndex >= 0 ? existingIndex : placeholderIndex;
  const turns = [...state.turns];
  if (targetIndex >= 0) {
    const existing = turns[targetIndex];
    if (!existing) return state;
    turns[targetIndex] = {
      ...existing,
      protocol: {
        ...existing.protocol,
        id: update.turn.id,
        status: update.turn.status,
        error: update.turn.error,
        durationMs: update.turn.durationMs,
      },
      sidecar: {
        ...existing.sidecar,
        turnStartedAtMs: existing.sidecar.turnStartedAtMs ?? update.observedAtMs,
      },
    };
  } else {
    turns.push(buildStartedTurn(state, update));
  }
  const withTurn = { ...state, turns: completeStalePlanImplementationItems(turns, update.turn.id) };
  return applyCodexCanonicalPlanImplementationTurnStartedState(withTurn, update.turn.id);
}

function buildPlanImplementationItem(
  turnId: string,
  planContent: string,
): CodexCanonicalPlanImplementationItem {
  return {
    id: buildPlanImplementationRequestId(turnId),
    type: "planImplementation",
    turnId,
    planContent,
    isCompleted: false,
  };
}

function applyCompletedPlanFollowUp(
  state: CodexCanonicalConversationState,
  turnIndex: number,
  observedAtMs: number,
): CodexCanonicalConversationState {
  const turn = state.turns[turnIndex];
  if (!turn || turn.protocol.id === null || turn.protocol.status !== "completed") return state;
  const plan = turn.items.findLast((item) => item.type === "plan");
  const planContent = plan?.text.trim() ?? "";
  if (!planContent) return state;

  const implementation = buildPlanImplementationItem(turn.protocol.id, planContent);
  const nextTurn = {
    ...turn,
    items: [...turn.items.filter((item) => item.type !== "planImplementation"), implementation],
  };
  const turns = [...state.turns];
  turns[turnIndex] = nextTurn;
  const withItem = { ...state, turns };
  return reduceCodexConversationServerRequest(
    withItem,
    createCodexCanonicalPlanImplementationRequest(
      state.protocol.id,
      turn.protocol.id,
      planContent,
      implementation.id,
    ),
    { now: () => observedAtMs },
  ).state;
}

function applyTurnCompleted(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): {
  readonly state: CodexCanonicalConversationState;
  readonly pendingSteers: readonly CodexCanonicalSteeringUserMessageItem[];
} | null {
  const turnIndex = state.turns.findIndex((turn) => turn.protocol.id === update.turn.id);
  const existing = state.turns[turnIndex];
  if (turnIndex < 0 || !existing) return null;
  const turns = [...state.turns];
  const pendingSteers = existing.items.filter(
    (item): item is CodexCanonicalSteeringUserMessageItem =>
      item.type === "steeringUserMessage" && item.status === "pending",
  );
  turns[turnIndex] = {
    ...existing,
    items: existing.items.filter(
      (item) => item.type !== "steeringUserMessage" || item.status !== "pending",
    ),
    protocol: {
      ...existing.protocol,
      id: update.turn.id,
      status: update.turn.status,
      error: update.turn.error,
      durationMs: update.turn.durationMs,
    },
    sidecar: {
      ...existing.sidecar,
      completedAtMs: protocolSecondsToMilliseconds(update.turn.completedAt),
    },
  };
  return {
    state: applyCompletedPlanFollowUp({ ...state, turns }, turnIndex, update.observedAtMs),
    pendingSteers,
  };
}

export function reduceCodexConversationTurnLifecycle(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): CodexTurnLifecycleResult {
  if (state.protocol.id !== update.conversationId) {
    return { state, disposition: "foreignConversation", stateChanged: false, effects: [] };
  }

  if (update.method === "turn/started") {
    const next = applyTurnStarted(state, update);
    return { state: next, disposition: "applied", stateChanged: next !== state, effects: [] };
  }

  const completed = applyTurnCompleted(state, update);
  if (!completed) {
    return { state, disposition: "missingTurn", stateChanged: false, effects: [] };
  }
  // A question reply belongs only to this Turn; ordinary steering can be recovered as follow-up work.
  const recoveryRows = completed.pendingSteers
    .map((item) => item.restoreMessage.queueRow)
    .filter((row) => decodeCodexAsyncQuestionReplies(row.prompt) === null);
  const effects: readonly CodexTurnLifecycleEffect[] =
    recoveryRows.length === 0
      ? []
      : [
          {
            type: "restoreUnacceptedSteers",
            terminalStatus: update.turn.status,
            rows: recoveryRows,
          },
        ];
  return {
    state: completed.state,
    disposition: "applied",
    stateChanged: completed.state !== state,
    effects,
  };
}
