import { describe, expect, it } from "@effect/vitest";
import { encodeRendererDelivery } from "../../shared/renderer-delivery-transport";
import type { CodexCanonicalTurnState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";

const terminalTurn = {
  protocol: {
    id: "turn-terminal",
    status: "interrupted",
    error: null,
    durationMs: null,
  },
  items: [],
  sidecar: {
    diff: null,
    turnStartedAtMs: null,
    completedAtMs: null,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    hookRuns: [],
  },
} as unknown as CodexCanonicalTurnState;

describe("buildCodexCanonicalTurnSummary", () => {
  it("projects a no-error terminal turn as strict renderer-delivery JSON", () => {
    const turn = buildCodexCanonicalTurnSummary("thread-subagent", terminalTurn, []);

    expect(turn).not.toHaveProperty("errorMessage");
    expect(() =>
      encodeRendererDelivery({
        target: { targetId: "renderer:1", generation: 1 },
        transferId: "delivery:1",
        payload: {
          channel: "codex:event",
          args: [{ type: "turn", turn }],
        },
      }),
    ).not.toThrow();
  });
});
