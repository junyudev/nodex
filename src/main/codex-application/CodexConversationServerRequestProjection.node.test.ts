import { describe, expect, it } from "@effect/vitest";
import { codexHostMessageParts } from "../../shared/codex-host-chunked-message";
import type { CodexCanonicalTurnState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  buildCodexCanonicalTurnSummary,
  projectCodexConversationPlanImplementationCompleted,
} from "./CodexConversationServerRequestProjection";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";

const terminalTurn = {
  rootTurnId: null,
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

it.each([
  { historyMode: "paginated" as const, ephemeral: false, editable: true },
  { historyMode: "legacy" as const, ephemeral: false, editable: false },
  { historyMode: "paginated" as const, ephemeral: true, editable: false },
])("restricts message editing to persistent paginated history (%j)", (options) => {
  const state = {
    ...conversationFixture("thread-edit", [turnFixture("turn-edit")]),
    historyMode: options.historyMode,
    ephemeral: options.ephemeral,
  };
  const conversation: CodexConversationSnapshot = {
    threadId: state.id,
    projectId: null,
    source: null,
    threadName: state.title,
    threadPreview: "",
    cwd: state.cwd,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    linkedAt: "",
    resumeState: "resumed",
    canonicalState: state,
    turns: [
      {
        ...buildCodexCanonicalTurnSummary(state.id, state.turns[0]!, ["user-message"]),
        items: [
          {
            threadId: state.id,
            turnId: "turn-edit",
            itemId: "user-message",
            type: "userMessage",
            kind: "userMessage",
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      },
    ],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
  const projected = projectCodexConversationPlanImplementationCompleted({
    conversation,
    state,
    turnId: "turn-edit",
  });

  expect(projected.capabilityFlags.canEditUserTurns).toBe(options.editable);
});
