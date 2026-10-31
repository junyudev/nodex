import { describe, expect, test } from "vite-plus/test";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  formatCommandShortcutLabel,
  type RuntimePlatform,
} from "../../../../shared/command-keybindings";
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
  test.each<RuntimePlatform>(["macOS", "windows", "linux"])(
    "%s defaults match and display the platform modifiers",
    (platform) => {
      const state = createCommandKeymapState({}, platform);
      const modifier = platform === "macOS" ? { metaKey: true } : { ctrlKey: true };
      expect(resolveNfmChatSendShortcut(chord({ ...modifier, shiftKey: true }), state)).toBe(
        "send",
      );
      expect(resolveNfmChatSendShortcut(chord({ ...modifier, altKey: true }), state)).toBe(
        "add-to-composer",
      );
      expect(formatCommandShortcutLabel(state, "pageEditorSendToChat")).toBe(
        platform === "macOS" ? "⇧⌘⏎" : "Ctrl+Shift+Enter",
      );
      expect(formatCommandShortcutLabel(state, "pageEditorAddToComposer")).toBe(
        platform === "macOS" ? "⌥⌘⏎" : "Ctrl+Alt+Enter",
      );
    },
  );

  test("uses edited bindings and leaves explicitly unassigned commands alone", () => {
    const overrides = applyCommandKeybindingUpdate(
      {},
      "pageEditorSendToChat",
      {
        type: "set",
        keybinding: { key: "Ctrl+Alt+Y" },
      },
      "linux",
    );
    const state = createCommandKeymapState({ ...overrides, pageEditorAddToComposer: [] }, "linux");
    expect(
      resolveNfmChatSendShortcut(chord({ key: "y", ctrlKey: true, altKey: true }), state),
    ).toBe("send");
    expect(formatCommandShortcutLabel(state, "pageEditorSendToChat")).toBe("Ctrl+Alt+Y");
    expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, shiftKey: true }), state)).toBeNull();
    expect(resolveNfmChatSendShortcut(chord({ ctrlKey: true, altKey: true }), state)).toBeNull();
    expect(formatCommandShortcutLabel(state, "pageEditorAddToComposer")).toBeUndefined();
  });

  test("leaves block activation, other keys, and IME composition alone", () => {
    const state = createCommandKeymapState({}, "macOS");
    for (const event of [
      chord({ metaKey: true }),
      chord({ ctrlKey: true, shiftKey: true }),
      chord({ metaKey: true, shiftKey: true, altKey: true }),
      chord({ key: "a", metaKey: true, shiftKey: true }),
      chord({ metaKey: true, shiftKey: true, isComposing: true }),
      chord({ metaKey: true, shiftKey: true, keyCode: 229 }),
    ])
      expect(resolveNfmChatSendShortcut(event, state)).toBeNull();
  });
});
