import { describe, expect, test } from "vitest";
import {
  CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS,
  parseCodexHistoryResidencyPinsInput,
} from "./codex-history-residency-pins";

describe("Codex history residency pin transport", () => {
  test("normalizes and deduplicates an exact generation-scoped pin set", () => {
    expect(
      parseCodexHistoryResidencyPinsInput({
        threadId: " thread-1 ",
        expectedConversationGeneration: 5,
        expectedTopologyGeneration: 7,
        expectedHistoryMutationRevision: 11,
        turnIds: [" turn-2 ", "turn-2", "turn-3"],
        islandIds: [],
      }),
    ).toEqual({
      threadId: "thread-1",
      expectedConversationGeneration: 5,
      expectedTopologyGeneration: 7,
      expectedHistoryMutationRevision: 11,
      turnIds: ["turn-2", "turn-3"],
      islandIds: [],
    });
  });

  test("rejects stale-shaped, blank, or unbounded renderer input", () => {
    const base = {
      threadId: "thread-1",
      expectedConversationGeneration: 5,
      expectedTopologyGeneration: 7,
      expectedHistoryMutationRevision: 11,
      turnIds: [],
      islandIds: [],
    };
    expect(
      parseCodexHistoryResidencyPinsInput({ ...base, expectedConversationGeneration: 0 }),
    ).toBeNull();
    expect(
      parseCodexHistoryResidencyPinsInput({ ...base, expectedTopologyGeneration: -1 }),
    ).toBeNull();
    expect(
      parseCodexHistoryResidencyPinsInput({ ...base, expectedHistoryMutationRevision: -1 }),
    ).toBeNull();
    expect(parseCodexHistoryResidencyPinsInput({ ...base, threadId: " " })).toBeNull();
    expect(parseCodexHistoryResidencyPinsInput({ ...base, turnIds: [" "] })).toBeNull();
    expect(
      parseCodexHistoryResidencyPinsInput({
        ...base,
        turnIds: Array.from(
          { length: CODEX_HISTORY_RESIDENCY_MAX_VISIBLE_TURN_PINS + 1 },
          (_, index) => `turn-${index}`,
        ),
      }),
    ).toBeNull();
  });
});
