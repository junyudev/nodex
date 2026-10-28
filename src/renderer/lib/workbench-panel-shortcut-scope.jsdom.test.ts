import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  isCodexTerminalShortcutTarget,
  isDocumentLevelShortcutTarget,
  isFocusedPanelTabShortcutTargetBlocked,
  isWorkbenchPanelTabShortcutTargetBlocked,
  isWorkbenchNewChatShortcutTargetEditable,
  resolveFocusedPanelTabCycleScope,
} from "./workbench-panel-shortcut-scope";

afterEach(() => {
  document.body.replaceChildren();
});

describe("workbench panel shortcut scope", () => {
  test.each([
    ["right-panel", "right"],
    ["bottom-panel", "bottom"],
  ] as const)("resolves %s leaf scope", (focusArea, panelId) => {
    const panel = document.createElement("section");
    panel.dataset.appShellFocusArea = focusArea;
    const leaf = document.createElement("div");
    leaf.dataset.panelGroupLeafId = "leaf-1";
    const button = document.createElement("button");
    leaf.append(button);
    panel.append(leaf);
    document.body.append(panel);

    expect(resolveFocusedPanelTabCycleScope(button)).toEqual({
      panelId,
      leafId: "leaf-1",
    });
    expect(resolveFocusedPanelTabCycleScope(panel)).toBeNull();
  });

  test("classifies terminal and document-level targets", () => {
    const terminal = document.createElement("div");
    terminal.dataset.codexTerminal = "true";
    const child = document.createElement("span");
    terminal.append(child);
    document.body.append(terminal);
    expect(isCodexTerminalShortcutTarget(child)).toBe(true);
    expect(isCodexTerminalShortcutTarget(document.body)).toBe(false);
    expect(isDocumentLevelShortcutTarget(document)).toBe(true);
    expect(isDocumentLevelShortcutTarget(document.body)).toBe(true);
    expect(isDocumentLevelShortcutTarget(child)).toBe(false);
  });

  test("blocks editors and dialogs while preserving NFM panel cycling", () => {
    const input = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogChild = document.createElement("button");
    dialog.append(dialogChild);
    const blockNote = document.createElement("div");
    blockNote.className = "bn-editor";
    const blockNoteChild = document.createElement("span");
    blockNote.append(blockNoteChild);
    const markdown = document.createElement("div");
    markdown.className = "nfm-editor";
    const nfmChild = document.createElement("span");
    nfmChild.contentEditable = "true";
    markdown.append(nfmChild);
    document.body.append(input, dialog, blockNote, markdown);

    expect(isWorkbenchNewChatShortcutTargetEditable(input)).toBe(true);
    expect(isWorkbenchNewChatShortcutTargetEditable(dialogChild)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(input)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(dialogChild)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(blockNoteChild)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(nfmChild)).toBe(false);

    const terminal = document.createElement("div");
    terminal.dataset.codexTerminal = "true";
    const terminalChild = document.createElement("span");
    terminal.append(terminalChild);
    document.body.append(terminal);
    expect(isWorkbenchPanelTabShortcutTargetBlocked(terminalChild)).toBe(true);
    expect(isWorkbenchPanelTabShortcutTargetBlocked(nfmChild)).toBe(false);
  });
});
