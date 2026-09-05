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
    permissionsEnabled: true,
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
  source.eventListener = makeCodexThreadNotificationHandler({
    getSettings: () => settings,
    isAppForegrounded: () => foregrounded,
    isConversationPresentedInForeground: () => presented,
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
  source.presentedListener = (conversationId) => dismissed.push({ conversationId });
  return {
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
  test("shapes root turns and applies app focus without using conversation visibility", () => {
    const runtime = setup();
    runtime.setPresented(true);
    runtime.source.eventListener?.({
      type: "turn-completed",
      hostId: "default",
      conversation: conversation(),
      turnId: "turn-1",
      status: "interrupted",
      lastAgentMessage: "Stopped safely",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    });
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
    runtime.source.eventListener?.({
      type: "turn-completed",
      hostId: "default",
      conversation: conversation(),
      turnId: "turn-2",
      status: "completed",
      lastAgentMessage: "Hidden",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    });
    expect(runtime.shown).toHaveLength(1);
  });

  test("suppresses every child family and keeps permission approval open-only", () => {
    const runtime = setup();
    const child = conversation({ parentThreadId: "parent" });
    runtime.source.eventListener?.({
      type: "approval-requested",
      hostId: "default",
      conversation: child,
      requestId: "child-approval",
      turnId: "turn-child",
      approvalKind: "commandExecution",
      reason: null,
    });
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "default",
      conversation: child,
      requestId: "child-question",
      turnId: "turn-child",
      questionCount: 1,
    });
    expect(runtime.shown).toHaveLength(0);

    runtime.source.eventListener?.({
      type: "approval-requested",
      hostId: "remote-a",
      conversation: conversation(),
      requestId: 73,
      turnId: "turn-root",
      approvalKind: "permissionRequest",
      reason: "Need network",
    });
    expect(runtime.shown[0]).toMatchObject({
      id: "approval-remote-a-73",
      title: "Permission approval",
      body: "Need network",
      hostId: "remote-a",
    });
    expect(runtime.shown[0]?.actions).toBeUndefined();
  });

  test("suppresses foreground-presented requests and precisely dismisses resolved IDs", () => {
    const runtime = setup();
    runtime.setPresented(true);
    runtime.source.eventListener?.({
      type: "user-input-requested",
      hostId: "default",
      conversation: conversation(),
      requestId: "q-1",
      turnId: "turn-1",
      questionCount: 2,
    });
    expect(runtime.shown).toHaveLength(0);

    runtime.source.eventListener?.({
      type: "request-resolved",
      hostId: "default",
      conversationId: "thread-1",
      requestId: "q-1",
    });
    expect(runtime.dismissed).toEqual([
      {
        occurrenceId: buildCodexRequestNotificationOccurrenceId(
          "approval",
          "default",
          "thread-1",
          "q-1",
        ),
      },
      {
        occurrenceId: buildCodexRequestNotificationOccurrenceId(
          "question",
          "default",
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
      hostId: "default",
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
  test("opens an async question without a blocking request or reply action, then dismisses the same occurrence", () => {
    const runtime = setup();
    runtime.source.eventListener?.({
      type: "async-question-requested",
      hostId: "default",
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
      hostId: "default",
      conversationId: "thread-1",
      turnId: "turn",
      questionId: "question",
    });
    expect(runtime.dismissed).toContainEqual({ notificationId: runtime.shown[0]!.id });
  });
});
