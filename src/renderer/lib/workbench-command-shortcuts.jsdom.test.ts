import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createCommandKeymapState, resolveRuntimePlatform } from "../../shared/command-keybindings";
import { formatToggleFullViewShortcutLabel } from "./workbench-command-shortcuts";

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
      formatToggleFullViewShortcutLabel(createCommandKeymapState({ toggleFullView: [] }, platform)),
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
