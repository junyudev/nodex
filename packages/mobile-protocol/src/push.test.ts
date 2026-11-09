import { describe, expect, it } from "vitest";

import {
  decodePushKey,
  encodePushKey,
  openPushPayload,
  sealPushPayload,
  type PushPayload,
} from "./push";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const nonce = Uint8Array.from({ length: 12 }, (_, index) => 200 + index);
const payload: PushPayload = {
  kind: "needs_you",
  sessionId: "session-1",
  title: "修复登录",
  body: "Apply a patch?",
};

describe("push sealing", () => {
  it("round-trips a notification, including text beyond ASCII", () => {
    expect(openPushPayload(key, sealPushPayload(key, nonce, payload))).toEqual(payload);
  });

  it("opens a Page Turn by its Page when it waits on no chat, and never names neither", () => {
    const turn: PushPayload = {
      kind: "needs_you",
      pageId: "page-1",
      title: "Ship",
      body: "Review",
    };
    expect(openPushPayload(key, sealPushPayload(key, nonce, turn))).toEqual(turn);
    const nowhere = { kind: "needs_you", title: "Ship", body: "Review" } as PushPayload;
    expect(openPushPayload(key, sealPushPayload(key, nonce, nowhere))).toBeNull();
  });

  it("reads as nothing under any other key or after tampering", () => {
    const sealed = sealPushPayload(key, nonce, payload);
    expect(openPushPayload(new Uint8Array(32), sealed)).toBeNull();
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    expect(openPushPayload(key, flipped)).toBeNull();
    expect(openPushPayload(key, "not base64 at all!")).toBeNull();
  });

  it("keeps a key intact through its text form", () => {
    expect(decodePushKey(encodePushKey(key))).toEqual(key);
  });

  // The phone's Notification Service Extension must open exactly this, so its test uses this value.
  it("matches the vector the phone's extension is checked against", () => {
    expect(sealPushPayload(key, nonce, payload)).toMatchInlineSnapshot(
      `"yMnKy8zNzs_Q0dLTbkT45gkuYkck2C-D4afMDutszgvQzPVu6-VXMlyOKjAkfGWxcsBg4ezErFwEHA3hYwZ13225mh7BPd1rfJwSQ93V2-0nQKJHTpP46nDWZ5T3qZ9muHmpLqJRRwQdZKHBwXbl2fQNPHuh2JI"`,
    );
  });
});
