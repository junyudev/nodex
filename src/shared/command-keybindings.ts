export const COMMAND_KEYMAP_VERSION = 1;
export const COMMAND_KEYBINDINGS_CHANGED_CHANNEL = "command-keybindings:changed";
export const PREVIOUS_PANEL_TAB_COMMAND_ID = "previousPanelTab";
export const NEXT_PANEL_TAB_COMMAND_ID = "nextPanelTab";

export type RuntimePlatform = "macOS" | "windows" | "linux";
export type CommandShortcutScope = "app" | "electron" | "os-global" | "webview";

export interface CommandKeybindingRecord {
  key: string | null;
}

export type CommandKeybindingUpdate =
  | { type: "set"; keybinding: CommandKeybindingRecord }
  | {
      type: "replace";
      oldKeybinding: CommandKeybindingRecord;
      newKeybinding: CommandKeybindingRecord;
    }
  | { type: "append"; keybinding: CommandKeybindingRecord }
  | { type: "remove"; keybinding: CommandKeybindingRecord }
  | { type: "reset" };

export interface CommandRegistryEntry {
  id: string;
  title: string;
  description: string;
  order: number;
  shortcutScope: CommandShortcutScope;
  defaultKeybindings: CommandKeybindingRecord[];
  allowsMultiple?: boolean;
  allowsBareModifiers?: boolean;
  allowsSequences?: boolean;
  available: boolean;
  commandMenuGroupKey?: string;
}

export interface CommandKeymapEntry extends CommandRegistryEntry {
  keybindings: CommandKeybindingRecord[];
  customKeybindings: CommandKeybindingRecord[] | null;
  isCustom: boolean;
  hasDefault: boolean;
}

export interface CommandKeymapState {
  version: typeof COMMAND_KEYMAP_VERSION;
  platform: RuntimePlatform;
  entries: CommandKeymapEntry[];
  hasCustomBindings: boolean;
}

export interface CommandShortcutPresentation {
  label: string;
  ariaKeyShortcuts?: string;
}

export type CommandKeybindingOverrides = Record<string, string[]>;

interface ParsedChord {
  modifiers: string[];
  key: string | null;
}

export interface KeyboardShortcutEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const SUPPORTED_KEYBOARD_CODES = [
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Enter",
  "Tab",
  "Space",
  "Backspace",
  "Escape",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
] as const;

export type SupportedKeyboardCode = (typeof SUPPORTED_KEYBOARD_CODES)[number];

export interface KeyboardLayoutSnapshot {
  readonly generation: number;
  readonly entries: Readonly<Partial<Record<SupportedKeyboardCode, string>>>;
}

export type MacNativeHotkeyModifier = "command" | "control" | "function" | "option" | "shift";

/** Physical shortcut registration and native key observation share one compiled binding. */
export interface MacNativeHotkeySpec {
  readonly bindingId: string;
  readonly mode: "hold" | "toggle";
  readonly registrationAccelerator: string | null;
  readonly modifiers: readonly MacNativeHotkeyModifier[];
  readonly keyCode: number | null;
  /** Null with no keyCode observes modifier families regardless of left/right side. */
  readonly bareModifierKeyCodes: readonly number[] | null;
}

export type MacNativeHotkeyCompilation =
  | { readonly type: "compiled"; readonly spec: MacNativeHotkeySpec }
  | { readonly type: "rejected"; readonly reason: CommandKeybindingRejection };

export type CommandKeybindingRejectionKind =
  | "conflict"
  | "duplicate"
  | "invalid-accelerator"
  | "modifier-required"
  | "non-modifier-required"
  | "unsupported-key"
  | "unsupported-sequence"
  | "permission-required"
  | "runtime-degraded";

export interface CommandKeybindingRejection {
  readonly kind: CommandKeybindingRejectionKind;
  readonly message: string;
  readonly conflictingCommandId?: string;
  readonly conflictingCommandTitle?: string;
}

export type CommandKeybindingMutationResult =
  | { readonly type: "applied"; readonly state: CommandKeymapState }
  | {
      readonly type: "rejected";
      readonly state: CommandKeymapState;
      readonly reason: CommandKeybindingRejection;
    };

export class CommandKeybindingValidationError extends Error {
  readonly rejection: CommandKeybindingRejection;

  constructor(rejection: CommandKeybindingRejection) {
    super(rejection.message);
    this.name = "CommandKeybindingValidationError";
    this.rejection = rejection;
  }
}

export interface MouseShortcutEventLike {
  button: number;
}

export interface KeyboardShortcutSequenceState {
  prefix: readonly string[];
  expiresAt: number;
}

export type KeyboardShortcutSequenceMatch =
  | { readonly kind: "none"; readonly state: KeyboardShortcutSequenceState }
  | { readonly kind: "pending"; readonly state: KeyboardShortcutSequenceState }
  | {
      readonly kind: "matched";
      readonly commandId: CommandId;
      readonly state: KeyboardShortcutSequenceState;
    };

export const EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE: KeyboardShortcutSequenceState = {
  prefix: [],
  expiresAt: 0,
};

const MODIFIER_ALIASES = new Map<string, string>([
  ["cmdorctrl", "CmdOrCtrl"],
  ["commandorcontrol", "CmdOrCtrl"],
  ["cmd", "Command"],
  ["command", "Command"],
  ["meta", "Command"],
  ["super", "Command"],
  ["control", "Ctrl"],
  ["ctrl", "Ctrl"],
  ["option", "Alt"],
  ["alt", "Alt"],
  ["shift", "Shift"],
]);

const MODIFIER_ORDER = ["CmdOrCtrl", "Command", "Ctrl", "Alt", "Shift"];
const MODIFIER_SET = new Set(MODIFIER_ORDER);
const GLOBAL_PRIMARY_MODIFIER_SET = new Set(["CmdOrCtrl", "Command", "Ctrl", "Alt"]);

const MAC_BARE_MODIFIER_ALIASES = new Map<string, string>([
  ["fn", "Fn"],
  ["leftoption", "LeftOption"],
  ["leftalt", "LeftOption"],
  ["rightoption", "RightOption"],
  ["rightalt", "RightOption"],
  ["doubleoption", "DoubleOption"],
  ["doublealt", "DoubleOption"],
  ["leftoption+rightoption", "DoubleOption"],
  ["leftalt+rightalt", "DoubleOption"],
  ["leftcommand", "LeftCommand"],
  ["leftcmd", "LeftCommand"],
  ["leftmeta", "LeftCommand"],
  ["rightcommand", "RightCommand"],
  ["rightcmd", "RightCommand"],
  ["rightmeta", "RightCommand"],
  ["doublecommand", "DoubleCommand"],
  ["leftcommand+rightcommand", "DoubleCommand"],
  ["leftcmd+rightcmd", "DoubleCommand"],
  ["leftmeta+rightmeta", "DoubleCommand"],
  ["leftcontrol", "LeftControl"],
  ["leftctrl", "LeftControl"],
  ["doubleshift", "DoubleShift"],
  ["leftshift+rightshift", "DoubleShift"],
]);
const UNSUPPORTED_MAC_BARE_MODIFIERS = new Set([
  "rightcontrol",
  "rightctrl",
  "leftshift",
  "rightshift",
]);

