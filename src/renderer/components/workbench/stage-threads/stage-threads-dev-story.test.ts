import { describe, expect, test } from "bun:test";
import { buildMockStandaloneDiffItem, buildMockThread } from "./stage-threads-dev-story-data";

describe("stage-threads dev story", () => {
  test("running mode includes in-progress thinking and tool-call items", () => {
    const thread = buildMockThread("running");
    const runningTurnId = "turn_demo_3";

    const inProgressReasoning = thread.items.find((item) =>
      item.turnId === runningTurnId &&
      item.normalizedKind === "reasoning" &&
      item.status === "inProgress"
    );
    const inProgressToolCall = thread.items.find((item) =>
      item.turnId === runningTurnId &&
      item.status === "inProgress" &&
      item.normalizedKind === "toolCall"
    );
    const inProgressTurn = thread.turns.find((turn) => turn.turnId === runningTurnId);
    const inProgressTurnItemCount = inProgressTurn?.itemIds.length ?? 0;

    expect(inProgressReasoning !== undefined).toBeTrue();
    expect(inProgressToolCall !== undefined).toBeTrue();
    expect(inProgressTurn?.status).toBe("inProgress");
    expect(inProgressTurnItemCount >= 3).toBeTrue();
    expect(inProgressTurn?.tokenUsage?.modelContextWindow).toBe(258_000);
  });

  test("includes a renderable file-change diff example", () => {
    const previewItem = buildMockStandaloneDiffItem();
    const args = previewItem.toolCall?.args as { changes?: unknown } | undefined;
    const result = previewItem.toolCall?.result as { diff?: string } | undefined;

    expect((result?.diff ?? "").includes("diff --git")).toBeTrue();
    expect((result?.diff ?? "").includes("file-change-tool-call.tsx")).toBeTrue();
    expect(Array.isArray(args?.changes)).toBeTrue();
  });
});
