import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conversationTurnsWithOverlay } from "../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexConversationSnapshot } from "../../shared/types";
import { projectCodexMarkdownLabel } from "../../shared/codex-markdown-text";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexConversationView {
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly generation: number;
  readonly historyCheckpoint: readonly [
    entityGeneration: number,
    historyGeneration: number,
    mutationRevision: number,
  ];
  readonly snapshot: CodexConversationSnapshot | null;
}

export interface CodexConversationActivity {
  readonly active: boolean;
  readonly label: string | null;
  readonly pending: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const hasRunningAgentState = (value: unknown): boolean => {
  const record = asRecord(value);
  if (!record) return false;
  if (record.status === "running") return true;
  const agentStates = asRecord(record.agentsStates);
  if (agentStates && Object.values(agentStates).some(hasRunningAgentState)) return true;
  return hasRunningAgentState(record.action);
};

const hasRunningCollaboration = (items: readonly CodexCanonicalItem[]): boolean =>
  items.some(
    (item) =>
      item.type === "collabAgentToolCall" &&
      (item.status === "inProgress" || hasRunningAgentState(item.agentsStates)),
  );

const hasPendingSteering = (items: readonly CodexCanonicalItem[]): boolean =>
  items.some((item) => item.type === "steeringUserMessage" && item.status === "pending");

const activityOf = (view: CodexConversationView | null): CodexConversationActivity => {
  if (!view) return { active: false, pending: false, label: null };
  const canonical = view.canonicalState;
  const snapshot = view.snapshot;
  const turns = conversationTurnsWithOverlay(canonical);
  const items = turns.flatMap((turn) => turn.items);
  return {
    active:
      canonical?.threadRuntimeStatus.type === "active" ||
      turns.some((turn) => turn.status === "inProgress") ||
      hasRunningCollaboration(items) ||
      canonical?.threadGoal?.status === "active" ||
      snapshot?.statusType === "active" ||
      snapshot?.turns.some((turn) => turn.status === "inProgress") ||
      snapshot?.threadGoal?.status === "active" ||
      false,
    pending:
      (canonical?.threadRuntimeStatus.type === "active" &&
        canonical.threadRuntimeStatus.activeFlags.length > 0) ||
      (canonical?.requests.length ?? 0) > 0 ||
      hasPendingSteering(items) ||
      (snapshot?.statusActiveFlags.length ?? 0) > 0 ||
      (snapshot?.requests.length ?? 0) > 0 ||
      (snapshot?.pendingSteers.length ?? 0) > 0,
    label: projectCodexMarkdownLabel(canonical?.title ?? snapshot?.threadName),
  };
};

/** Immutable cross-subsystem view of the private Conversation Entity map. */
export class CodexConversations extends Context.Service<
  CodexConversations,
  {
    readonly activity: (threadId: string) => CodexConversationActivity;
    readonly latestTurnId: (threadId: string) => string | null;
    readonly read: (threadId: string) => CodexConversationView | null;
    readonly retire: (threadId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexConversations") {}

export const live: Layer.Layer<CodexConversations, never, ConversationEntityMap> = Layer.effect(
  CodexConversations,
  Effect.gen(function* () {
    const entities = yield* ConversationEntityMap;
    const read = (threadId: string): CodexConversationView | null => {
      const entity = entities.current(threadId);
      if (!entity) return null;
      const state = entity.read();
      return {
        canonicalState: state.canonicalState,
        generation: state.generation,
        historyCheckpoint: [
          state.generation,
          state.historyTopology.generation,
          state.historyMutationRevision,
        ],
        snapshot: state.snapshot,
      };
    };
    return CodexConversations.of({
      activity: (threadId) => activityOf(read(threadId)),
      latestTurnId: (threadId) => {
        const turns = conversationTurnsWithOverlay(read(threadId)?.canonicalState);
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const turnId = turns[index]?.turnId;
          if (turnId) return turnId;
        }
        return null;
      },
      read,
      retire: entities.retire,
    });
  }),
);
