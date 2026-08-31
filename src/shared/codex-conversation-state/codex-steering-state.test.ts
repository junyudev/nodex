import { describe, expect, test } from "vite-plus/test";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalSteeringUserMessageItem,
} from "./codex-conversation-state";
import {
  removeCodexCanonicalSteeringItem,
  retargetCodexCanonicalSteeringItem,
  upsertCodexCanonicalSteeringItem,
} from "./codex-steering-state";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";

function buildState(): CodexCanonicalConversationState {
  return createCodexCanonicalHydratedConversationState(
    {
      id: "thread-a",
      extra: null,
      sessionId: "session-a",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "active", activeFlags: [] },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: "appServer",
      name: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [
        {
          id: "turn-a",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    },
    {
      model: "gpt-test",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    },
  );
}

function buildSteer(id = "steer-a"): CodexCanonicalSteeringUserMessageItem {
  return {
    type: "steeringUserMessage",
    id,
    targetTurnId: "turn-a",
    targetTurnStartedAtMs: 10,
    status: "pending",
    clientUserMessageId: id,
    input: [{ type: "text", text: "continue", text_elements: [] }],
    attachments: [{ path: "/workspace/file.ts" }],
    restoreMessage: {
      queueRow: createCodexQueuedFollowUp({
        followUpId: `follow-up-${id}`,
        clientUserMessageId: `client-${id}`,
        threadId: "thread-a",
        prompt: "continue",
        createdAtMs: 10,
      }),
      context: { commentAttachments: [] },
    },
    compareKey: { rawText: "continue", imageCount: 0 },
  };
}

describe("canonical steering state", () => {
  test("upserts the pending steer into the target raw turn", () => {
    const state = buildState();
    const next = upsertCodexCanonicalSteeringItem(state, "turn-a", buildSteer());

    expect(next.turns[0]?.items[0]?.type).toBe("steeringUserMessage");
    expect(next.turns[0]?.items[0]?.id).toBe("steer-a");
    expect(next.turns[0]?.items[0] === buildSteer()).toBe(false);
  });

  test("removes only the failed pending steer", () => {
    const first = upsertCodexCanonicalSteeringItem(buildState(), "turn-a", buildSteer());
    const second = upsertCodexCanonicalSteeringItem(first, "turn-a", buildSteer("steer-b"));
    const next = removeCodexCanonicalSteeringItem(second, "turn-a", "steer-a");

    expect(next.turns[0]?.items.length).toBe(1);
    expect(next.turns[0]?.items[0]?.id).toBe("steer-b");
  });

  test("retargets the same steer identity to a newer active turn", () => {
    const initial = buildState();
    const withTarget = {
      ...initial,
      turns: [
        initial.turns[0]!,
        {
          ...initial.turns[0]!,
          protocol: { ...initial.turns[0]!.protocol, id: "turn-b" },
          items: [],
          sidecar: { ...initial.turns[0]!.sidecar, turnStartedAtMs: 20 },
        },
      ],
    };
    const pending = upsertCodexCanonicalSteeringItem(withTarget, "turn-a", buildSteer());
    const next = retargetCodexCanonicalSteeringItem(pending, "turn-a", "turn-b", "steer-a");

    expect(next.turns[0]?.items).toEqual([]);
    expect(next.turns[1]?.items[0]).toMatchObject({
      id: "steer-a",
      clientUserMessageId: "steer-a",
      targetTurnId: "turn-b",
      targetTurnStartedAtMs: 20,
    });
  });
});
