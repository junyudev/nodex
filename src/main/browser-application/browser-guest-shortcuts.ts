import {
  getCommandEntry,
  matchesKeyboardEventToAccelerator,
  type CommandKeymapState,
  type KeyboardShortcutEventLike,
} from "../../shared/command-keybindings";
import {
  FIND_NEXT_COMMAND_ID,
  FIND_PREVIOUS_COMMAND_ID,
  type WorkbenchCommandId,
} from "../../shared/workbench-commands";

/** Main acts on these itself: a new window, or the page's own history. */
type MainGuestShortcutCommand = "newWindow" | "navigateBack" | "navigateForward";

const RESERVED_COMMANDS = [
  "newThread",
  "newWindow",
  "focusBrowserAddressBar",
  "openBrowserTab",
  "closeTab",
  "toggleBottomPanel",
  "toggleFullView",
  "navigateBack",
  "navigateForward",
] as const satisfies readonly (WorkbenchCommandId | MainGuestShortcutCommand)[];

const FIXED_FIND_BINDINGS: Partial<Record<string, string>> = {
  [FIND_NEXT_COMMAND_ID]: "CmdOrCtrl+G",
  [FIND_PREVIOUS_COMMAND_ID]: "CmdOrCtrl+Shift+G",
};

const PAGE_FIRST_COMMANDS = [
  "openCommandMenu",
  "searchPages",
  "findInThread",
  FIND_NEXT_COMMAND_ID,
  FIND_PREVIOUS_COMMAND_ID,
  "previousThread",
  "nextThread",
  "nextThreadNeedingAttention",
] as const satisfies readonly WorkbenchCommandId[];

type ReservedCommand = (typeof RESERVED_COMMANDS)[number];
type PageFirstCommand = (typeof PAGE_FIRST_COMMANDS)[number];
export type BrowserGuestShortcutCommand = ReservedCommand | PageFirstCommand;

export function makeBrowserGuestShortcuts(keymap: CommandKeymapState) {
  const bindingsFor = <Id extends BrowserGuestShortcutCommand>(commandId: Id) => {
    const entry = getCommandEntry(keymap, commandId);
    // Find navigation currently has fixed bindings. A registry entry supersedes them.
    const fixed = FIXED_FIND_BINDINGS[commandId];
    const bindings =
      entry?.keybindings.flatMap(({ key }) => (key ? [key] : [])) ?? (fixed ? [fixed] : []);
    return { commandId, bindings };
  };
  return {
    platform: keymap.platform,
    reserved: RESERVED_COMMANDS.map(bindingsFor),
    pageFirst: PAGE_FIRST_COMMANDS.map(bindingsFor),
  };
}

export type BrowserGuestShortcuts = ReturnType<typeof makeBrowserGuestShortcuts>;

export function browserShortcutEvent(input: Electron.Input): KeyboardShortcutEventLike {
  return {
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
  };
}

export function mayRouteNativeShortcut(input: Electron.Input): boolean {
  return (
    (input.type === "keyDown" || input.type === "keyUp") &&
    !input.isComposing &&
    !["Process", "Dead", "AltGraph"].includes(input.key) &&
    !input.modifiers?.some((modifier) => ["altgr", "altgraph"].includes(modifier.toLowerCase()))
  );
}

export function matchBrowserGuestShortcut(
  event: KeyboardShortcutEventLike,
  shortcuts: BrowserGuestShortcuts,
) {
  const matches = ({ bindings }: { bindings: string[] }) =>
    bindings.some((key) => matchesKeyboardEventToAccelerator(event, key, shortcuts.platform));
  const reserved = shortcuts.reserved.find(matches);
  if (reserved) return { ...reserved, pageFirst: false } as const;
  const pageFirst = shortcuts.pageFirst.find(matches);
  return pageFirst ? ({ ...pageFirst, pageFirst: true } as const) : null;
}
