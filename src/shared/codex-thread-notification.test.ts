import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexApprovalNotificationId,
  buildCodexQuestionNotificationId,
  buildCodexRequestNotificationOccurrenceId,
  decideCodexRequestNotification,
  decideCodexTurnNotification,
  isCodexNotificationChildConversation,
  resolveCodexApprovalNotificationCopy,
  resolveCodexQuestionNotificationBody,
  resolveCodexTurnNotificationBody,
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
      includeTurnNotifications: true,
      isAppForegrounded: false,
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
      includeTurnNotifications: true,
      isAppForegrounded: true,
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
    expect(
      decideCodexTurnNotification(turn(), {
        ...always,
        includeTurnNotifications: false,
      }),
    ).toEqual({ type: "suppress", reason: "remote-host-turn" });
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
  });

  test("suppresses requests only for settings, real children, or foreground presentation", () => {
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: true,
        isConversationPresentedInForeground: false,
      }),
    ).toEqual({ type: "show" });
    expect(
      decideCodexRequestNotification(
        conversation({
          parentThreadId: "parent",
        }),
        {
          enabled: true,
          isConversationPresentedInForeground: false,
        },
      ),
    ).toEqual({ type: "suppress", reason: "child-conversation" });
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: true,
        isConversationPresentedInForeground: true,
      }),
    ).toEqual({ type: "suppress", reason: "conversation-presented" });
    expect(
      decideCodexRequestNotification(conversation(), {
        enabled: false,
        isConversationPresentedInForeground: false,
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
    expect(
      resolveCodexApprovalNotificationCopy({
        approvalKind: "permissionRequest",
        reason: null,
      }),
    ).toEqual({
      title: "Permission approval",
      body: "Approval required",
      hasActions: false,
    });
    expect(resolveCodexQuestionNotificationBody(0)).toBe("Answer a question to proceed.");
    expect(resolveCodexQuestionNotificationBody(1)).toBe("Answer 1 question to proceed.");
    expect(resolveCodexQuestionNotificationBody(3)).toBe("Answer 3 questions to proceed.");
  });

  test("builds host-qualified public IDs while preserving strict IDs internally", () => {
    expect(buildCodexApprovalNotificationId("remote-a", 73)).toBe("approval-remote-a-73");
    expect(buildCodexApprovalNotificationId("remote-a", "73")).toBe("approval-remote-a-73");
    expect(buildCodexQuestionNotificationId("local", "request-1")).toBe(
      "question-local-request-1",
    );
    expect(
      buildCodexRequestNotificationOccurrenceId("approval", "remote-a", "thread-1", 73),
    ).not.toBe(buildCodexRequestNotificationOccurrenceId("approval", "remote-a", "thread-1", "73"));
  });
});
