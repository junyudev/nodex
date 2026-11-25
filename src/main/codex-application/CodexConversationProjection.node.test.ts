import { describe, expect, test } from "vite-plus/test";
import {
  assert,
  it,
  describe as describeCodexConversationServerRequestProjection,
  expect as expectCodexConversationServerRequestProjection,
} from "@effect/vitest";
import { produce } from "immer";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalTurnState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { codexCanonicalConversationActivityStatus } from "./CodexConversationProjection";
import { reduceCodexConversationEvent } from "../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  buildCodexCanonicalTurnSummary,
  projectCodexConversationPlanImplementationCompleted,
} from "./CodexConversationServerRequestProjection";
import { projectCodexConversationTurn } from "./CodexConversationSnapshotProjection";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { codexHostMessageParts } from "../../shared/codex-host-chunked-message";
import type { CodexConversationSnapshot } from "../../shared/types";

describe("CodexConversationProjection", () => {
  function fixture() {
    return createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread(), {
      hostId: "local",
      model: "fixture-model",
      reasoningEffort: null,
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/work"],
    });
  }

  it("a completed canonical native Turn suppresses its stale running legacy copy", () => {
    const legacy = fixture();
    const canonical = produce(legacy, (draft) => {
      replaceCanonicalHistoryDraft(
        draft,
        legacy.turns.map((turn) => ({ ...turn, status: "completed" })),
        true,
      );
    });
    const state = {
      ...canonical,
      turns: legacy.turns.map((turn) => ({ ...turn, status: "inProgress" as const })),
    };
    assert.strictEqual(codexCanonicalConversationActivityStatus(state), "idle");
  });
});

describe("CodexConversationSnapshotProjection", () => {
  test("projects actual assistant start independently of hydration and projection clocks", () => {
    const state = conversationFixture("child", [
      { ...turnFixture("turn", "inProgress"), startedAt: 1, completedAt: null },
    ]);
    const next = reduceCodexConversationEvent(
      state,
      {
        type: "notification",
        notification: {
          method: "item/started",
          params: {
            threadId: "child",
            turnId: "turn",
            startedAtMs: 2500,
            item: {
              type: "agentMessage",
              moderation: null,
              id: "answer",
              text: "",
              phase: "final_answer",
              questions: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      },
      { now: () => 10000 },
    );
    const projected = projectCodexConversationTurn({
      threadId: "child",
      turnIndex: 0,
      beforeTurn: state.turns[0]!,
      afterTurn: next.turns[0]!,
      current: null,
      observedAtMs: 20000,
    });
    expect(projected.assistantMessageStartedAtMsById).toEqual({ answer: 2500 });
    expect(projected.finalAssistantStartedAtMs).toBe(2500);
    expect(projected.assistantResponseWorkDurationMs).toBe(0);
    expect(projected.turnStartedAtMs).toBe(1000);
    expect(projected.completedAt).toBeNull();
    expect(
      buildCodexCanonicalTurnSummary("child", next.turns[0]!, ["answer"])
        .assistantMessageStartedAtMsById,
    ).toEqual({ answer: 2500 });
  });
});

describe("CodexConversationServerRequestProjection", () => {
  const describe = describeCodexConversationServerRequestProjection;
  const expect = expectCodexConversationServerRequestProjection;
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
});