const MAC_BARE_MODIFIER_FAMILIES: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  command: "Command",
  cmd: "Command",
  meta: "Command",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  fn: "Fn",
};
const MAC_BARE_MODIFIER_ORDER = ["Ctrl", "Command", "Alt", "Shift", "Fn"] as const;
const MAC_NATIVE_MODIFIER_BY_NAME: Readonly<Record<string, MacNativeHotkeyModifier>> = {
  Ctrl: "control",
  Command: "command",
  Alt: "option",
  Shift: "shift",
  Fn: "function",
};

const KEY_ALIASES = new Map<string, string>([
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["return", "Enter"],
  ["enter", "Enter"],
  ["space", "Space"],
  ["spacebar", "Space"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["tab", "Tab"],
  ["up", "Up"],
  ["arrowup", "Up"],
  ["down", "Down"],
  ["arrowdown", "Down"],
  ["left", "Left"],
  ["arrowleft", "Left"],
  ["right", "Right"],
  ["arrowright", "Right"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["home", "Home"],
  ["end", "End"],
  ["backquote", "`"],
  ["grave", "`"],
  ["comma", ","],
  ["period", "."],
  ["slash", "/"],
  ["backslash", "\\"],
  ["bracketleft", "["],
  ["bracketright", "]"],
  ["minus", "-"],
  ["equal", "="],
  ["plus", "Plus"],
  ["+", "Plus"],
  ["mouseback", "MouseBack"],
  ["mouseforward", "MouseForward"],
]);

const DEFAULT_KEY_BY_CODE: Readonly<Record<SupportedKeyboardCode, string>> = {
  KeyA: "A",
  KeyB: "B",
  KeyC: "C",
  KeyD: "D",
  KeyE: "E",
  KeyF: "F",
  KeyG: "G",
  KeyH: "H",
  KeyI: "I",
  KeyJ: "J",
  KeyK: "K",
  KeyL: "L",
  KeyM: "M",
  KeyN: "N",
  KeyO: "O",
  KeyP: "P",
  KeyQ: "Q",
  KeyR: "R",
  KeyS: "S",
  KeyT: "T",
  KeyU: "U",
  KeyV: "V",
  KeyW: "W",
  KeyX: "X",
  KeyY: "Y",
  KeyZ: "Z",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Enter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  F13: "F13",
  F14: "F14",
  F15: "F15",
  F16: "F16",
  F17: "F17",
  F18: "F18",
  F19: "F19",
  F20: "F20",
};

const MAC_KEY_CODE_BY_CODE: Readonly<Record<SupportedKeyboardCode, number>> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Equal: 24,
  Digit9: 25,
  Digit7: 26,
  Minus: 27,
  Digit8: 28,
  Digit0: 29,
  BracketRight: 30,
  KeyO: 31,
  KeyU: 32,
  BracketLeft: 33,
  KeyI: 34,
  KeyP: 35,
  Enter: 36,
  KeyL: 37,
  KeyJ: 38,
  Quote: 39,
  KeyK: 40,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  KeyN: 45,
  KeyM: 46,
  Period: 47,
  Tab: 48,
  Space: 49,
  Backquote: 50,
  Backspace: 51,
  Escape: 53,
  F17: 64,
  F18: 79,
  F19: 80,
  F20: 90,
  F5: 96,
  F6: 97,
  F7: 98,
  F3: 99,
  F8: 100,
  F9: 101,
  F11: 103,
  F13: 105,
  F16: 106,
  F14: 107,
  F10: 109,
  F12: 111,
  F15: 113,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  F4: 118,
  End: 119,
  F2: 120,
  PageDown: 121,
  F1: 122,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
};

const SUPPORTED_GLOBAL_SHORTCUT_KEYS = new Set(Object.values(DEFAULT_KEY_BY_CODE));
const SUPPORTED_KEYBOARD_CODE_SET = new Set<string>(SUPPORTED_KEYBOARD_CODES);

export const DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT: KeyboardLayoutSnapshot = {
  generation: 0,
  entries: DEFAULT_KEY_BY_CODE,
};

export const CODEX_COMMAND_REGISTRY = [
  command("archiveThread", "Archive chat", "Archive the current chat", 10, "app", [
    "CmdOrCtrl+Shift+A",
  ]),
  command(
    "copyConversationMarkdown",
    "Copy as Markdown",
    "Copy the complete current chat as Markdown",
    15,
    "app",
    [],
  ),
  command(
    "newThread",
    "New chat",
    "Start a new chat",
    20,
    "app",
    ["CmdOrCtrl+N", "CmdOrCtrl+Shift+O"],
    {
      allowsMultiple: true,
    },
  ),
  command("openSideChat", "Open side chat", "Open a side chat for the current chat", 30, "app", [
    "CmdOrCtrl+Alt+S",
  ]),
  command(
    "openThreadInNewWindow",
    "Open chat in new window",
    "Open the current chat in a new window",
    40,
    "app",
    [],
  ),
  command("quickChat", "New quick chat", "Start a quick chat", 50, "app", ["CmdOrCtrl+Alt+N"]),
  command("toggleThreadPin", "Toggle pin", "Pin or unpin the current chat", 60, "app", [
    "CmdOrCtrl+Alt+P",
  ]),
  command("findInThread", "Find", "Find in the current chat, review, or project view", 70, "app", [
    "CmdOrCtrl+F",
  ]),
  command(
    "openModelPicker",
    "Select model",
    "Choose the model, effort, and speed for the next turn",
    75,
    "app",
    ["Ctrl+Shift+M"],
  ),
  command(
    "composerDictationHold",
    "Hold to dictate",
    "Hold to dictate in the active composer",
    76,
    "app",
    ["Ctrl+M"],
  ),
  command(
    "focusBrowserAddressBar",
    "Focus browser address bar",
    "Focus the active Browser tab address bar",
    80,
    "app",
    ["CmdOrCtrl+L"],
  ),
  command(
    "navigateBack",
    "Back",
    "Go back in the app window history",
    90,
    "app",
    ["CmdOrCtrl+[", "MouseBack"],
    {
      allowsMultiple: true,
    },
  ),
  command(
    "navigateForward",
    "Forward",
    "Go forward in the app window history",
    100,
    "app",
    ["CmdOrCtrl+]", "MouseForward"],
    {
      allowsMultiple: true,
    },
  ),
  command("toggleBottomPanel", "Toggle bottom panel", "Show or hide the bottom panel", 120, "app", [
    "CmdOrCtrl+J",
  ]),
  command(
    PREVIOUS_PANEL_TAB_COMMAND_ID,
    "Previous panel tab",
    "Select the previous tab in the focused panel group",
    121,
    "app",
    ["CmdOrCtrl+Shift+["],
  ),
  command(
    NEXT_PANEL_TAB_COMMAND_ID,
    "Next panel tab",
    "Select the next tab in the focused panel group",
    122,
    "app",
    ["CmdOrCtrl+Shift+]"],
  ),
  command(
    "toggleBrowserPanel",
    "Toggle browser panel",
    "Show or hide the Browser panel",
    130,
    "app",
    ["CmdOrCtrl+Shift+B"],
    {
      available: false,
    },
  ),
  command(
    "openBrowserTab",
    "New browser tab",
    "Open a Browser tab in the active panel",
    140,
    "app",
    ["CmdOrCtrl+T"],
  ),
  command("openReviewTab", "Open review tab", "Open a Review tab in the active panel", 150, "app", [
    "Ctrl+Shift+G",
  ]),
  command("toggleTerminal", "Open terminal tab", "Focus or create a terminal tab", 160, "app", [
    "Ctrl+`",
  ]),
  command("toggleSidebar", "Toggle sidebar", "Show or hide the sidebar", 170, "app", [
    "CmdOrCtrl+B",
  ]),
  command("toggleSidePanel", "Toggle side panel", "Show or hide the side panel", 180, "app", [
    "CmdOrCtrl+Alt+B",
  ]),
  command("toggleFileTreePanel", "Toggle file tree panel", "Open the Files panel", 190, "app", [
    "CmdOrCtrl+Shift+E",
  ]),
  command("searchChats", "Search chats", "Search chats in the command palette", 200, "app", [
    "CmdOrCtrl+G",
  ]),
  command("searchPages", "Search Pages", "Search Pages in the command palette", 210, "app", [
    "CmdOrCtrl+P",
  ]),
  command(
    "createPage",
    "Create Page",
    "Create a Page in the active Project",
    212,
    "app",
    ["C", "CmdOrCtrl+Shift+C"],
    { allowsMultiple: true },
  ),
  command(
    "createPageExpanded",
    "Create Page in expanded composer",
    "Create a Page using the full-window composer",
    213,
    "app",
    ["V"],
  ),
  command("searchAll", "Search", "Search Pages and chats", 214, "app", ["/"], {
    commandMenuGroupKey: "general",
  }),
  command("searchFiles", "Search files", "Search files in the command palette", 215, "app", [], {
    commandMenuGroupKey: "general",
  }),
  command(
    "openCommandMenu",
    "Open command palette",
    "Open the command palette",
    220,
    "app",
    ["CmdOrCtrl+K", "CmdOrCtrl+Shift+P"],
    {
      allowsMultiple: true,
    },
  ),
  command("settings", "Settings", "Open settings", 230, "app", ["CmdOrCtrl+,"]),
  command(
    "showKeyboardShortcuts",
    "Keyboard shortcuts",
    "Show available keyboard shortcuts",
    240,
    "app",
    ["Shift+/", "CmdOrCtrl+Shift+/"],
    {
      allowsMultiple: true,
      commandMenuGroupKey: "general",
    },
  ),
  command("goToPages", "Go to Pages", "Open the Pages workspace", 241, "app", ["G P"], {
    allowsSequences: true,
    commandMenuGroupKey: "navigation",
  }),
  command("goToSettings", "Go to Settings", "Open Settings", 242, "app", ["G S"], {
    allowsSequences: true,
    commandMenuGroupKey: "navigation",
  }),
  command("openPage", "Open Page", "Search and open a Page", 243, "app", ["O P"], {
    allowsSequences: true,
    commandMenuGroupKey: "navigation",
  }),
  command("openChat", "Open chat", "Search and open a chat", 244, "app", ["O T"], {
    allowsSequences: true,
    commandMenuGroupKey: "navigation",
  }),
  command(
    "openLastToastAction",
    "Open latest notification action",
    "Run the action from the latest notification",
    245,
    "app",
    ["CmdOrCtrl+Alt+O"],
    {
      commandMenuGroupKey: "general",
    },
  ),
  command(
    "workOnPage",
    "Work on Page",
    "Start a new chat from the highlighted Page",
    246,
    "app",
    ["W O"],
    {
      allowsSequences: true,
      commandMenuGroupKey: "page",
    },
  ),
  command(
    "boardFocusNext",
    "Highlight next Page",
    "Move the Board highlight forward",
    246,
    "app",
    ["J", "Down"],
    {
      allowsMultiple: true,
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardFocusPrevious",
    "Highlight previous Page",
    "Move the Board highlight backward",
    247,
    "app",
    ["K", "Up"],
    {
      allowsMultiple: true,
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardFocusLeft",
    "Highlight Page to the left",
    "Move the Board highlight to the previous column",
    248,
    "app",
    ["Left"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardFocusRight",
    "Highlight Page to the right",
    "Move the Board highlight to the next column",
    249,
    "app",
    ["Right"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command("boardPeek", "Peek Page", "Preview the highlighted Page", 250, "app", ["Space"], {
    commandMenuGroupKey: "board",
  }),
  command("boardOpen", "Open Page", "Open the highlighted Page", 251, "app", ["Enter"], {
    commandMenuGroupKey: "board",
  }),
  command(
    "boardToggleSelection",
    "Select Page",
    "Toggle selection for the highlighted Page",
    252,
    "app",
    ["X"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardClearSelection",
    "Clear Page selection",
    "Clear selected Pages or close Peek",
    253,
    "app",
    ["Escape"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardSetStatus",
    "Set Page status",
    "Change status for the highlighted or selected Pages",
    254,
    "app",
    ["S"],
    {
      commandMenuGroupKey: "page",
    },
  ),
  command(
    "boardSetPriority",
    "Set Page priority",
    "Change priority for the highlighted or selected Pages",
    255,
    "app",
    ["P"],
    {
      commandMenuGroupKey: "page",
    },
  ),
  command(
    "boardSetEstimate",
    "Set Page estimate",
    "Change estimate for the highlighted or selected Pages",
    256,
    "app",
    ["Shift+E"],
    {
      commandMenuGroupKey: "page",
    },
  ),
  command(
    "boardSetTags",
    "Set Page tags",
    "Change tags for the highlighted or selected Pages",
    257,
    "app",
    ["L"],
    {
      commandMenuGroupKey: "page",
    },
  ),
  command(
    "boardMoveUp",
    "Move Page up",
    "Move highlighted or selected Pages up",
    258,
    "app",
    ["Alt+Up"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardMoveDown",
    "Move Page down",
    "Move highlighted or selected Pages down",
    259,
    "app",
    ["Alt+Down"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardMoveTop",
    "Move Page to top",
    "Move highlighted or selected Pages to the top",
    260,
    "app",
    ["Alt+Shift+Up"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardMoveBottom",
    "Move Page to bottom",
    "Move highlighted or selected Pages to the bottom",
    261,
    "app",
    ["Alt+Shift+Down"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardMoveLeft",
    "Move Page left",
    "Move highlighted or selected Pages to the previous column",
    262,
    "app",
    ["Alt+Left"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command(
    "boardMoveRight",
    "Move Page right",
    "Move highlighted or selected Pages to the next column",
    263,
    "app",
    ["Alt+Right"],
    {
      commandMenuGroupKey: "board",
    },
  ),
  command("renameThread", "Rename chat", "Rename the active chat", 270, "app", ["CmdOrCtrl+Alt+R"]),
  command("closeTab", "Close tab", "Close the focused panel tab", 280, "app", ["CmdOrCtrl+W"]),
  command("closeWindow", "Close window", "Close the active app window", 290, "electron", [
    "CmdOrCtrl+Shift+W",
  ]),
  command("newWindow", "New window", "Open a new app window", 280, "electron", [
    "CmdOrCtrl+Shift+N",
  ]),
  command("openFolder", "Open folder", "Open a local folder", 290, "electron", ["CmdOrCtrl+O"], {
    available: false,
  }),
  command(
    "openProcessManager",
    "Open process manager",
    "Open the process manager",
    300,
    "electron",
    ["Ctrl+Alt+M"],
  ),
  command("hotkeyWindow", "Hotkey window", "Show the global hotkey window", 310, "os-global", [], {
    available: false,
  }),
  command(
    "globalDictationHold",
    "Hold to dictate",
    "Hold the global dictation hotkey",
    320,
    "os-global",
    [],
    {
      available: false,
      allowsBareModifiers: true,
    },
  ),
  command(
    "globalDictationToggle",
    "Toggle dictation",
    "Toggle global dictation",
    330,
    "os-global",
    [],
    {
      available: false,
      allowsBareModifiers: true,
    },
  ),
] as const satisfies readonly CommandRegistryEntry[];

export type CommandId = (typeof CODEX_COMMAND_REGISTRY)[number]["id"];

const COMMAND_IDS = new Set<string>(CODEX_COMMAND_REGISTRY.map((entry) => entry.id));

function isCommandId(value: string): value is CommandId {
  return COMMAND_IDS.has(value);
}

function command<const Id extends string>(
  id: Id,
  title: string,
  description: string,
  order: number,
  shortcutScope: CommandShortcutScope,
  defaultKeys: string[],
  options: Partial<
    Omit<
      CommandRegistryEntry,
      "id" | "title" | "description" | "order" | "shortcutScope" | "defaultKeybindings"
    >
  > = {},
): CommandRegistryEntry & { id: Id } {
  return {
    id,
    title,
    description,
    order,
    shortcutScope,
    defaultKeybindings: defaultKeys.map((key) => ({ key: normalizeAccelerator(key) })),
    allowsMultiple: options.allowsMultiple ?? defaultKeys.length > 1,
    allowsBareModifiers: options.allowsBareModifiers ?? false,
    allowsSequences: options.allowsSequences ?? false,
    available: options.available ?? true,
    commandMenuGroupKey: options.commandMenuGroupKey,
  };
}

export function resolveRuntimePlatform(nodePlatform = process.platform): RuntimePlatform {
  if (nodePlatform === "darwin") return "macOS";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}

export function normalizeCommandKeybindingOverrides(
  value: unknown,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): CommandKeybindingOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<CommandKeybindingOverrides>(
    (acc, [commandId, rawKeys]) => {
      if (!Array.isArray(rawKeys)) return acc;
      const isGlobalDictationCommand =
        commandId === "globalDictationHold" || commandId === "globalDictationToggle";
      const normalized = rawKeys
        .filter((rawKey): rawKey is string => typeof rawKey === "string")
        .map((rawKey) => normalizeCommandAccelerator(rawKey, isGlobalDictationCommand, platform))
        .filter((key) => key.length > 0)
        .filter(
          (key) =>
            (commandId !== "globalDictationHold" && commandId !== "globalDictationToggle") ||
            validateGlobalDictationShortcutRejection(key, platform) === null,
        );
      if (isGlobalDictationCommand && rawKeys.length > 0 && normalized.length === 0) {
        return acc;
      }
      acc[commandId] = normalized;
      return acc;
    },
    {},
  );
}

export function createCommandKeymapState(
  overrides: CommandKeybindingOverrides = {},
  platform: RuntimePlatform = resolveRuntimePlatform(),
): CommandKeymapState {
  const entries = CODEX_COMMAND_REGISTRY.slice()
    .sort((a, b) => a.order - b.order)
    .map((entry) => {
      const override = Object.prototype.hasOwnProperty.call(overrides, entry.id)
        ? (overrides[entry.id] ?? [])
        : null;
      const customKeybindings =
        override === null
          ? null
          : override.map((key) => ({
              key: normalizeCommandAccelerator(key, entry.shortcutScope === "os-global", platform),
            }));
      const keybindings = customKeybindings ?? entry.defaultKeybindings;

      return {
        ...entry,
        available:
          entry.available ||
          ((platform === "macOS" || platform === "windows") &&
            (entry.id === "globalDictationHold" || entry.id === "globalDictationToggle")),
        defaultKeybindings: entry.defaultKeybindings.map(cloneKeybinding),
        keybindings: keybindings.map(cloneKeybinding),
        customKeybindings: customKeybindings?.map(cloneKeybinding) ?? null,
        isCustom: customKeybindings !== null,
        hasDefault: entry.defaultKeybindings.length > 0,
      };
    });

  return {
    version: COMMAND_KEYMAP_VERSION,
    platform,
    entries,
    hasCustomBindings: Object.keys(overrides).length > 0,
  };
}

export function applyCommandKeybindingUpdate(
  overrides: CommandKeybindingOverrides,
  commandId: string,
  update: CommandKeybindingUpdate,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): CommandKeybindingOverrides {
  const entry = CODEX_COMMAND_REGISTRY.find((candidate) => candidate.id === commandId);
  if (!entry) {
    throw new Error(`Unknown command id: ${commandId}`);
  }
  if (update.type === "reset") {
    return omitOverride(overrides, commandId);
  }
  if (entry.shortcutScope === "os-global" && update.type === "append") {
    throw new Error("OS-global command shortcuts cannot be appended");
  }

  const current = Object.prototype.hasOwnProperty.call(overrides, commandId)
    ? (overrides[commandId] ?? [])
    : entry.defaultKeybindings.map((binding) => binding.key).filter(isString);
  const nextKeys = resolveNextOverrideKeys(current, entry, update, (key) =>
    normalizeCommandAccelerator(key, entry.shortcutScope === "os-global", platform),
  );
  validateCommandKeybindings(nextKeys, entry, overrides, commandId, platform);

  return {
    ...overrides,
    [commandId]: nextKeys,
  };
}

export function validateCommandKeybindings(
  keys: string[],
  entry: CommandRegistryEntry,
  overrides: CommandKeybindingOverrides,
  commandId: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): void {
  const normalizedKeys = keys.map((key) =>
    normalizeCommandAccelerator(key, entry.shortcutScope === "os-global", platform),
  );
  const seen = new Set<string>();

  normalizedKeys.forEach((key) => {
    if (entry.shortcutScope === "os-global") {
      const rejection = validateGlobalDictationShortcutRejection(key, platform);
      if (rejection) throw new CommandKeybindingValidationError(rejection);
    }
    if (!isValidAccelerator(key, { allowsBareModifiers: entry.allowsBareModifiers === true })) {
      throw new CommandKeybindingValidationError({
        kind: "invalid-accelerator",
        message: `Invalid keyboard shortcut: ${key}`,
      });
    }
    if (!entry.allowsSequences && key.includes(" ")) {
      throw new CommandKeybindingValidationError({
        kind: "unsupported-sequence",
        message: `Keyboard shortcut sequences are not supported for ${entry.title}`,
      });
    }
    if (seen.has(key)) {
      throw new CommandKeybindingValidationError({
        kind: "duplicate",
        message: `Duplicate keyboard shortcut: ${formatAcceleratorLabel(key, platform)}`,
      });
    }
    seen.add(key);

    const conflict = findCommandKeybindingConflict(
      createCommandKeymapState(overrides, platform),
      commandId,
      key,
    );
    if (conflict) {
      throw new CommandKeybindingValidationError({
        kind: "conflict",
        message: `Keyboard shortcut already used by ${conflict.commandTitle}`,
        conflictingCommandId: conflict.commandId,
        conflictingCommandTitle: conflict.commandTitle,
      });
    }
  });
}

/** Mirrors the native global-dictation admission rules used by the desktop host. */
export function validateGlobalDictationShortcut(
  accelerator: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): string | null {
  return validateGlobalDictationShortcutRejection(accelerator, platform)?.message ?? null;
}

export function validateGlobalDictationShortcutRejection(
  accelerator: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): CommandKeybindingRejection | null {
  if (platform === "macOS" && normalizeMacBareModifier(accelerator)) return null;

  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some(isKnownMacBareModifierPart)) {
    if (parts.length > 1) {
      return {
        kind: "unsupported-key",
        message: "Use Ctrl, Alt, or Command when combining with another key.",
      };
    }
    return {
      kind: "unsupported-key",
      message:
        platform === "macOS"
          ? "This shortcut key is not supported."
          : "Choose a shortcut with Ctrl or Alt plus another key.",
    };
  }
  if (parts.length === 0) {
    return { kind: "invalid-accelerator", message: "Shortcut cannot be empty." };
  }
  if (platform === "windows") {
    const unsupported = parts.some(
      (part) => part.toLowerCase() === "meta" || part.toLowerCase() === "commandorcontrol",
    );
    const hasReleaseModifier = parts.some((part) =>
      ["cmdorctrl", "command", "cmd", "control", "ctrl", "alt", "option", "shift"].includes(
        part.toLowerCase(),
      ),
    );
    if (unsupported || !hasReleaseModifier) {
      return { kind: "unsupported-key", message: "This shortcut key is not supported." };
    }
  }

  let hasPrimaryModifier = false;
  let nonModifierKey: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      if (GLOBAL_PRIMARY_MODIFIER_SET.has(modifier)) hasPrimaryModifier = true;
      continue;
    }
    if (nonModifierKey !== null) {
      return {
        kind: "invalid-accelerator",
        message: "Shortcut must include exactly one non-modifier key.",
      };
    }
    nonModifierKey = normalizeKeyName(part);
  }
  if (nonModifierKey === null) {
    return {
      kind: "non-modifier-required",
      message: "Shortcut must include a non-modifier key.",
    };
  }
  if (!SUPPORTED_GLOBAL_SHORTCUT_KEYS.has(nonModifierKey)) {
    return { kind: "unsupported-key", message: "This shortcut key is not supported." };
  }
  return hasPrimaryModifier
    ? null
    : { kind: "modifier-required", message: "Shortcut must include Cmd/Ctrl or Alt." };
}

export function createKeyboardLayoutSnapshot(
  generation: number,
  entries: Readonly<Record<string, string>>,
): KeyboardLayoutSnapshot {
  const normalizedEntries: Partial<Record<SupportedKeyboardCode, string>> = {};
  for (const [code, value] of Object.entries(entries)) {
    if (!SUPPORTED_KEYBOARD_CODE_SET.has(code)) continue;
    const normalized = normalizeKeyName(value);
    if (!SUPPORTED_GLOBAL_SHORTCUT_KEYS.has(normalized)) continue;
    normalizedEntries[code as SupportedKeyboardCode] = normalized;
  }
  return {
    generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    entries: normalizedEntries,
  };
}

const MAC_BARE_HOTKEYS: Readonly<
  Record<
    string,
    {
      readonly modifiers: readonly MacNativeHotkeyModifier[];
      readonly bareModifierKeyCodes: readonly number[];
    }
  >
> = {
  Fn: { modifiers: ["function"], bareModifierKeyCodes: [63] },
  LeftOption: { modifiers: ["option"], bareModifierKeyCodes: [58] },
  RightOption: { modifiers: ["option"], bareModifierKeyCodes: [61] },
  DoubleOption: { modifiers: ["option"], bareModifierKeyCodes: [58, 61] },
  LeftCommand: { modifiers: ["command"], bareModifierKeyCodes: [55] },
  RightCommand: { modifiers: ["command"], bareModifierKeyCodes: [54] },
  DoubleCommand: { modifiers: ["command"], bareModifierKeyCodes: [54, 55] },
  LeftControl: { modifiers: ["control"], bareModifierKeyCodes: [59] },
  DoubleShift: { modifiers: ["shift"], bareModifierKeyCodes: [56, 60] },
};

function keyboardCodeForCanonicalKey(
  key: string,
  layout: KeyboardLayoutSnapshot,
): SupportedKeyboardCode | null {
  for (const code of SUPPORTED_KEYBOARD_CODES) {
    const mapped = layout.entries[code] ?? DEFAULT_KEY_BY_CODE[code];
    if (normalizeKeyName(mapped) === key) return code;
  }
  return null;
}

/** Compiles a canonical product shortcut into the finite native helper protocol. */
export function compileMacNativeHotkey(input: {
  readonly accelerator: string;
  readonly bindingId: string;
  readonly mode: "hold" | "toggle";
  readonly layout?: KeyboardLayoutSnapshot;
}): MacNativeHotkeyCompilation {
  const normalized = normalizeAccelerator(input.accelerator);
  const validation = validateGlobalDictationShortcutRejection(normalized, "macOS");
  if (validation) return { type: "rejected", reason: validation };

  const bare = MAC_BARE_HOTKEYS[normalized];
  if (bare) {
    return {
      type: "compiled",
      spec: {
        bindingId: input.bindingId,
        mode: input.mode,
        registrationAccelerator: null,
        modifiers: bare.modifiers,
        keyCode: null,
        bareModifierKeyCodes: bare.bareModifierKeyCodes,
      },
    };
  }

  const bareFamilies = normalizeMacBareModifier(normalized);
  if (bareFamilies) {
    return {
      type: "compiled",
      spec: {
        bindingId: input.bindingId,
        mode: input.mode,
        registrationAccelerator: null,
        modifiers: bareFamilies.split("+").map((name) => MAC_NATIVE_MODIFIER_BY_NAME[name]!),
        keyCode: null,
        bareModifierKeyCodes: null,
      },
    };
  }

  const parsed = parseChord(normalized);
  if (!parsed?.key) {
    return {
      type: "rejected",
      reason: { kind: "invalid-accelerator", message: "Invalid global shortcut." },
    };
  }
  const code = keyboardCodeForCanonicalKey(
    parsed.key,
    input.layout ?? DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
  );
  if (!code) {
    return {
      type: "rejected",
      reason: { kind: "unsupported-key", message: "This shortcut key is not supported." },
    };
  }

  const modifiers = parsed.modifiers.flatMap<MacNativeHotkeyModifier>((modifier) => {
    if (modifier === "CmdOrCtrl" || modifier === "Command") return ["command"];
    if (modifier === "Ctrl") return ["control"];
    if (modifier === "Alt") return ["option"];
    if (modifier === "Shift") return ["shift"];
    return [];
  });
  return {
    type: "compiled",
    spec: {
      bindingId: input.bindingId,
      mode: input.mode,
      registrationAccelerator: [
        ...parsed.modifiers,
        /^[A-Z0-9]$/.test(parsed.key) ? code.replace(/^(Key|Digit)/, "") : parsed.key,
      ].join("+"),
      modifiers,
      keyCode: MAC_KEY_CODE_BY_CODE[code],
      bareModifierKeyCodes: null,
    },
  };
}

export function findCommandKeybindingConflict(
  state: CommandKeymapState,
  commandId: string,
  accelerator: string,
): { commandId: string; commandTitle: string; key: string } | null {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return null;
  const normalizedParts = normalized.split(/\s+/);

  for (const entry of state.entries) {
    if (entry.id === commandId || !entry.available) continue;
    // One global shortcut can distinguish a hold from a double tap.
    if (
      (commandId === "globalDictationHold" && entry.id === "globalDictationToggle") ||
      (commandId === "globalDictationToggle" && entry.id === "globalDictationHold")
    )
      continue;
    for (const binding of entry.keybindings) {
      const key = binding.key ? normalizeAccelerator(binding.key) : "";
      if (!key) continue;
      if (key === normalized || isSequencePrefix(key.split(/\s+/), normalizedParts)) {
        return { commandId: entry.id, commandTitle: entry.title, key };
      }
      if (isSequencePrefix(normalizedParts, key.split(/\s+/))) {
        return { commandId: entry.id, commandTitle: entry.title, key };
      }
    }
  }

  return null;
}

export function getCommandEntry(
  state: CommandKeymapState | null | undefined,
  commandId: string,
): CommandKeymapEntry | null {
  return state?.entries.find((entry) => entry.id === commandId) ?? null;
}

export function getCommandKeybindings(
  state: CommandKeymapState | null | undefined,
  commandId: string,
): CommandKeybindingRecord[] {
  return getCommandEntry(state, commandId)?.keybindings ?? [];
}

export function getPrimaryCommandAccelerator(
  state: CommandKeymapState | null | undefined,
  commandId: string,
): string | null {
  const binding = getCommandKeybindings(state, commandId).find((candidate) => {
    if (!candidate.key) return false;
    return !candidate.key.startsWith("Mouse");
  });
  return binding?.key ?? null;
}

export function formatCommandShortcutLabel(
  state: CommandKeymapState | null | undefined,
  commandId: string,
  fallback?: string,
): string | undefined {
  const accelerator = getPrimaryCommandAccelerator(state, commandId);
  if (!accelerator && getCommandEntry(state, commandId)) return undefined;
  if (!accelerator && !fallback) return undefined;
  const platform = state?.platform ?? resolveRuntimePlatform();
  return formatAcceleratorLabel(accelerator ?? fallback ?? "", platform);
}

export function resolveCommandShortcutPresentation(
  state: CommandKeymapState | null | undefined,
  commandId: string,
  fallback?: string,
): CommandShortcutPresentation | null {
  const accelerator = getPrimaryCommandAccelerator(state, commandId);
  if (!accelerator && getCommandEntry(state, commandId)) return null;

  const resolvedAccelerator = accelerator ?? fallback;
  if (!resolvedAccelerator) return null;

  const platform = state?.platform ?? resolveRuntimePlatform();
  const ariaKeyShortcuts = formatAcceleratorAriaKeyShortcut(resolvedAccelerator, platform);

  return {
    label: formatAcceleratorLabel(resolvedAccelerator, platform),
    ...(ariaKeyShortcuts ? { ariaKeyShortcuts } : {}),
  };
}

export function normalizeAccelerator(accelerator: string | null | undefined): string {
  if (!accelerator) return "";
  return accelerator.trim().split(/\s+/).map(normalizeChord).filter(Boolean).join(" ");
}

export function isValidAccelerator(
  accelerator: string | null | undefined,
  options: { allowsBareModifiers?: boolean } = {},
): boolean {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return false;

  return normalized.split(/\s+/).every((chord) => {
    const parsed = parseChord(chord);
    if (!parsed) return false;
    if (parsed.key) return true;
    return options.allowsBareModifiers === true && parsed.modifiers.length > 0;
  });
}

export function formatAcceleratorLabel(
  accelerator: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): string {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return "";

  return normalized
    .split(/\s+/)
    .map((chord) => formatChordLabel(chord, platform))
    .join(" ");
}

export function formatAcceleratorAriaKeyShortcut(
  accelerator: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): string | null {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized || normalized.includes(" ") || normalized.startsWith("Mouse")) {
    return null;
  }

  const parsed = parseChord(normalized);
  if (!parsed?.key || parsed.key.startsWith("Mouse")) return null;

  const modifiers = parsed.modifiers.map((modifier) => {
    if (modifier === "CmdOrCtrl") {
      return platform === "macOS" ? "Meta" : "Control";
    }
    if (modifier === "Command") return "Meta";
    if (modifier === "Ctrl") return "Control";
    return modifier;
  });

  return [...modifiers, formatAriaKeyName(parsed.key)].join("+");
}

export function commandAcceleratorsInclude(
  state: CommandKeymapState | null | undefined,
  commandId: string,
  accelerator: string,
): boolean {
  const normalized = normalizeAccelerator(accelerator);
  return getCommandKeybindings(state, commandId).some(
    (binding) => binding.key && normalizeAccelerator(binding.key) === normalized,
  );
}

export function keyboardEventToAccelerator(
  event: KeyboardShortcutEventLike,
  platform: RuntimePlatform = resolveRuntimePlatform(),
  options: {
    readonly allowsBareModifiers?: boolean;
    readonly keyboardLayout?: KeyboardLayoutSnapshot;
  } = {},
): string | null {
  const modifiers = eventModifiers(event, platform);
  const key = normalizeEventKey(event, options.keyboardLayout);
  const isBareModifier = MODIFIER_SET.has(key);

  if (isBareModifier && !options.allowsBareModifiers) return null;
  if (!key && modifiers.length === 0) return null;
  if (!key && !options.allowsBareModifiers) return null;

  const normalizedModifiers = sortModifiers(
    Array.from(
      new Set(isBareModifier ? modifiers.filter((modifier) => modifier !== key) : modifiers),
    ),
  );
  const parts = [...normalizedModifiers, isBareModifier ? null : key].filter(isString);
  if (parts.length === 0) return null;
  return normalizeAccelerator(parts.join("+"));
}

export function matchesKeyboardEventToCommand(
  event: KeyboardShortcutEventLike,
  state: CommandKeymapState | null | undefined,
  commandId: string,
): boolean {
  return getCommandKeybindings(state, commandId).some((binding) => {
    if (!binding.key) return false;
    return matchesKeyboardEventToAccelerator(
      event,
      binding.key,
      state?.platform ?? resolveRuntimePlatform(),
    );
  });
}

export function matchesKeyboardEventToAccelerator(
  event: KeyboardShortcutEventLike,
  accelerator: string,
  platform: RuntimePlatform = resolveRuntimePlatform(),
): boolean {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized || normalized.includes(" ") || normalized.startsWith("Mouse")) return false;
  const parsed = parseChord(normalized);
  if (!parsed) return false;
  const runtimeAccelerator = normalizeAccelerator(
    [
      ...parsed.modifiers.map((modifier) =>
        platform !== "macOS" && modifier === "Ctrl" ? "CmdOrCtrl" : modifier,
      ),
      parsed.key,
    ]
      .filter(isString)
      .join("+"),
  );
  const eventAccel = keyboardEventToAccelerator(event, platform, {
    allowsBareModifiers: parsed.key === null,
  });
  return eventAccel === runtimeAccelerator;
}

export function matchKeyboardShortcutSequence(
  event: KeyboardShortcutEventLike,
  state: CommandKeymapState,
  previous: KeyboardShortcutSequenceState,
  options: {
    readonly now?: number;
    readonly timeoutMs?: number;
    readonly commandAvailable?: (commandId: CommandId) => boolean;
  } = {},
): KeyboardShortcutSequenceMatch {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 900;
  const prefix = previous.expiresAt > now ? previous.prefix : [];
  const chord = keyboardEventToAccelerator(event, state.platform);
  if (!chord || chord.startsWith("Mouse")) {
    return { kind: "none", state: EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE };
  }

  const candidate = [...prefix, chord];
  const available = options.commandAvailable ?? (() => true);
  const sequenceBindings: Array<{
    readonly commandId: CommandId;
    readonly chords: string[];
  }> = state.entries.flatMap((entry) => {
    if (!isCommandId(entry.id) || !entry.available || !available(entry.id)) {
      return [];
    }
    const commandId = entry.id;
    return entry.keybindings.flatMap((binding) => {
      const normalized = normalizeAccelerator(binding.key);
      if (!normalized.includes(" ")) return [];
      return [{ commandId, chords: normalized.split(/\s+/) }];
    });
  });

  const exact = sequenceBindings.find(
    ({ chords }) =>
      chords.length === candidate.length &&
      chords.every((part, index) => part === candidate[index]),
  );
  if (exact) {
    return {
      kind: "matched",
      commandId: exact.commandId,
      state: EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE,
    };
  }

  const hasPrefix = sequenceBindings.some(
    ({ chords }) =>
      chords.length > candidate.length && candidate.every((part, index) => part === chords[index]),
  );
  if (hasPrefix) {
    return {
      kind: "pending",
      state: { prefix: candidate, expiresAt: now + timeoutMs },
    };
  }

  if (prefix.length > 0) {
    return matchKeyboardShortcutSequence(
      event,
      state,
      EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE,
      options,
    );
  }

  return { kind: "none", state: EMPTY_KEYBOARD_SHORTCUT_SEQUENCE_STATE };
}

export function matchesMouseEventToCommand(
  event: MouseShortcutEventLike,
  state: CommandKeymapState | null | undefined,
  commandId: string,
): boolean {
  const mouseKey = event.button === 3 ? "MouseBack" : event.button === 4 ? "MouseForward" : null;
  if (!mouseKey) return false;
  return commandAcceleratorsInclude(state, commandId, mouseKey);
}

export function toElectronAccelerator(accelerator: string | null | undefined): string | undefined {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized || normalized.startsWith("Mouse") || normalized.includes(" ")) return undefined;
  return normalized.replaceAll("CmdOrCtrl", "CommandOrControl").replaceAll("Ctrl", "Control");
}

function resolveNextOverrideKeys(
  current: string[],
  entry: CommandRegistryEntry,
  update: Exclude<CommandKeybindingUpdate, { type: "reset" }>,
  normalize: (key: string | null | undefined) => string = normalizeAccelerator,
): string[] {
  if (update.type === "set") {
    return [requiredKey(update.keybinding, normalize)];
  }
  if (update.type === "append") {
    if (!entry.allowsMultiple) {
      throw new Error(`${entry.title} only supports one keyboard shortcut`);
    }
    return [...current, requiredKey(update.keybinding, normalize)].map(normalize);
  }
  if (update.type === "replace") {
    const oldKey = requiredKey(update.oldKeybinding, normalize);
    const newKey = requiredKey(update.newKeybinding, normalize);
    const replaced = current.map((key) =>
      normalizeAccelerator(key) === normalizeAccelerator(oldKey) ? newKey : key,
    );
    return replaced.some((key) => normalizeAccelerator(key) === normalizeAccelerator(newKey))
      ? replaced.map(normalize)
      : [newKey];
  }

  const keyToRemove = requiredKey(update.keybinding, normalize);
  return current
    .filter((key) => normalizeAccelerator(key) !== normalizeAccelerator(keyToRemove))
    .map(normalize);
}

function omitOverride(
  overrides: CommandKeybindingOverrides,
  commandId: string,
): CommandKeybindingOverrides {
  const nextOverrides = { ...overrides };
  delete nextOverrides[commandId];
  return nextOverrides;
}

function cloneKeybinding(binding: CommandKeybindingRecord): CommandKeybindingRecord {
  return { key: binding.key };
}

function requiredKey(
  binding: CommandKeybindingRecord,
  normalize: (key: string | null | undefined) => string = normalizeAccelerator,
): string {
  const key = normalize(binding.key);
  if (!key) {
    throw new Error("Keyboard shortcut is required");
  }
  return key;
}

function normalizeCommandAccelerator(
  accelerator: string | null | undefined,
  global: boolean,
  platform: RuntimePlatform,
): string {
  // Windows release monitoring recognizes a narrower modifier vocabulary than Electron.
  // Preserve it through storage so an alias cannot silently change the release condition.
  return global && platform === "windows"
    ? (accelerator?.trim() ?? "")
    : normalizeAccelerator(accelerator);
}

function normalizeChord(chord: string): string {
  const bareModifier = normalizeMacBareModifier(chord);
  if (bareModifier) return bareModifier;

  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers: string[] = [];
  const keys: string[] = [];

  parts.forEach((part) => {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      modifiers.push(modifier);
      return;
    }
    keys.push(normalizeKeyName(part));
  });

  const sortedModifiers = sortModifiers(Array.from(new Set(modifiers)));
  return [...sortedModifiers, ...keys].join("+");
}

function parseChord(chord: string): ParsedChord | null {
  const normalized = normalizeChord(chord);
  if (!normalized) return null;
  const parts = normalized.split("+");
  const modifiers = parts.filter((part) => MODIFIER_SET.has(part));
  const keys = parts.filter((part) => !MODIFIER_SET.has(part));
  if (keys.length > 1) return null;
  const key = keys[0] ?? null;
  return { modifiers, key };
}

function normalizedBareModifierLookupKey(value: string): string {
  return value.replace(/[\s_-]/g, "").toLowerCase();
}

export function normalizeMacBareModifier(value: string): string | null {
  const named = MAC_BARE_MODIFIER_ALIASES.get(normalizedBareModifierLookupKey(value));
  if (named) return named;
  const families = value
    .split("+")
    .map((part) => MAC_BARE_MODIFIER_FAMILIES[part.trim().toLowerCase()]);
  if (families.some((family) => family === undefined) || new Set(families).size < 2) return null;
  return MAC_BARE_MODIFIER_ORDER.filter((family) => families.includes(family)).join("+");
}

function isKnownMacBareModifierPart(value: string): boolean {
  const lookupKey = normalizedBareModifierLookupKey(value);
  return MAC_BARE_MODIFIER_ALIASES.has(lookupKey) || UNSUPPORTED_MAC_BARE_MODIFIERS.has(lookupKey);
}

function normalizeKeyName(rawKey: string): string {
  const alias = KEY_ALIASES.get(rawKey.toLowerCase());
  if (alias) return alias;
  if (/^f\d{1,2}$/i.test(rawKey)) return rawKey.toUpperCase();
  if (rawKey.length === 1) return rawKey.toUpperCase();
  return rawKey;
}

function normalizeEventKey(
  event: Pick<KeyboardShortcutEventLike, "altKey" | "key" | "code" | "shiftKey">,
  layout: KeyboardLayoutSnapshot = DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
): string {
  if (event.key === " ") return "Space";
  if (event.shiftKey && event.code === "Slash") return "/";
  if (
    (event.altKey || event.shiftKey) &&
    event.code &&
    SUPPORTED_KEYBOARD_CODE_SET.has(event.code)
  ) {
    const code = event.code as SupportedKeyboardCode;
    return normalizeKeyName(layout.entries[code] ?? DEFAULT_KEY_BY_CODE[code]);
  }
  if (event.key && event.key !== "Unidentified") {
    return normalizeKeyName(event.key);
  }
  return normalizeKeyName(event.code ?? "");
}

function eventModifiers(
  event: Pick<KeyboardShortcutEventLike, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: RuntimePlatform,
): string[] {
  const modifiers: string[] = [];
  if (platform === "macOS" && event.metaKey) modifiers.push("CmdOrCtrl");
  if (platform !== "macOS" && event.ctrlKey) modifiers.push("CmdOrCtrl");
  if (platform === "macOS" && event.ctrlKey && !event.metaKey) modifiers.push("Ctrl");
  if (platform !== "macOS" && event.metaKey && !event.ctrlKey) modifiers.push("Command");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

function sortModifiers(modifiers: string[]): string[] {
  return modifiers.slice().sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
}

function formatChordLabel(chord: string, platform: RuntimePlatform): string {
  const parsed = parseChord(chord);
  if (!parsed) return "";

  if (parsed.key === "/" && parsed.modifiers.length === 1 && parsed.modifiers[0] === "Shift") {
    return "?";
  }

  const keyLabel = parsed.key ? formatKeyLabel(parsed.key, platform) : "";
  if (platform === "macOS") {
    return `${parsed.modifiers.map(formatMacModifierLabel).join("")}${keyLabel}`;
  }
  const modifierLabels = parsed.modifiers.map(formatNonMacModifierLabel);
  return [...modifierLabels, keyLabel].filter(Boolean).join("+");
}

function formatMacModifierLabel(modifier: string): string {
  if (modifier === "CmdOrCtrl" || modifier === "Command") return "⌘";
  if (modifier === "Ctrl") return "⌃";
  if (modifier === "Alt") return "⌥";
  if (modifier === "Shift") return "⇧";
  return modifier;
}

function formatNonMacModifierLabel(modifier: string): string {
  if (modifier === "CmdOrCtrl" || modifier === "Ctrl") return "Ctrl";
  if (modifier === "Command") return "Meta";
  if (modifier === "Alt") return "Alt";
  if (modifier === "Shift") return "Shift";
  return modifier;
}

function formatKeyLabel(key: string, platform: RuntimePlatform): string {
  const macOS = platform === "macOS";
  if (key === "Enter") return "⏎";
  if (key === "Escape") return "Esc";
  if (key === "LeftOption") return macOS ? "Left ⌥" : "Left Option";
  if (key === "RightOption") return macOS ? "Right ⌥" : "Right Option";
  if (key === "DoubleOption") return macOS ? "⌥ + ⌥" : "Double Option";
  if (key === "LeftCommand") return macOS ? "Left ⌘" : "Left Command";
  if (key === "RightCommand") return macOS ? "Right ⌘" : "Right Command";
  if (key === "DoubleCommand") return macOS ? "⌘ + ⌘" : "Double Command";
  if (key === "LeftControl") return macOS ? "Left ⌃" : "Left Control";
  if (key === "RightControl") return macOS ? "Right ⌃" : "Right Control";
  if (key === "LeftShift") return macOS ? "Left ⇧" : "Left Shift";
  if (key === "RightShift") return macOS ? "Right ⇧" : "Right Shift";
  if (key === "DoubleShift") return macOS ? "⇧ + ⇧" : "Double Shift";
  if (key === "Plus" && macOS) return "+";
  if (key === "MouseBack") return "Mouse Back";
  if (key === "MouseForward") return "Mouse Forward";
  if (key === "Space") return "Space";
  if (key === "Up") return "↑";
  if (key === "Down") return "↓";
  if (key === "Left") return "←";
  if (key === "Right") return "→";
  return key;
}

function formatAriaKeyName(key: string): string {
  if (key === "Up") return "ArrowUp";
  if (key === "Down") return "ArrowDown";
  if (key === "Left") return "ArrowLeft";
  if (key === "Right") return "ArrowRight";
  return key;
}

function isSequencePrefix(left: string[], right: string[]): boolean {
  if (left.length === right.length) return false;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.every((part, index) => part === longer[index]);
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
