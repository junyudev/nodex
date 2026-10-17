import type { Turn } from "@nodex/codex-app-server-protocol/v2";

/** Fixed synthetic text keeps benchmark evidence reproducible and free of user content. */
export const buildTranscriptPerformanceCorpus = (turnCount: number): Turn[] =>
  Array.from({ length: turnCount }, (_, index) => ({
    id: `history-turn-${index.toString().padStart(4, "0")}`,
    rootTurnId: null,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1_700_000_000 + index * 2,
    completedAt: 1_700_000_001 + index * 2,
    durationMs: 1_000,
    items: [
      {
        type: "userMessage",
        id: `history-user-${index}`,
        clientId: null,
        content: [
          {
            type: "text",
            text: `Synthetic history ${index.toString().padStart(4, "0")}`,
            text_elements: [],
          },
        ],
      },
      {
        type: "agentMessage",
        id: `history-answer-${index}`,
        text: `Synthetic answer ${index.toString().padStart(4, "0")}. ${"The reproducible transcript contains plain text for bounded history measurement. ".repeat(8)}`,
        phase: "final_answer",
        delivery: null,
        memoryCitation: null,
        questions: null,
      },
    ],
  }));
