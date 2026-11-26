import {
  getCommandEntry,
  matchesKeyboardEventToAccelerator,
  matchesKeyboardEventToCommand,
  type CommandId,
  type CommandKeymapState,
  type KeyboardActionPolicy,
  type KeyboardShortcutEventLike,
} from "../../shared/command-keybindings";
import type { RuntimePlatform } from "../../shared/runtime-platform";

export type { KeyboardActionPolicy } from "../../shared/command-keybindings";

export interface KeyboardActionEventLike extends KeyboardShortcutEventLike {
  readonly target: EventTarget | null;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly keyCode?: number;
  readonly composedPath?: () => readonly EventTarget[];
  readonly getModifierState?: (modifier: string) => boolean;
}

type KeyboardActionTarget = Pick<KeyboardActionEventLike, "target" | "composedPath">;

export type KeyboardActionSurfaceScope = "global" | "editable" | "local" | "terminal";

export type KeyboardActionContext = "composer";

interface KeyboardActionElementLike extends EventTarget {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly type?: string;
  readonly parentElement?: KeyboardActionElementLike | null;
  matches?: (selector: string) => boolean;
  getAttribute?: (name: string) => string | null;
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);

const EDITABLE_ROLES = new Set(["combobox", "searchbox", "textbox"]);

function eventPath(event: KeyboardActionTarget): readonly EventTarget[] {
  const path = event.composedPath?.() ?? [];
  if (path.length > 0) return path;
  const ancestors: EventTarget[] = [];
  for (let current = event.target; current; current = asElement(current)?.parentElement ?? null) {
    ancestors.push(current);
  }
  return ancestors;
}

function asElement(target: EventTarget): KeyboardActionElementLike | null {
  const candidate = target as KeyboardActionElementLike;
  if (typeof candidate.tagName === "string") return candidate;
  if (typeof candidate.getAttribute === "function") return candidate;
  return null;
}

function keyboardScopeAttribute(element: KeyboardActionElementLike): "local" | "terminal" | null {
  const value = element.getAttribute?.("data-nodex-keyboard-scope");
  if (value === "terminal" || element.getAttribute?.("data-codex-terminal") != null) {
    return "terminal";
  }
  const role = element.getAttribute?.("role");
  return value === "local" || role === "dialog" || role === "alertdialog" ? "local" : null;
}

export function keyboardActionHasContext(
  event: KeyboardActionTarget,
  context: KeyboardActionContext,
): boolean {
  return eventPath(event).some((target) => {
    const element = asElement(target);
    return element?.getAttribute?.("data-nodex-keyboard-context") === context;
  });
}

function elementIsTextInput(element: KeyboardActionElementLike): boolean {
  const tagName = element.tagName?.toUpperCase();
  if (tagName === "TEXTAREA" || tagName === "SELECT") return true;
  if (tagName !== "INPUT") return false;
  const type = (element.type ?? element.getAttribute?.("type") ?? "text").toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(type);
}

function elementHasEditableRole(element: KeyboardActionElementLike): boolean {
  const role = element.getAttribute?.("role")?.toLowerCase();
  return role ? EDITABLE_ROLES.has(role) : false;
}

export function classifyKeyboardActionSurface(
  event: KeyboardActionTarget,
): KeyboardActionSurfaceScope {
  return classifyKeyboardActionPath(eventPath(event));
}

export function classifyKeyboardActionPath(
  path: readonly EventTarget[],
): KeyboardActionSurfaceScope {
  return classifyKeyboardActionElements(path.map(asElement).filter((element) => element !== null));
}

function classifyKeyboardActionElements(
  elements: readonly KeyboardActionElementLike[],
): KeyboardActionSurfaceScope {
  for (const element of elements) {
    if (keyboardScopeAttribute(element) === "terminal") return "terminal";
  }
  for (const element of elements) {
    if (keyboardScopeAttribute(element) === "local") return "local";
  }

  return pathHasEditableFocus(elements) ? "editable" : "global";
}

function pathHasEditableFocus(elements: readonly KeyboardActionElementLike[]): boolean {
  let contentEditableBoundaryReached = false;
  for (const element of elements) {
    if (elementIsTextInput(element) || elementHasEditableRole(element)) {
      return true;
    }

    const contentEditable = element.getAttribute?.("contenteditable");
    if (contentEditable !== null && contentEditable !== undefined) {
      contentEditableBoundaryReached = true;
      if (contentEditable.toLowerCase() !== "false") return true;
      continue;
    }
    if (!contentEditableBoundaryReached && element.isContentEditable) {
      return true;
    }
  }

  return false;
}

