import { describe, expect, it } from "@effect/vitest";
import { codexHostMessageParts } from "../../shared/codex-host-chunked-message";
import type { CodexCanonicalTurnState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";

const terminalTurn = {
  turnId: "turn-terminal",
  itemsView: "full",
  status: "interrupted",
  error: null,
  durationMs: null,
  items: [],
  diff: null,
  turnStartedAtMs: null,
  completedAtMs: null,
  firstTurnWorkItemStartedAtMs: null,
  finalAssistantStartedAtMs: null,
  hookRuns: [],
} satisfies Omit<CodexCanonicalTurnState, "params">;

describe("buildCodexCanonicalTurnSummary", () => {
  it("projects a no-error terminal turn as strict renderer-delivery JSON", () => {
    const turn = buildCodexCanonicalTurnSummary("thread-subagent", terminalTurn, []);

    expect(turn).not.toHaveProperty("errorMessage");
    expect(() => [
      ...codexHostMessageParts({ type: "turn", turn }, { transferId: "delivery:1" }),
    ]).not.toThrow();
  });
});
