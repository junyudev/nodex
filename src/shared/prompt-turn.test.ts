import { describe, expect, it } from "vite-plus/test";
import { projectPromptTurn, UNKNOWN_PROMPT_TURN } from "./prompt-turn";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

type Outcome = NonNullable<AgentRuntimeOperations["thread.message-turn"]["output"]>;
describe("Prompt Turn projection", () => {
  it.each([
    ["queued", "queued"],
    ["preparing", "working"],
    ["starting", "working"],
    ["running", "working"],
    ["waiting", "waiting"],
    ["completed", "done"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
    ["rolled_back", "unknown"],
  ] as const)("maps %s to %s without borrowing another Turn's activity", (status, phase) => {
    const outcome: Outcome = {
      runId: "original",
      status,
      completedAt: null,
      finalAssistantItemId: "answer",
    };
    const turn = projectPromptTurn(outcome, "**Final** answer");
    expect(turn).toEqual({
      phase,
      runId: "original",
      reply: phase === "done" ? "**Final** answer" : null,
    });
  });
  it("returns unknown for a missing, legacy, or unavailable message", () => {
    expect(projectPromptTurn(null)).toBe(UNKNOWN_PROMPT_TURN);
  });
});
