import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexApprovalNotificationId,
  buildCodexQuestionNotificationId,
  buildCodexRequestNotificationOccurrenceId,
  decideCodexRequestNotification,
  decideCodexTurnNotification,
  decideCodexTurnOccurrence,
  isCodexNotificationChildConversation,
  resolveCodexQuestionNotificationBody,
  resolveCodexApprovalNotificationBody,
  resolveCodexApprovalNotificationTitle,
  resolveCodexTurnNotificationBody,
  resolveCodexTurnNotificationReply,
  type CodexNotificationConversationFacts,
  type CodexTurnCompletedNotificationEvent,
} from "./codex-thread-notification";

function conversation(
  overrides: Partial<CodexNotificationConversationFacts> = {},
): CodexNotificationConversationFacts {
  return {
    conversationId: "thread-1",
    title: "Ship notifications",
    threadSource: null,
    parentThreadId: null,
    source: null,
    sideConversationParentNavigationPath: null,
    ...overrides,
  };
}

function turn(
  overrides: Partial<CodexTurnCompletedNotificationEvent> = {},
): CodexTurnCompletedNotificationEvent {
  return {
    type: "turn-completed",
    hostId: "local",
    conversation: conversation(),
    turnId: "turn-1",
    status: "completed",
    lastAgentMessage: "Done",
    heartbeatAssistantMessage: null,
    automationNotificationDecision: null,
    hasPendingContinuation: false,
    ...overrides,
  };
}

