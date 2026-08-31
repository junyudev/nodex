import { describe, expect, test } from "vite-plus/test";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2/ThreadGoal";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import {
  appendCodexCanonicalThreadGoalTranscriptTurn,
  buildCodexThreadGoalTranscriptProjection,
} from "./codex-thread-goal-transcript";
import { applyCodexLifecycleProjectionDiff } from "./codex-lifecycle-projection-diff";

const goal: ThreadGoal = {
  threadId: "thread-goal",
  objective: "Ship parity",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 2,
};

function buildState(): CodexCanonicalConversationState {
  return {
    protocol: {
      id: "thread-goal",
      extra: null,
      sessionId: "session-goal",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
    },
    turns: [],
    requests: [],
    sidecar: {
      hasUnreadTurn: false,
      hydrationContext: null,
      latestThreadSettings: {
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: null,
        effort: "high",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-test",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    },
  };
}

describe("Codex 30751 thread goal transcript", () => {
  test("stores the slash command only in canonical turn params", () => {
    const state = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal);
    const turn = state.turns[0];
    const input = turn?.sidecar.params.input[0];

    expect(String(state.turns.length)).toBe("1");
    expect(turn?.protocol.id).toBe(null);
    expect(turn?.protocol.status).toBe("completed");
    expect(String(turn?.items.length ?? -1)).toBe("0");
    expect(turn?.sidecar.turnStartedAtMs).toBe(2_000);
    expect(input?.type).toBe("text");
    expect(input?.type === "text" ? input.text : "").toBe("/goal Ship parity");
    expect(input?.type === "text" ? String(input.text_elements.length) : "-1").toBe("0");
    expect(turn?.sidecar.params.approvalPolicy).toBe("never");
    expect(turn?.sidecar.params.model).toBe(null);
    expect(turn?.sidecar.params.effort).toBe("minimal");
  });

  test("deduplicates the exact latest local turn and exposes a slash-free view projection", () => {
    const appended = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal);
    const duplicate = appendCodexCanonicalThreadGoalTranscriptTurn(appended, goal);
    const projection = buildCodexThreadGoalTranscriptProjection(goal);

    expect(duplicate === appended).toBe(true);
    expect(projection.promptText).toBe("/goal Ship parity");
    expect(projection.message).toBe("Ship parity");
    expect(projection.sentAtMs).toBe(2_000);
    expect(
      appendCodexCanonicalThreadGoalTranscriptTurn(
        { ...buildState(), protocol: { ...buildState().protocol, id: "other" } },
        goal,
      ).turns.length,
    ).toBe(0);
  });

  test("projects the local params turn without fabricating a protocol user item", () => {
    const turn = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal).turns[0];
    if (!turn) throw new Error("Missing goal turn");

    const projected = applyCodexLifecycleProjectionDiff({
      threadId: goal.threadId,
      turnKey: "turn-index-0",
      beforeTurn: null,
      afterTurn: turn,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 2_000,
    });

    expect(projected.views).toHaveLength(1);
    expect(projected.views[0]).toMatchObject({
      turnId: null,
      itemId: "turn-index-0:input",
      markdownText: "Ship parity",
      goal: true,
    });
    expect(projected.views[0]?.rawItem).toBeUndefined();
  });
});
