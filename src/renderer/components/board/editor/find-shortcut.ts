import {
  matchesKeyboardEventToAccelerator,
  type KeyboardShortcutEventLike,
  type RuntimePlatform,
} from "../../../../shared/command-keybindings";

/** Local Find owns only its exact chord; modified F chords remain available to the shell. */
export function matchesNfmFindShortcut(
  event: KeyboardShortcutEventLike,
  platform: RuntimePlatform,
): boolean {
  return matchesKeyboardEventToAccelerator(event, "CmdOrCtrl+F", platform);
}
