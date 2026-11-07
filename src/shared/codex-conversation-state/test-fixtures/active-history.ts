import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "../codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./agent-activity-v2-corpus-provenance";

/** A resumed paginated conversation with one settled Turn per count, in one complete island. */
export function buildActiveHistoryFixture(
  counts: readonly number[] = [1500],
): CodexCanonicalConversationState {
  const thread = buildAgentActivityV2CorpusThread([]);
  const state = createCodexCanonicalHydratedConversationState(
    {
      ...thread,
      id: "thread",
      path: "/synthetic/thread.jsonl",
      turns: counts.map((count, turnIndex) => ({
        id: `turn-${turnIndex}`,
        rootTurnId: null,
        items: Array.from({ length: count }, (_, index) => ({
          type: "reasoning" as const,
          id: `item-${turnIndex}-${index}`,
          summary: [],
          content: [],
        })),
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      })),
    },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
  const entries = state.turns.map((_, index) => ({
    key: `entity-${index}`,
    value: `entity-${index}`,
  }));
  return {
    ...state,
    turns: [],
    resumeState: "resumed",
    historyMode: "paginated",
    turnHistory: {
      kind: "canonical",
      history: {
        generation: 1,
        isComplete: true,
        islands: [
          {
            id: "island",
            entries,
            olderBoundary: { status: "exhausted", boundaryId: "older" },
            newerBoundary: { status: "exhausted", boundaryId: "newer" },
          },
        ],
        entitiesByKey: Object.fromEntries(
          state.turns.map((turn, index) => [
            `entity-${index}`,
            {
              ...turn,
              completedItemIds: Object.fromEntries(turn.items.map((item) => [item.id, true])),
            },
          ]),
        ),
      },
    },
  };
}
