import { describe, expect, test } from "vite-plus/test";
import { describePageChatDelivery, resolvePageChatDelivery } from "./page-chat-delivery";

describe("Page send delivery", () => {
  test("an idle or background chat receives a send at once", () => {
    for (const status of [null, "background"] as const) {
      expect(resolvePageChatDelivery({ status, queueFollowUps: true })).toBe("send");
      expect(
        describePageChatDelivery(resolvePageChatDelivery({ status, queueFollowUps: false })),
      ).toBeNull();
    }
  });

  test("a chat in a Turn follows the Composer's Queue or Steer default", () => {
    for (const status of ["running", "waiting"] as const) {
      expect(resolvePageChatDelivery({ status, queueFollowUps: true })).toBe("queue");
      expect(resolvePageChatDelivery({ status, queueFollowUps: false })).toBe("steer");
    }
    expect(describePageChatDelivery("queue")).toBe("Queues after its current turn");
    expect(describePageChatDelivery("steer")).toBe("Steers its current turn");
  });

  test("content that starts its own Turn queues even when the default is Steer", () => {
    expect(
      resolvePageChatDelivery({ status: "running", queueFollowUps: false, startsNewTurn: true }),
    ).toBe("queue");
  });
});
