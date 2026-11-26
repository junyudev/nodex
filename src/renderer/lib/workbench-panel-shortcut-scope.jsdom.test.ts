import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createCommandKeymapState,
  type CommandId,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { matchesKeyboardActionCommand } from "./keyboard-action-runtime";
import { getPanelNewTabAction, matchesPanelActionShortcut } from "./workbench-panel-actions";
import {
  focusBrowserAddressBar,
  isCodexTerminalShortcutTarget,
  isDocumentLevelShortcutTarget,
  isFocusedPanelTabShortcutTargetBlocked,
  isWorkbenchPanelTabShortcutTargetBlocked,
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

    expect(isFocusedPanelTabShortcutTargetBlocked(input)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(dialogChild)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(blockNoteChild)).toBe(true);
    expect(isFocusedPanelTabShortcutTargetBlocked(nfmChild)).toBe(false);

    // A Browser address field keeps Close tab and tab switching, as a browser's does.
    const address = document.createElement("input");
    address.setAttribute("data-panel-tab-shortcuts-pass-through", "");
    document.body.append(address);
    expect(isFocusedPanelTabShortcutTargetBlocked(address)).toBe(false);

    const terminal = document.createElement("div");
    terminal.dataset.codexTerminal = "true";
    const terminalChild = document.createElement("span");
    terminal.append(terminalChild);
    document.body.append(terminal);
    expect(isWorkbenchPanelTabShortcutTargetBlocked(terminalChild)).toBe(true);
    expect(isWorkbenchPanelTabShortcutTargetBlocked(nfmChild)).toBe(false);
  });

  test("focuses and selects the address in the focused or remembered Browser group", () => {
    document.body.innerHTML = `
      <section data-app-shell-focus-area="right-panel">
        <div data-panel-group-leaf-id="one" data-panel-group-leaf-active="true">
          <input data-browser-sidebar-address-input="true" value="https://first.example">
        </div>
        <div data-panel-group-leaf-id="two">
          <button>Browser toolbar</button>
          <input data-browser-sidebar-address-input="true" value="https://second.example">
          <div data-browser-sidebar-webview-host-root data-browser-sidebar-conversation-id="chat"
            data-browser-sidebar-browser-tab-id="second"></div>
        </div>
      </section>
      <div tabindex="-1" data-browser-sidebar-webview-manager-root
        data-browser-sidebar-webview-host-kind="panel" data-browser-sidebar-conversation-id="chat"
        data-browser-sidebar-browser-tab-id="second"></div>`;
    const [first, second] = document.querySelectorAll("input");
    const toolbar = document.querySelector("button")!;
    toolbar.focus();
    expect(focusBrowserAddressBar(document, null)).toBe(true);
    expect(document.activeElement).toBe(second);
    expect([second.selectionStart, second.selectionEnd]).toEqual([0, second.value.length]);

    second.setSelectionRange(3, 4);
    expect(focusBrowserAddressBar(document, null)).toBe(true);
    expect([second.selectionStart, second.selectionEnd]).toEqual([0, second.value.length]);

    second.blur();
    expect(focusBrowserAddressBar(document, { panelId: "right", leafId: "two" })).toBe(true);
    expect(document.activeElement).toBe(second);

    const guest = document.querySelector<HTMLElement>(
      "[data-browser-sidebar-webview-manager-root]",
    )!;
    guest.focus();
    expect(focusBrowserAddressBar(document, { panelId: "right", leafId: "one" })).toBe(true);
    expect(document.activeElement).toBe(second);

    second.blur();
    expect(focusBrowserAddressBar(document, null)).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});

function admitted(
  target: Element,
  keymap: CommandKeymapState,
  command: CommandId,
  init: KeyboardEventInit,
  consumed = false,
): boolean {
  const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
  if (consumed) event.preventDefault();
  let result = false;
  target.addEventListener(
    "keydown",
    (event) => {
      result = matchesKeyboardActionCommand(event as KeyboardEvent, keymap, command);
    },
    { once: true },
  );
  target.dispatchEvent(event);
  return result;
}

