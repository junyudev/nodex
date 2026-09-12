import { produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
  appendConversationTurnDraft,
} from "./codex-turn-mutation";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import { buildPlanImplementationRequestId } from "../codex-conversation-request";
import {
  buildCodexCanonicalSyntheticTurnParams,
  type CodexCanonicalConversationState,
  type CodexCanonicalSyntheticTurnParams,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  mutateCodexCanonicalPlanImplementationTurnStarted,
  createCodexCanonicalPlanImplementationRequest,
  mutateCodexConversationServerRequest,
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

export type CodexTurnLifecycleEffect = never;

function protocolSecondsToMilliseconds(value: number | null): number | null {
  return value === null ? null : value * 1000;
}

function buildStartedTurnParams(
  state: CodexCanonicalConversationState,
  previousTurn: CodexCanonicalTurnState | null,
): CodexCanonicalSyntheticTurnParams {
  const fallback = buildCodexCanonicalSyntheticTurnParams(state, previousTurn);
  const hydration = state.hydrationContext;
  const settings = hydration?.latestThreadSettings;
  return {
    ...fallback,
    cwd: settings?.cwd ?? previousTurn?.params.cwd ?? hydration?.cwd ?? null,
    approvalPolicy:
      settings?.approvalPolicy ??
      previousTurn?.params.approvalPolicy ??
      state.currentPermissions?.approvalPolicy ??
      fallback.approvalPolicy,
    approvalsReviewer:
      settings?.approvalsReviewer ??
      previousTurn?.params.approvalsReviewer ??
      state.currentPermissions?.approvalsReviewer ??
      fallback.approvalsReviewer,
    sandboxPolicy:
      settings?.sandboxPolicy ??
      previousTurn?.params.sandboxPolicy ??
      state.currentPermissions?.sandboxPolicy ??
      fallback.sandboxPolicy,
    model: settings?.model ?? previousTurn?.params.model ?? hydration?.latestModel ?? null,
    serviceTier: settings?.serviceTier ?? previousTurn?.params.serviceTier ?? null,
    effort:
      settings?.effort ??
      previousTurn?.params.effort ??
      hydration?.latestReasoningEffort ??
      "minimal",
    personality: settings?.personality ?? previousTurn?.params.personality ?? null,
    outputSchema: previousTurn?.params.outputSchema ?? null,
    collaborationMode:
      settings?.collaborationMode ?? previousTurn?.params.collaborationMode ?? null,
  };
}

function buildStartedTurn(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): CodexCanonicalTurnState {
  const previousTurn = residentConversationTurns(state).at(-1) ?? null;
  return {
    turnId: update.turn.id,
    itemsView: "full",
    status: update.turn.status,
    error: update.turn.error,
    durationMs: update.turn.durationMs,
    items: [],
    params: buildStartedTurnParams(state, previousTurn),
    diff: null,
    turnStartedAtMs: update.observedAtMs,
    completedAtMs: protocolSecondsToMilliseconds(update.turn.completedAt),
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    hookRuns: [],
  };
}

export function mutateCodexConversationTurnLifecycle(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexTurnLifecycleUpdate,
): Omit<CodexTurnLifecycleResult, "state" | "stateChanged"> {
  if (state.id !== update.conversationId)
    return { disposition: "foreignConversation", effects: [] };
  const entries = residentConversationTurnEntries(state);
  const exact = entries.find(({ turn }) => turn.turnId === update.turn.id);
  if (update.method === "turn/started") {
    const entry =
      exact ?? entries.findLast(({ turn }) => turn.turnId === null && turn.status === "inProgress");
    if (entry) {
      const turn = conversationTurnDraft(state, entry.address)!;
      Object.assign(turn, {
        turnId: update.turn.id,
        status: update.turn.status,
        error: update.turn.error,
        durationMs: update.turn.durationMs,
      });
      turn.turnStartedAtMs ??= update.observedAtMs;
    } else
      appendConversationTurnDraft(state, buildStartedTurn(state, update), () =>
        globalThis.crypto.randomUUID(),
      );
    for (const candidate of residentConversationTurnEntries(state)) {
      if (candidate.turn.turnId === update.turn.id) continue;
      for (const item of conversationTurnDraft(state, candidate.address)!.items)
        if (item.type === "planImplementation") item.isCompleted = true;
    }
    mutateCodexCanonicalPlanImplementationTurnStarted(state, update.turn.id);
    return { disposition: "applied", effects: [] };
  }
  if (!exact) return { disposition: "missingTurn", effects: [] };
  const turn = conversationTurnDraft(state, exact.address)!;
  Object.assign(turn, {
    turnId: update.turn.id,
    status: update.turn.status,
    error: update.turn.error,
    durationMs: update.turn.durationMs,
    completedAtMs: protocolSecondsToMilliseconds(update.turn.completedAt),
  });
  const planContent =
    turn.status === "completed"
      ? (turn.items.findLast((item) => item.type === "plan")?.text.trim() ?? "")
      : "";
  if (planContent && turn.turnId !== null) {
    const id = buildPlanImplementationRequestId(turn.turnId);
    turn.items = turn.items.filter((item) => item.type !== "planImplementation");
    turn.items.push({
      id,
      type: "planImplementation",
      turnId: turn.turnId,
      planContent,
      isCompleted: false,
    });
    mutateCodexConversationServerRequest(
      state,
      createCodexCanonicalPlanImplementationRequest(state.id, turn.turnId, planContent, id),
      { now: () => update.observedAtMs },
    );
  }
  return { disposition: "applied", effects: [] };
}

export function reduceCodexConversationTurnLifecycle(
  state: CodexCanonicalConversationState,
  update: CodexTurnLifecycleUpdate,
): CodexTurnLifecycleResult {
  let operation!: Omit<CodexTurnLifecycleResult, "state" | "stateChanged">;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationTurnLifecycle(draft, update);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}