describe("codex thread notification policy", () => {
  test("approvals have their own identity and action copy", () => {
    expect(resolveCodexApprovalNotificationTitle("  Review change  ")).toBe(
      "Review change needs approval",
    );
    expect(resolveCodexApprovalNotificationTitle(null)).toBe("Nodex needs approval");
    expect(resolveCodexApprovalNotificationBody(" git push ")).toBe("git push");
    expect(resolveCodexApprovalNotificationBody(" ")).toBe(
      "Approve the requested action to proceed.",
    );
    expect(buildCodexApprovalNotificationId("local", 73)).toBe("approval-local-73");
    expect(buildCodexRequestNotificationOccurrenceId("approval", "local", "thread-1", 73)).not.toBe(
      buildCodexRequestNotificationOccurrenceId("question", "local", "thread-1", 73),
    );
    expect(buildCodexRequestNotificationOccurrenceId("approval", "local", "thread-1", 73)).not.toBe(
      buildCodexRequestNotificationOccurrenceId("approval", "local", "thread-1", "73"),
    );
  });

  test("only parent provenance classifies a child conversation", () => {
    expect(isCodexNotificationChildConversation(conversation())).toBe(false);
    expect(
      isCodexNotificationChildConversation(
        conversation({
          threadSource: "subagent",
          source: { subAgent: { other: "dynamic" } },
        }),
      ),
    ).toBe(false);
    expect(
      isCodexNotificationChildConversation(
        conversation({
          parentThreadId: "parent-1",
        }),
      ),
    ).toBe(true);
    expect(
      isCodexNotificationChildConversation(
        conversation({
          source: {
            subAgent: {
              thread_spawn: { parent_thread_id: "parent-2" },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  test("does not blanket suppress system, ephemeral-like, or side conversations", () => {
    const policy = {
      managed: false,
      isAppForegrounded: false,
      isConversationSeen: false,
      turnMode: "unfocused" as const,
    };
    expect(
      decideCodexTurnNotification(
        turn({
          conversation: conversation({ threadSource: "system" }),
        }),
        policy,
      ),
    ).toEqual({ type: "show" });
    expect(
      decideCodexTurnNotification(
        turn({
          conversation: conversation({
            source: { sideConversation: true },
            sideConversationParentNavigationPath: "project:p/session:s/thread:parent",
          }),
        }),
        policy,
      ),
    ).toEqual({ type: "show" });
  });

  test("applies turn suppression in reference order for every terminal status", () => {
    const always = {
      managed: false,
      isAppForegrounded: true,
      isConversationSeen: true,
      turnMode: "always" as const,
    };
    for (const status of ["completed", "failed", "interrupted"] as const) {
      expect(decideCodexTurnNotification(turn({ status }), always)).toEqual({ type: "show" });
    }
    expect(
      decideCodexTurnNotification(
        turn({
          automationNotificationDecision: "DONT_NOTIFY",
        }),
        always,
      ),
    ).toEqual({ type: "suppress", reason: "automation-dont-notify" });
    expect(
      decideCodexTurnNotification(
        turn({
          heartbeatAssistantMessage: {
            decision: "DONT_NOTIFY",
            visibleText: "Quiet",
            notificationMessage: null,
          },
        }),
        always,
      ),
    ).toEqual({ type: "suppress", reason: "heartbeat-dont-notify" });
    expect(
      decideCodexTurnNotification(
        turn({
          conversation: conversation({ parentThreadId: "parent" }),
        }),
        always,
      ),
    ).toEqual({ type: "suppress", reason: "child-conversation" });
    expect(
      decideCodexTurnNotification(
        turn({
          conversation: conversation({ threadSource: "realtime_voice" }),
        }),
        always,
      ),
    ).toEqual({ type: "suppress", reason: "realtime-voice" });
    expect(
      decideCodexTurnNotification(
        turn({
          hasPendingContinuation: true,
        }),
        always,
      ),
    ).toEqual({ type: "suppress", reason: "pending-continuation" });
    expect(decideCodexTurnNotification(turn({ hostId: "remote" }), always)).toEqual({
      type: "suppress",
      reason: "remote-host-turn",
    });
    expect(
      decideCodexTurnNotification(turn(), {
        ...always,
        turnMode: "off",
      }),
    ).toEqual({ type: "suppress", reason: "setting-disabled" });
    expect(
      decideCodexTurnNotification(turn(), {
        ...always,
        turnMode: "unfocused",
      }),
    ).toEqual({ type: "suppress", reason: "app-focused" });
    // A chat open on a phone is in front of the person even while no window is focused.
    expect(
      decideCodexTurnNotification(turn(), {
        ...always,
        isAppForegrounded: false,
        turnMode: "unfocused",
      }),
    ).toEqual({ type: "suppress", reason: "conversation-presented" });
  });

  test("the occurrence decision is shared by every channel and ignores desktop settings", () => {
    const unmanaged = { managed: false };
    expect(decideCodexTurnOccurrence(turn(), unmanaged)).toEqual({ type: "show" });
    expect(decideCodexTurnOccurrence(turn({ status: "interrupted" }), unmanaged)).toEqual({
      type: "show",
    });
    expect(decideCodexTurnOccurrence(turn({ hasPendingContinuation: true }), unmanaged)).toEqual({
      type: "suppress",
      reason: "pending-continuation",
    });
    expect(
      decideCodexTurnOccurrence(
        turn({ conversation: conversation({ parentThreadId: "parent" }) }),
        unmanaged,
      ),
    ).toEqual({ type: "suppress", reason: "child-conversation" });
    expect(resolveCodexTurnNotificationReply(turn({ lastAgentMessage: "  " }))).toBeNull();
  });

  test("suppresses requests only for settings, real children, or foreground presentation", () => {
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: true,
        isConversationSeen: false,
      }),
    ).toEqual({ type: "show" });
    expect(
      decideCodexRequestNotification(
        conversation({
          parentThreadId: "parent",
        }),
        {
          enabled: true,
          isConversationSeen: false,
        },
      ),
    ).toEqual({ type: "suppress", reason: "child-conversation" });
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: true,
        isConversationSeen: true,
      }),
    ).toEqual({ type: "suppress", reason: "conversation-presented" });
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: false,
        isConversationSeen: false,
      }),
    ).toEqual({ type: "suppress", reason: "setting-disabled" });
  });

  test("uses heartbeat copy precedence and exact request copy", () => {
    expect(
      resolveCodexTurnNotificationBody(
        turn({
          lastAgentMessage: "Agent",
          heartbeatAssistantMessage: {
            decision: "NOTIFY",
            visibleText: "Visible",
            notificationMessage: "Explicit",
          },
        }),
      ),
    ).toBe("Explicit");
    expect(resolveCodexTurnNotificationBody(turn({ lastAgentMessage: null }))).toBe(
      "Nodex finished a turn.",
    );
    expect(resolveCodexQuestionNotificationBody(0)).toBe("Answer a question to proceed.");
    expect(resolveCodexQuestionNotificationBody(1)).toBe("Answer 1 question to proceed.");
    expect(resolveCodexQuestionNotificationBody(3)).toBe("Answer 3 questions to proceed.");
  });

  test("builds host-qualified public IDs while preserving strict IDs internally", () => {
    expect(buildCodexQuestionNotificationId("local", "request-1")).toBe("question-local-request-1");
    expect(
      buildCodexRequestNotificationOccurrenceId("question", "remote-a", "thread-1", 73),
    ).not.toBe(buildCodexRequestNotificationOccurrenceId("question", "remote-a", "thread-1", "73"));
  });
});

test("managed completions are quiet on every channel, with an explicit reason", () => {
  expect(
    decideCodexTurnNotification(turn(), {
      managed: true,
      turnMode: "always",
      isAppForegrounded: false,
      isConversationSeen: false,
    }),
  ).toEqual({ type: "suppress", reason: "managed" });
  expect(decideCodexTurnOccurrence(turn(), { managed: true })).toEqual({
    type: "suppress",
    reason: "managed",
  });
});