describe("workbench command reach", () => {
  test("admits chat and panel chords from text fields, while overlays and Terminal keep their keys", () => {
    document.body.innerHTML = `
      <input id="field">
      <textarea id="inbox"></textarea>
      <div data-nodex-keyboard-context="composer"><div contenteditable id="chat"></div></div>
      <div class="nfm-editor"><div contenteditable id="page"></div></div>
      <div role="dialog"><input id="dialog"></div>
      <div data-nodex-keyboard-scope="local"><input id="palette"></div>
      <div data-nodex-keyboard-scope="terminal"><textarea id="terminal"></textarea></div>`;
    const keymap = createCommandKeymapState({}, "windows");
    const target = (id: string) => document.getElementById(id)!;
    const bindings = [
      ["newThread", { key: "n", ctrlKey: true }],
      ["quickChat", { key: "ń", code: "KeyN", ctrlKey: true, altKey: true }],
      ["nextThread", { key: "ArrowDown", ctrlKey: true, altKey: true }],
      ["archiveThread", { key: "A", ctrlKey: true, shiftKey: true }],
      ["openBrowserTab", { key: "t", ctrlKey: true }],
      ["openInbox", { key: "D", ctrlKey: true, shiftKey: true }],
    ] as const;

    for (const [command, key] of bindings) {
      for (const input of ["field", "inbox", "chat", "page"]) {
        expect(admitted(target(input), keymap, command, key), `${command} in ${input}`).toBe(true);
      }
      for (const surface of ["dialog", "palette", "terminal"]) {
        expect(admitted(target(surface), keymap, command, key), `${command} in ${surface}`).toBe(
          false,
        );
      }
    }
    const palette = { key: "k", ctrlKey: true };
    expect(admitted(target("dialog"), keymap, "openCommandMenu", palette)).toBe(true);
    expect(admitted(target("palette"), keymap, "openCommandMenu", palette)).toBe(true);
    expect(admitted(target("terminal"), keymap, "openCommandMenu", palette)).toBe(false);
    const toggle = { key: "`", ctrlKey: true };
    expect(admitted(target("terminal"), keymap, "toggleTerminal", toggle)).toBe(true);
  });

  test("gives AltGr, IME, consumed keys and repeat to the focused input", () => {
    const input = document.createElement("input");
    const keymap = createCommandKeymapState({}, "windows");
    const key = { key: "ń", code: "KeyN", ctrlKey: true, altKey: true };
    expect(admitted(input, keymap, "quickChat", key)).toBe(true);
    expect(admitted(input, keymap, "quickChat", { ...key, modifierAltGraph: true })).toBe(false);
    expect(admitted(input, keymap, "quickChat", { ...key, isComposing: true })).toBe(false);
    expect(admitted(input, keymap, "quickChat", { ...key, key: "Process" })).toBe(false);
    expect(admitted(input, keymap, "quickChat", { ...key, repeat: true })).toBe(false);
    expect(admitted(input, keymap, "quickChat", key, true)).toBe(false);
    const local = document.createElement("div");
    local.dataset.nodexKeyboardScope = "local";
    local.append(input);
    const custom = createCommandKeymapState({ openCommandMenu: ["Ctrl+Alt+N"] }, "windows");
    expect(admitted(input, custom, "openCommandMenu", { ...key, modifierAltGraph: true })).toBe(
      false,
    );
  });

  test("leaves Page formatting and Linux Unicode entry with their text owners", () => {
    document.body.innerHTML =
      '<div class="nfm-editor"><div contenteditable id="page"></div></div><input>';
    const page = document.getElementById("page")!;
    const input = document.querySelector("input")!;
    const linux = createCommandKeymapState({}, "linux");
    const windows = createCommandKeymapState({}, "windows");
    const files = { key: "E", ctrlKey: true, shiftKey: true };
    expect(admitted(page, linux, "toggleFileTreePanel", files)).toBe(false);
    expect(admitted(input, linux, "toggleFileTreePanel", files)).toBe(true);
    const unread = { key: "U", ctrlKey: true, shiftKey: true };
    expect(admitted(input, linux, "toggleThreadUnread", unread)).toBe(false);
    expect(admitted(document.body, linux, "toggleThreadUnread", unread)).toBe(true);
    expect(admitted(input, windows, "toggleThreadUnread", unread)).toBe(true);
  });

  test("opens panel actions only on the live binding after replacement or clearing", () => {
    const browser = getPanelNewTabAction("browser");
    const input = document.createElement("input");
    const defaults = createCommandKeymapState({}, "windows");
    const custom = createCommandKeymapState({ openBrowserTab: ["Ctrl+Alt+T"] }, "windows");
    const cleared = createCommandKeymapState({ openBrowserTab: [] }, "windows");
    const key = {
      key: "t",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: input,
    };
    expect(matchesPanelActionShortcut(key, browser, defaults)).toBe(true);
    expect(matchesPanelActionShortcut(key, browser, custom)).toBe(false);
    expect(matchesPanelActionShortcut({ ...key, altKey: true }, browser, custom)).toBe(true);
    expect(matchesPanelActionShortcut(key, browser, cleared)).toBe(false);
  });
});
