import { describe, expect, test } from "vite-plus/test";
import { resolveNfmChatSendShortcut } from "./nfm-chat-send-shortcuts";

const chord = (overrides: Partial<Parameters<typeof resolveNfmChatSendShortcut>[0]>) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("Page editor chat shortcuts", () => {
  test("resolves the platform command chords and nothing else", () => {
    expect(resolveNfmChatSendShortcut(chord({ metaKey: true, shiftKey: true }), true)).toBe("send");
    expect(resolveNfmChatSendShortcut(chord({ metaKey: true, altKey: true }), true)).toBe(
      "add-to-composer",
    );
    expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(
      "send",
    );
    expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, altKey: true }), false)).toBe(
      "add-to-composer",
    );
  });

  test("leaves Modify current block, other keys, and IME composition alone", () => {
    expect(resolveNfmChatSendShortcut(chord({ metaKey: true }), true)).toBe(null);
    expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, shiftKey: true }), true)).toBe(null);
    expect(
      resolveNfmChatSendShortcut(chord({ metaKey: true, shiftKey: true, altKey: true }), true),
    ).toBe(null);
    expect(
      resolveNfmChatSendShortcut(chord({ key: "a", metaKey: true, shiftKey: true }), true),
    ).toBe(null);
    expect(
      resolveNfmChatSendShortcut(chord({ metaKey: true, shiftKey: true, isComposing: true }), true),
    ).toBe(null);
  });
});
