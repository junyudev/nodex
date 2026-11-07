import { describe, expect, it } from "vite-plus/test";

import { chatOfNotification } from "./notification-payload";

const tapped = (trigger: unknown) => ({ notification: { request: { trigger } } });

describe("chatOfNotification", () => {
  it("finds the chat in what the notification extension attached", () => {
    expect(
      chatOfNotification(tapped({ type: "push", payload: { sessionId: "s1", hostId: "h1" } })),
    ).toEqual({ sessionId: "s1", hostId: "h1" });
    expect(chatOfNotification(tapped({ type: "push", payload: { sessionId: "s1" } }))).toEqual({
      sessionId: "s1",
      hostId: null,
    });
  });

  it("is null for a notification that names no chat", () => {
    expect(chatOfNotification(tapped(null))).toBeNull();
    expect(chatOfNotification(tapped({ type: "push", payload: { n: "sealed" } }))).toBeNull();
    expect(chatOfNotification(tapped({ type: "push", payload: { sessionId: "" } }))).toBeNull();
    expect(chatOfNotification(tapped({ type: "push", payload: { sessionId: 3 } }))).toBeNull();
  });
});
