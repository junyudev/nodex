/** Page editor shortcuts that hand the selection, or the Prompt at the caret, to a chat. */
export const NFM_SEND_TO_CHAT_SHORTCUT_LABEL = "⌘⇧↵";
export const NFM_ADD_TO_COMPOSER_SHORTCUT_LABEL = "⌥⌘↵";

export type NfmChatSendShortcut = "send" | "add-to-composer";

interface ShortcutKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

/** `Mod+Shift+Enter` sends; `Mod+Alt+Enter` adds to the composer. Other chords are not ours. */
export function resolveNfmChatSendShortcut(
  event: ShortcutKeyEvent,
  isMacPlatform: boolean,
): NfmChatSendShortcut | null {
  if (event.key !== "Enter" || event.isComposing) return null;
  const mod = isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  if (event.shiftKey && !event.altKey) return "send";
  if (event.altKey && !event.shiftKey) return "add-to-composer";
  return null;
}
