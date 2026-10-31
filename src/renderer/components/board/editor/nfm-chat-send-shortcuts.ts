import {
  matchesKeyboardEventToCommand,
  PAGE_EDITOR_ADD_TO_COMPOSER_COMMAND_ID,
  PAGE_EDITOR_SEND_TO_CHAT_COMMAND_ID,
  type CommandKeymapState,
  type KeyboardShortcutEventLike,
} from "../../../../shared/command-keybindings";

export type NfmChatSendShortcut = "send" | "add-to-composer";

interface ShortcutKeyEvent extends KeyboardShortcutEventLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** Editor-local chat commands use the same live bindings as Settings and their labels. */
export function resolveNfmChatSendShortcut(
  event: ShortcutKeyEvent,
  state: CommandKeymapState,
): NfmChatSendShortcut | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (matchesKeyboardEventToCommand(event, state, PAGE_EDITOR_SEND_TO_CHAT_COMMAND_ID))
    return "send";
  if (matchesKeyboardEventToCommand(event, state, PAGE_EDITOR_ADD_TO_COMPOSER_COMMAND_ID))
    return "add-to-composer";
  return null;
}
