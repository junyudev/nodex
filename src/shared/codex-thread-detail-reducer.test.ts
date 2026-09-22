import { describe, expect, test } from "vite-plus/test";
import { mergeCodexTurnSummaries, mergeCodexTurnSummary } from "./codex-thread-detail-reducer";
import type { CodexTurnSummary } from "./types";

function buildTurn(overrides: Partial<CodexTurnSummary> = {}): CodexTurnSummary {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "inProgress",
    itemIds: [],
    ...overrides,
  };
}

describe("codex thread detail reducer", () => {
  test("preserves first work item timing across turn summary merges", () => {
    const existing = buildTurn({
      firstTurnWorkItemStartedAtMs: 123,
      itemIds: ["exec_1"],
    });
    const incoming = buildTurn({
      status: "completed",
      itemIds: ["assistant_1"],
    });

    const merged = mergeCodexTurnSummary(existing, incoming);

    expect(merged.firstTurnWorkItemStartedAtMs ?? 0).toBe(123);
    expect(merged.itemIds.join(",")).toBe("exec_1,assistant_1");
  });

  test("keeps cached first work item timing when refreshing turn lists", () => {
    const merged = mergeCodexTurnSummaries(
      [buildTurn({ status: "completed", itemIds: ["assistant_1"] })],
      [buildTurn({ firstTurnWorkItemStartedAtMs: 456, itemIds: ["exec_1"] })],
    );

    expect(merged.length).toBe(1);
    expect(merged[0]?.firstTurnWorkItemStartedAtMs ?? 0).toBe(456);
    expect(merged[0]?.itemIds.join(",") ?? "").toBe("exec_1,assistant_1");
  });

  test("keeps the whole observed command-start map over hydrated timing refreshes", () => {
    const merged = mergeCodexTurnSummary(
      buildTurn({
        commandExecutionStartedAtMsById: {
          observed: 100,
        },
      }),
      buildTurn({
        commandExecutionStartedAtMsById: {
          observed: 200,
          hydratedOnly: 300,
        },
      }),
    );

    expect(merged.commandExecutionStartedAtMsById?.observed).toBe(100);
    expect(merged.commandExecutionStartedAtMsById?.hydratedOnly).toBe(undefined);
  });
});

test("preserves observed assistant starts while merging additional message starts", () => {
  const existing = buildTurn({ assistantMessageStartedAtMsById: { commentary: 100, answer: 300 } });
  const merged = mergeCodexTurnSummary(
    existing,
    buildTurn({ assistantMessageStartedAtMsById: { answer: 900, followup: 500 } }),
  );
  expect(merged.assistantMessageStartedAtMsById).toEqual({
    commentary: 100,
    answer: 300,
    followup: 500,
  });
  expect(
    mergeCodexTurnSummary(merged, buildTurn({ status: "completed" }))
      .assistantMessageStartedAtMsById,
  ).toEqual(merged.assistantMessageStartedAtMsById);
});
