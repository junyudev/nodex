import { describe, expect, test } from "vite-plus/test";
import { BoardIcon, CanvasIcon, PageIcon } from "@/components/shared/icons";
import { getPanelNewTabAction, resolvePanelShortcutLabel } from "./workbench-panel-actions";

describe("workbench panel action icons", () => {
  test("keeps resource actions paired with their semantic icons", () => {
    expect(getPanelNewTabAction("page_stage").Icon).toBe(PageIcon);
    expect(getPanelNewTabAction("canvas_stage").Icon).toBe(CanvasIcon);
    expect(getPanelNewTabAction("db_view").Icon).toBe(BoardIcon);
    expect(getPanelNewTabAction("page_stage").Icon).not.toBe(BoardIcon);
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