/** Resolves only selections fully inside one Page's editable document. */
export function readPageKeyboardSelection(target: EventTarget | null): string | null {
  if (!(target instanceof Element) || target.closest("input, textarea, select")) return null;
  const editor = target.closest(".nfm-editor");
  const selection = editor?.ownerDocument.getSelection();
  if (
    !editor ||
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode
  ) {
    return null;
  }
  const hostFor = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest("[contenteditable]");
  const host = hostFor(selection.anchorNode);
  if (!host || host !== hostFor(selection.focusNode) || host.closest(".nfm-editor") !== editor) {
    return null;
  }
  if (host.getAttribute("contenteditable") === "false" || hostFor(target) !== host) return null;
  return selection.toString().replace(/\r\n?/gu, "\n").trim() || null;
}

function keyboardActionEventIsFresh(event: KeyboardActionEventLike, allowRepeat: boolean): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    event.key !== "Process" &&
    (!event.repeat || allowRepeat)
  );
}

function isEditableTextEntry(event: KeyboardShortcutEventLike, platform: RuntimePlatform): boolean {
  if (
    platform === "linux" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key.toLowerCase() === "u" || event.code === "KeyU")
  ) {
    return true;
  }
  // Option and alternate layouts can type a character or begin a dead-key sequence.
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === "Dead" ||
      (Array.from(event.key).length === 1 &&
        (platform === "macOS" || (event.key.codePointAt(0) ?? 0) > 0x7f)))
  );
}

const PAGE_EDITOR_SHORTCUTS = [
  "CmdOrCtrl+B",
  "CmdOrCtrl+Shift+E",
  "CmdOrCtrl+Alt+1",
  "CmdOrCtrl+Alt+2",
  "CmdOrCtrl+Alt+3",
  "CmdOrCtrl+Alt+4",
];

export function keyboardActionMayRun(
  event: KeyboardActionEventLike,
  policy: KeyboardActionPolicy,
  platform?: RuntimePlatform,
): boolean {
  if (!keyboardActionEventIsFresh(event, policy.allowRepeat)) return false;

  const elements = eventPath(event)
    .map(asElement)
    .filter((element) => element !== null);
  const scope = classifyKeyboardActionElements(elements);
  const isPage = elements.some((element) => element.matches?.(".nfm-editor"));
  if (policy.onlyInPage && !isPage) return false;
  if (scope === "terminal" && !policy.runInsideTerminal) return false;
  if (scope === "local" && !policy.runInsideLocalSurface) return false;
  if (scope === "global") return true;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return false;
  if (scope !== "editable" && !pathHasEditableFocus(elements)) return true;
  if (!policy.runWithEditableFocus || event.getModifierState?.("AltGraph")) return false;
  if (platform && isEditableTextEntry(event, platform)) return false;
  // Reserve fixed editing chords even when the editor cannot act on its current selection.
  if (
    platform &&
    isPage &&
    !policy.onlyInPage &&
    PAGE_EDITOR_SHORTCUTS.some((accelerator) =>
      matchesKeyboardEventToAccelerator(event, accelerator, platform),
    )
  )
    return false;

  switch (policy.editableContext) {
    case "composer":
      return keyboardActionHasContext(event, "composer");
    case "panel-tab":
      return (
        elements.some((element) => element.matches?.("[data-panel-tab-shortcuts-pass-through]")) ||
        (isPage && !elements.some(elementIsTextInput))
      );
    case "page-selection":
      return isPage && Boolean(readPageKeyboardSelection(event.target));
    default:
      return true;
  }
}

export function matchesKeyboardActionCommand(
  event: KeyboardActionEventLike,
  keymap: CommandKeymapState,
  commandId: CommandId,
): boolean {
  const entry = getCommandEntry(keymap, commandId);
  return (
    entry?.available === true &&
    matchesKeyboardEventToCommand(event, keymap, commandId) &&
    keyboardActionMayRun(event, entry.keyboardActionPolicy, keymap.platform)
  );
}
