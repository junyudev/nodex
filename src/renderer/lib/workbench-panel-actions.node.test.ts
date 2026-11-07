import { describe, expect, test } from "vite-plus/test";
import { BoardIcon, CanvasIcon, PageIcon } from "@/components/shared/icons";
import { createCommandKeymapState } from "../../shared/command-keybindings";
import {
  getDefaultPanelIdForTabKind,
  getPanelNewTabAction,
  matchesPanelActionShortcut,
  resolvePanelShortcutLabel,
} from "./workbench-panel-actions";

describe("workbench panel action icons", () => {
  test("keeps resource actions paired with their semantic icons", () => {
    expect(getPanelNewTabAction("page_stage").Icon).toBe(PageIcon);
    expect(getPanelNewTabAction("canvas_stage").Icon).toBe(CanvasIcon);
    expect(getPanelNewTabAction("db_view").Icon).toBe(BoardIcon);
    expect(getPanelNewTabAction("page_stage").Icon).not.toBe(BoardIcon);
  });
});

describe("workbench panel action shortcuts", () => {
  const ctrlBackquote = {
    altKey: false,
    code: "Backquote",
    ctrlKey: true,
    key: "`",
    metaKey: false,
    shiftKey: false,
  };
  const terminal = getPanelNewTabAction("terminal");

  test("the Terminal action answers its default gesture", () => {
    const keymap = createCommandKeymapState({}, "macOS");
    expect(matchesPanelActionShortcut(ctrlBackquote, terminal, true, keymap)).toBe(true);
    // A layout where this key types another character still reports the physical key.
    expect(matchesPanelActionShortcut({ ...ctrlBackquote, key: "^" }, terminal, true, keymap)).toBe(
      true,
    );
  });

  test("unassigning the Terminal command releases the gesture to the shell", () => {
    const keymap = createCommandKeymapState({ toggleTerminal: [] }, "macOS");
    expect(matchesPanelActionShortcut(ctrlBackquote, terminal, true, keymap)).toBe(false);
  });
});

describe("workbench panel shortcut labels", () => {
  test.each([
    ["mod+shift+e", "⇧⌘E", "Ctrl+Shift+E"],
    ["mod+t", "⌘T", "Ctrl+T"],
    ["ctrl+shift+g", "⌃⇧G", "⌃⇧G"],
    ["ctrl+backquote", "⌃`", "⌃`"],
    ["alt+mod+s", "⌥⌘S", "Alt+Ctrl+S"],
  ] as const)("formats %s for each platform", (shortcut, macLabel, nonMacLabel) => {
    expect(resolvePanelShortcutLabel(shortcut, true)).toBe(macLabel);
    expect(resolvePanelShortcutLabel(shortcut, false)).toBe(nonMacLabel);
  });
});

test("uses the right panel for addressed Page Files", () => {
  expect(getDefaultPanelIdForTabKind("page_file")).toBe("right");
});
