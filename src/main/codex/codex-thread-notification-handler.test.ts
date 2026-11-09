import { automationNotificationDecision } from "../../shared/automation-notification-policy";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
  ThreadNotificationSettings,
} from "../../shared/types";
import {
  buildCodexRequestNotificationOccurrenceId,
  type CodexNotificationConversationFacts,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { makeCodexThreadNotificationHandler } from "./codex-thread-notification-handler";

function conversation(
  overrides: Partial<CodexNotificationConversationFacts> = {},
): CodexNotificationConversationFacts {
  return {
    conversationId: "thread-1",
    title: "Notification parity",
    threadSource: null,
    parentThreadId: null,
    source: null,
    sideConversationParentNavigationPath: null,
    ...overrides,
  };
}

class FakeSource {
  eventListener: ((event: CodexThreadNotificationEvent) => void) | null = null;
  presentedListener: ((conversationId: string) => void) | null = null;

  addThreadNotificationListener(listener: (event: CodexThreadNotificationEvent) => void) {
    this.eventListener = listener;
    return () => {
      if (this.eventListener === listener) this.eventListener = null;
    };
  }

  addRendererConversationPresentedInForegroundListener(listener: (conversationId: string) => void) {
    this.presentedListener = listener;
    return () => {
      if (this.presentedListener === listener) this.presentedListener = null;
    };
  }
}

function setup(
  settings: ThreadNotificationSettings = {
    turnMode: "unfocused",
    questionsEnabled: true,
  },
) {
  const source = new FakeSource();
  const shown: DesktopNotificationPayload[] = [];
  const actions: Array<(action: DesktopNotificationActionPayload) => void> = [];
  const dismissed: DesktopNotificationHideSelector[] = [];
  const dispatched: DesktopNotificationActionInvocation[] = [];
  let foregrounded = false;
  let presented = false;
  const focusTargetClient = vi.fn();
  const handle = makeCodexThreadNotificationHandler({
    getSettings: () => settings,
    isAppForegrounded: () => foregrounded,
    isConversationSeen: () => presented,
    resolveTargetClientId: () => "renderer-1",
    showNotification: (notification, _targetClientId, onAction) => {
      shown.push(notification);
      actions.push(onAction);
    },
    dismissNotification: (selector) => dismissed.push(selector),
    dispatchAction: (_targetClientId, action) => {
      dispatched.push(action);
      return true;
    },
    focusTargetClient,
  });
  source.eventListener = handle;
  source.presentedListener = (conversationId) => dismissed.push({ conversationId });
  return {
    handle,
    actions,
    dismissed,
    dispatched,
    focusTargetClient,
    setForegrounded: (value: boolean) => {
      foregrounded = value;
    },
    setPresented: (value: boolean) => {
      presented = value;
    },
    shown,
    source,
  };
}

describe("Codex thread notification handler", () => {
  test("approval requests show their action, navigate to their Session and dismiss independently of questions", () => {
    const runtime = setup({ turnMode: "off", questionsEnabled: true });
    const facts = conversation({ runtimeSessionId: "session-1" });
    runtime.source.eventListener?.({
      type: "approval-requested",
      hostId: "local",
      conversation: facts,
      requestId: 73,
      turnId: "turn-1",
      prompt: "git push origin main",
    });
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "local",
      conversation: facts,
      requestId: 73,
      turnId: "turn-1",
      questionCount: 1,
    });
    expect(runtime.shown).toHaveLength(2);
    const approval = runtime.shown[0]!;
    expect(approval).toMatchObject({
      id: "approval-local-73",
      title: "Notification parity needs approval",
      body: "git push origin main",
      navigationPath: "session:session-1/thread:thread-1",
      requestId: 73,
    });
    expect(approval.actions).toBeUndefined();
    expect(approval.replyPlaceholder).toBeUndefined();
    expect(approval.occurrenceId).not.toBe(runtime.shown[1]?.occurrenceId);
    runtime.actions[0]?.({ notificationId: approval.id, actionType: "open", actionId: null });
    expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
    expect(runtime.dispatched[0]).toMatchObject({
      actionType: "open",
      hostId: "local",
      conversationId: "thread-1",
      navigationPath: "session:session-1/thread:thread-1",
      requestId: 73,
    });
    runtime.source.eventListener?.({
      type: "request-resolved",
      hostId: "local",
      conversationId: "thread-1",
      requestId: 73,
      family: "approval",
    });
    expect(runtime.dismissed).toEqual([{ occurrenceId: approval.occurrenceId }]);
  });

  test("approval requests share request preferences and foreground suppression", () => {
    const event = {
      type: "approval-requested",
      hostId: "local",
      conversation: conversation(),
      requestId: "approval-1",
      turnId: "turn-1",
      prompt: null,
    } as const;
    const disabled = setup({ turnMode: "always", questionsEnabled: false });
    disabled.source.eventListener?.(event);
    expect(disabled.shown).toEqual([]);
    const visible = setup();
    visible.setPresented(true);
    visible.source.eventListener?.(event);
    expect(visible.shown).toEqual([]);
    const background = setup();
    background.setForegrounded(true);
    background.source.eventListener?.(event);
    expect(background.shown[0]?.body).toBe("Approve the requested action to proceed.");
  });

  test("muted automations notify on failure while respecting global notification settings", () => {
    const runtime = setup();
    const emit = (target: ReturnType<typeof setup>, status: "completed" | "failed") =>
      target.source.eventListener?.({
        type: "turn-completed",
        hostId: "local",
        conversation: conversation(),
        turnId: status,
        status,
        lastAgentMessage: "Run finished",
        heartbeatAssistantMessage: {
          decision: "DONT_NOTIFY",
          visibleText: null,
          notificationMessage: null,
        },
        automationNotificationDecision: automationNotificationDecision("failed_runs_only", status),
        hasPendingContinuation: false,
      });
    emit(runtime, "completed");
    expect(runtime.shown).toHaveLength(0);
    emit(runtime, "failed");
    expect(runtime.shown).toHaveLength(1);
    const disabled = setup({ turnMode: "off", questionsEnabled: true });
    emit(disabled, "failed");
    expect(disabled.shown).toHaveLength(0);
  });

  test("shapes root turns and stays quiet while Nodex or the chat itself is in front of the person", () => {
    const turn = (turnId: string, status: "completed" | "interrupted" = "completed") => ({
      type: "turn-completed" as const,
      hostId: "local",
      conversation: conversation(),
      turnId,
      status,
      lastAgentMessage: status === "interrupted" ? "Stopped safely" : "Hidden",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    });
    const runtime = setup();
    runtime.source.eventListener?.(turn("turn-1", "interrupted"));
    expect(runtime.shown).toMatchObject([
      {
        id: "turn-turn-1",
        title: "Notification parity",
        body: "Stopped safely",
        navigationPath: "thread:thread-1",
        replyPlaceholder: "Reply to Nodex",
      },
    ]);

    runtime.setForegrounded(true);
    runtime.source.eventListener?.(turn("turn-2"));
    // No window is focused, but the chat is open on a phone in the person's hand.
    runtime.setForegrounded(false);
    runtime.setPresented(true);
    runtime.source.eventListener?.(turn("turn-3"));
    expect(runtime.shown).toHaveLength(1);

    const always = setup({ turnMode: "always", questionsEnabled: true });
    always.setForegrounded(true);
    always.setPresented(true);
    always.source.eventListener?.(turn("turn-4"));
    expect(always.shown).toHaveLength(1);
  });

  test("suppresses child question notifications", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "local",
      conversation: conversation({ parentThreadId: "parent" }),
      requestId: "child-question",
      turnId: "turn-child",
      questionCount: 1,
    });
    expect(runtime.shown).toHaveLength(0);
  });

  test("suppresses foreground-presented requests and precisely dismisses resolved IDs", () => {
    const runtime = setup();
    runtime.setPresented(true);
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "local",
      conversation: conversation(),
      requestId: "q-1",
      turnId: "turn-1",
      questionCount: 2,
    });
    expect(runtime.shown).toHaveLength(0);

    runtime.source.eventListener?.({
      type: "request-resolved",
      hostId: "local",
      conversationId: "thread-1",
      requestId: "q-1",
    });
    expect(runtime.dismissed).toEqual([
      {
        occurrenceId: buildCodexRequestNotificationOccurrenceId(
          "question",
          "local",
          "thread-1",
          "q-1",
        ),
      },
    ]);
    runtime.source.presentedListener?.("thread-1");
    expect(runtime.dismissed.at(-1)).toEqual({ conversationId: "thread-1" });
  });

  test("routes side actions with navigation first contract and focuses open only", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "local",
      conversation: conversation({
        conversationId: "side-1",
        sideConversationParentNavigationPath: "project:p/session:s/thread:parent",
      }),
      requestId: "q-side",
      turnId: "turn-side",
      questionCount: 0,
    });
    runtime.actions[0]?.({
      notificationId: "question-default-q-side",
      actionId: null,
      actionType: "open",
    });
    expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
    expect(runtime.dispatched[0]).toMatchObject({
      conversationId: "side-1",
      navigationPath: "project:p/session:s/thread:parent",
      activateTabId: "sidechat:side-1",
      requestId: "q-side",
    });
  });

  test("opens a Runtime side-chat completion in its source Session tab", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "turn-completed",
      hostId: "local",
      conversation: conversation({
        conversationId: "thread:side",
        runtimeSessionId: "session:side",
        sideConversationParentNavigationPath: "session:session%3Asource/thread:thread%3Asource",
      }),
      turnId: "run-side",
      status: "completed",
      lastAgentMessage: "Side chat finished",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    });
    expect(runtime.shown).toHaveLength(1);
    expect(runtime.shown[0]).toMatchObject({
      conversationId: "thread:side",
      navigationPath: "session:session%3Asource/thread:thread%3Asource",
      activateTabId: "sidechat-session:session:side",
    });
    runtime.actions[0]?.({
      notificationId: runtime.shown[0]!.id,
      actionId: null,
      actionType: "open",
    });
    expect(runtime.dispatched[0]).toMatchObject({
      conversationId: "thread:side",
      navigationPath: "session:session%3Asource/thread:thread%3Asource",
      activateTabId: "sidechat-session:session:side",
    });
    expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
  });

  test("opens an async question without a blocking request or reply action, then dismisses the same occurrence", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "async-question-requested",
      hostId: "local",
      conversation: conversation(),
      turnId: "turn",
      questionId: "question",
    });
    expect(runtime.shown[0]).toMatchObject({
      kind: "question",
      body: "Nodex has a question",
      asyncQuestion: { turnId: "turn", questionId: "question" },
    });
    expect(runtime.shown[0]?.replyPlaceholder).toBeUndefined();
    runtime.actions[0]?.({
      notificationId: runtime.shown[0]!.id,
      actionId: null,
      actionType: "open",
    });
    expect(runtime.dispatched[0]).toMatchObject({
      requestId: null,
      asyncQuestion: { turnId: "turn", questionId: "question" },
    });
    runtime.source.eventListener?.({
      type: "async-question-resolved",
      hostId: "local",
      conversationId: "thread-1",
      turnId: "turn",
      questionId: "question",
    });
    expect(runtime.dismissed).toContainEqual({ notificationId: runtime.shown[0]!.id });
  });

  test("routes a Runtime conversation through its product Session", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "turn-completed",
      hostId: "local",
      conversation: conversation({
        conversationId: "nodex:thread:root",
        runtimeSessionId: "session:a/b",
      }),
      turnId: "run-1",
      status: "completed",
      lastAgentMessage: "Delegated result is ready",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    });
    expect(runtime.shown).toMatchObject([
      {
        conversationId: "nodex:thread:root",
        navigationPath: "session:session%3Aa%2Fb/thread:nodex%3Athread%3Aroot",
        activateTabId: null,
      },
    ]);
  });
});

