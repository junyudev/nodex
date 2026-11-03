import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopNotificationActionInvocation } from "../../shared/types";
import {
  executeDesktopNotificationAction,
  executeRuntimeDesktopNotificationAction,
  resolveDesktopNotificationTarget,
  type DesktopNotificationActionManager,
} from "./desktop-notification-action";

function makeInvocation(
  patch: Partial<DesktopNotificationActionInvocation> = {},
): DesktopNotificationActionInvocation {
  return {
    notificationId: "question-local-request-1",
    actionId: null,
    actionType: "open",
    hostId: "local",
    conversationId: "child-thread",
    navigationPath: "project:project-1/session:session-1/thread:parent-thread",
    activateTabId: "sidechat:child-thread",
    requestId: "request-1",
    ...patch,
  };
}

function makeManager(): DesktopNotificationActionManager & { startTurn: ReturnType<typeof vi.fn> } {
  return { startTurn: vi.fn(async () => undefined) };
}

describe("desktop notification action boundary", () => {
  it("opens a native side chat inside its parent even when the parent path names a Session", () => {
    const invocation = makeInvocation();
    expect(resolveDesktopNotificationTarget(invocation)).toEqual({
      kind: "native",
      threadId: "parent-thread",
      sideChatThreadId: "child-thread",
    });
    expect(
      resolveDesktopNotificationTarget({ ...invocation, activateTabId: "sidechat:another-thread" }),
    ).toEqual({
      kind: "runtime",
      sessionId: "session-1",
      threadId: "parent-thread",
      sideChatSessionId: null,
    });
    expect(
      resolveDesktopNotificationTarget(
        makeInvocation({ navigationPath: "thread:root", activateTabId: null }),
      ),
    ).toEqual({ kind: "native", threadId: "root", sideChatThreadId: null });
  });

  it("opens a Runtime side chat as a tab of its source Session, never as its own Scene", () => {
    expect(
      resolveDesktopNotificationTarget(
        makeInvocation({
          conversationId: "nodex:thread:side",
          navigationPath: "session:source/thread:nodex%3Athread%3Aroot",
          activateTabId: "sidechat-session:side",
          requestId: null,
        }),
      ),
    ).toEqual({
      kind: "runtime",
      sessionId: "source",
      threadId: "nodex:thread:root",
      sideChatSessionId: "side",
    });
  });

  it("preserves native reply code while trimming surrounding whitespace", async () => {
    const manager = makeManager();
    await expect(
      executeDesktopNotificationAction(
        makeInvocation({
          actionType: "reply",
          actionId: null,
          requestId: null,
          reply: "  Use Array<T> and **keep markdown**  ",
        }),
        manager,
      ),
    ).resolves.toBe("replied");
    expect(manager.startTurn).toHaveBeenCalledWith(
      "child-thread",
      "Use Array<T> and **keep markdown**",
    );
  });
  it("reopens only a question in the same running Turn and never starts a Turn from an async notification", async () => {
    const manager = makeManager();
    const open = vi.fn();
    manager.asyncQuestions = { open, read: () => ({ activeTurnId: "turn" }) };
    const invocation = makeInvocation({
      actionType: "open",
      asyncQuestion: { turnId: "turn", questionId: "question" },
    });
    expect(await executeDesktopNotificationAction(invocation, manager)).toBe("opened");
    expect(open).toHaveBeenCalledWith("child-thread", "question");
    expect(
      await executeDesktopNotificationAction(
        { ...invocation, asyncQuestion: { turnId: "old-turn", questionId: "question" } },
        manager,
      ),
    ).toBe("ignored");
    expect(
      await executeDesktopNotificationAction(
        { ...invocation, actionType: "reply", reply: "answer" },
        manager,
      ),
    ).toBe("ignored");
    expect(manager.startTurn).not.toHaveBeenCalled();
  });

  it("opens Runtime conversations by Session and replies through the Session", async () => {
    const invocation = makeInvocation({
      conversationId: "nodex:thread:root",
      navigationPath: "session:session%3Aa%2Fb/thread:nodex%3Athread%3Aroot",
      activateTabId: null,
      requestId: null,
    });
    expect(resolveDesktopNotificationTarget(invocation)).toEqual({
      kind: "runtime",
      sessionId: "session:a/b",
      threadId: "nodex:thread:root",
      sideChatSessionId: null,
    });

    const sendMessage = vi.fn(async () => undefined);
    await expect(
      executeRuntimeDesktopNotificationAction(invocation, "session:a/b", sendMessage),
    ).resolves.toBe("opened");
    await expect(
      executeRuntimeDesktopNotificationAction(
        { ...invocation, actionType: "reply", reply: "  Ship it  " },
        "session:a/b",
        sendMessage,
      ),
    ).resolves.toBe("replied");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session:a/b",
      text: "Ship it",
    });
  });
});
