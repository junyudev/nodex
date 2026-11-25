import { render, screen } from "@testing-library/react";
import { describe, expect, test, afterEach, vi } from "vite-plus/test";
import {
  KeyboardLayoutProvider,
  readKeyboardLayoutSnapshot,
  useKeyboardLayoutSnapshot,
} from "./keyboard-layout";
import { createCommandKeymapState } from "../../shared/command-keybindings";
import { formatToggleFullViewShortcutLabel } from "./workbench-command-shortcuts";

describe("keyboard layout", () => {
  function LayoutProbe() {
    const snapshot = useKeyboardLayoutSnapshot();
    return <span>{snapshot.entries.KeyY ?? "fallback"}</span>;
  }

  describe("readKeyboardLayoutSnapshot", () => {
    test("keeps only finite canonical entries from the browser layout map", async () => {
      const values = new Map([
        ["KeyY", "f"],
        ["KeyF", "u"],
        ["KeyA", "å"],
        ["UnknownCode", "x"],
      ]);

      await expect(
        readKeyboardLayoutSnapshot({ getLayoutMap: async () => values }, 7),
      ).resolves.toEqual({
        generation: 7,
        entries: { KeyF: "U", KeyY: "F" },
      });
    });

    test("reads once when Electron exposes a layout map without EventTarget methods", async () => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, "keyboard");
      Object.defineProperty(navigator, "keyboard", {
        configurable: true,
        value: {
          getLayoutMap: async () => new Map([["KeyY", "f"]]),
        },
      });

      try {
        render(
          <KeyboardLayoutProvider>
            <LayoutProbe />
          </KeyboardLayoutProvider>,
        );

        expect(await screen.findByText("F")).toBeTruthy();
      } finally {
        if (descriptor) Object.defineProperty(navigator, "keyboard", descriptor);
        else Reflect.deleteProperty(navigator, "keyboard");
      }
    });
  });
});

describe("workbench command shortcuts", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("full-view shortcut label", () => {
    test.each([
      ["macOS", "⇧⌘F", "⌥⌘F"],
      ["windows", "Ctrl+Shift+F", "Ctrl+Alt+F"],
      ["linux", "Ctrl+Shift+F", "Ctrl+Alt+F"],
    ] as const)("uses the current %s binding", (platform, defaultLabel, customLabel) => {
      expect(formatToggleFullViewShortcutLabel(createCommandKeymapState({}, platform))).toBe(
        defaultLabel,
      );
      expect(
        formatToggleFullViewShortcutLabel(
          createCommandKeymapState({ toggleFullView: ["CmdOrCtrl+Alt+F"] }, platform),
        ),
      ).toBe(customLabel);
      expect(
        formatToggleFullViewShortcutLabel(
          createCommandKeymapState({ toggleFullView: [] }, platform),
        ),
      ).toBeUndefined();
    });

    test.each([
      ["MacIntel", "⇧⌘F"],
      ["Win32", "Ctrl+Shift+F"],
      ["Linux x86_64", "Ctrl+Shift+F"],
    ])("uses the renderer platform %s while the keymap is loading", (platform, label) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      expect(formatToggleFullViewShortcutLabel()).toBe(label);
      expect(formatToggleFullViewShortcutLabel(null)).toBe(label);
    });
  });
});