test("chat reminders respect settings and presentation and open their exact Session", () => {
  const runtime = setup({ turnMode: "always", questionsEnabled: true });
  const event = {
    type: "session-reminder" as const,
    hostId: "local",
    remindAt: "2026-11-02T09:00:00.000Z",
    memberId: "member",
    conversation: conversation({ title: "Return here", runtimeSessionId: "chat" }),
  };
  runtime.source.eventListener!(event);
  expect(runtime.shown[0]).toMatchObject({
    kind: "reminder",
    title: "Return here",
    body: "You asked to come back to this chat.",
    navigationPath: "session:chat/thread:thread-1",
  });
  runtime.actions[0]!({ notificationId: runtime.shown[0]!.id, actionId: null, actionType: "open" });
  expect(runtime.dispatched[0]?.navigationPath).toBe("session:chat/thread:thread-1");
  runtime.setPresented(true);
  runtime.source.eventListener!(event);
  expect(runtime.shown).toHaveLength(1);
  const disabled = setup({ turnMode: "off", questionsEnabled: true });
  disabled.source.eventListener!(event);
  expect(disabled.shown).toHaveLength(0);
});

test("managed chat completion stays quiet while questions and approvals keep notifying", () => {
  const runtime = setup({ turnMode: "always", questionsEnabled: true });
  const event = {
    type: "turn-completed" as const,
    hostId: "local",
    conversation: conversation(),
    turnId: "managed:turn",
    status: "completed" as const,
    lastAgentMessage: "Done",
    heartbeatAssistantMessage: null,
    automationNotificationDecision: null,
    hasPendingContinuation: false,
  };
  runtime.handle(event, { managed: true });
  expect(runtime.shown).toHaveLength(0);
  runtime.handle(event, { managed: false });
  expect(runtime.shown.map((n) => n.kind)).toEqual(["turn-complete"]);
  runtime.handle(
    {
      type: "user-input-requested",
      hostId: "local",
      conversation: conversation(),
      turnId: "managed:turn",
      requestId: "question",
      questionCount: 1,
    },
    { managed: true },
  );
  runtime.handle(
    {
      type: "approval-requested",
      hostId: "local",
      conversation: conversation(),
      turnId: "managed:turn",
      requestId: "approval",
      prompt: "Push?",
    },
    { managed: true },
  );
  expect(runtime.shown.map((n) => n.kind)).toEqual(["turn-complete", "question", "question"]);
  expect(runtime.shown[2]?.id).toBe("approval-local-approval");
});
