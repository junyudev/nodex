import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopNotificationActionInvocation } from "../../shared/types";
import {
  executeDesktopNotificationAction,
  resolveDesktopNotificationParentThreadId,
  resolveDesktopNotificationSideChatThreadId,
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
  it("resolves parent and side-chat navigation without confusing child ownership", () => {
    const invocation = makeInvocation();
    expect(resolveDesktopNotificationParentThreadId(invocation)).toBe("parent-thread");
    expect(resolveDesktopNotificationSideChatThreadId(invocation)).toBe("child-thread");
    expect(
      resolveDesktopNotificationSideChatThreadId({
        ...invocation,
        activateTabId: "sidechat:another-thread",
      }),
    ).toBeNull();
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
});
