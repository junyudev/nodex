import { describe, expect, test } from "vitest";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalTurnState } from "./types";
import { collectCodexSubagentInteractionReferences } from "./codex-subagent-interaction";

type InteractionItem = Extract<
  CodexCanonicalTurnState["items"][number],
  { type: "subAgentActivity" | "collabAgentToolCall" }
>;

const activity: InteractionItem = {
  type: "subAgentActivity",
  id: "activity",
  kind: "started",
  agentThreadId: "child",
  agentPath: "root/child",
};
const collaboration = (
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"],
): InteractionItem => ({
  type: "collabAgentToolCall",
  id: tool,
  tool,
  status: "completed",
  senderThreadId: "root",
  receiverThreadIds: ["child"],
  receiverThreads: [],
  prompt: null,
  model: null,
  reasoningEffort: null,
  agentsStates: {},
});
const turn = (turnId: string, items: InteractionItem[]) => ({ turnId, items });

// These cases distinguish execution/status evidence from permission to send user input.
describe("subagent messaging evidence", () => {
  test.each([
    { name: "modern activity", turns: [turn("a", [activity])], expected: false },
    {
      name: "explicit collaborative spawn",
      turns: [turn("a", [collaboration("spawnAgent")])],
      expected: true,
    },
    {
      name: "same-turn activity after spawn",
      turns: [turn("a", [collaboration("spawnAgent"), activity])],
      expected: true,
    },
    {
      name: "activity in a later turn",
      turns: [turn("a", [collaboration("spawnAgent")]), turn("b", [activity])],
      expected: false,
    },
    {
      name: "follow-up sendInput preserves spawn",
      turns: [turn("a", [collaboration("spawnAgent")]), turn("b", [collaboration("sendInput")])],
      expected: true,
    },
    {
      name: "sendInput alone grants nothing",
      turns: [turn("a", [collaboration("sendInput")])],
      expected: false,
    },
    {
      name: "resume alone grants nothing",
      turns: [turn("a", [collaboration("resumeAgent")])],
      expected: false,
    },
    {
      name: "completion preserves same-turn spawn",
      turns: [turn("a", [collaboration("spawnAgent"), { ...activity, kind: "completed" }])],
      expected: true,
    },
    {
      name: "completed modern activity",
      turns: [turn("a", [{ ...activity, kind: "completed" }])],
      expected: false,
    },
    {
      name: "new explicit spawn restores eligibility",
      turns: [turn("a", [activity]), turn("b", [collaboration("spawnAgent")])],
      expected: true,
    },
  ])("$name", ({ turns, expected }) => {
    expect(collectCodexSubagentInteractionReferences(turns).get("child")?.canInteract).toBe(
      expected,
    );
  });

  test("metadata and other receivers cannot authorize a missing child", () => {
    expect(collectCodexSubagentInteractionReferences([]).get("child")).toBeUndefined();
    expect(
      collectCodexSubagentInteractionReferences([turn("a", [collaboration("spawnAgent")])]).get(
        "other",
      ),
    ).toBeUndefined();
  });
});

test("message markers require membership and reset a prior grant across parent turns", () => {
  const message: InteractionItem = { ...activity, kind: "interacted" };
  expect(collectCodexSubagentInteractionReferences([turn("message", [message])]).size).toBe(0);
  expect(
    collectCodexSubagentInteractionReferences([
      turn("spawn", [collaboration("spawnAgent")]),
      turn("message", [message]),
    ]).get("child"),
  ).toEqual({ parentTurnKey: "message", canInteract: false });
});
