import { describe, expect, it } from "vite-plus/test";

import { subjectOfNotificationRequest, targetOfNotification } from "./notification-payload";

const tapped = (trigger: unknown) => ({ notification: { request: { trigger } } });

describe("targetOfNotification", () => {
  it("finds the chat in what the notification extension attached", () => {
    expect(
      targetOfNotification(tapped({ type: "push", payload: { sessionId: "s1", hostId: "h1" } })),
    ).toEqual({ kind: "chat", sessionId: "s1", hostId: "h1" });
    expect(targetOfNotification(tapped({ type: "push", payload: { sessionId: "s1" } }))).toEqual({
      kind: "chat",
      sessionId: "s1",
      hostId: null,
    });
  });

  it("opens a Page Turn's chat, or its Page when it waits on none", () => {
    expect(
      targetOfNotification(
        tapped({ type: "push", payload: { sessionId: "s1", pageId: "p1", hostId: "h1" } }),
      ),
    ).toEqual({ kind: "chat", sessionId: "s1", hostId: "h1" });
    expect(
      targetOfNotification(tapped({ type: "push", payload: { pageId: "p1", hostId: "h1" } })),
    ).toEqual({ kind: "page", pageId: "p1", hostId: "h1" });
  });

  it("is null for a notification that names neither", () => {
    expect(targetOfNotification(tapped(null))).toBeNull();
    expect(targetOfNotification(tapped({ type: "push", payload: { n: "sealed" } }))).toBeNull();
    expect(targetOfNotification(tapped({ type: "push", payload: { sessionId: "" } }))).toBeNull();
    expect(targetOfNotification(tapped({ type: "push", payload: { sessionId: 3 } }))).toBeNull();
  });
});

describe("subjectOfNotificationRequest", () => {
  it("keeps both the chat and the Page a Page Turn's notification is about", () => {
    expect(
      subjectOfNotificationRequest({
        trigger: { type: "push", payload: { sessionId: "s1", pageId: "p1", hostId: "h1" } },
      }),
    ).toEqual({ sessionId: "s1", pageId: "p1", hostId: "h1" });
    expect(
      subjectOfNotificationRequest({ trigger: { type: "push", payload: { pageId: "p1" } } }),
    ).toEqual({ sessionId: null, pageId: "p1", hostId: null });
    expect(subjectOfNotificationRequest({ trigger: { type: "push", payload: {} } })).toBeNull();
  });
});
