import {
  matchesKeyboardEventToAccelerator,
  type KeyboardShortcutEventLike,
} from "../../../../shared/command-keybindings";
import type { RuntimePlatform } from "../../../../shared/runtime-platform";

/** Local Find owns only its exact chord; modified F chords remain available to the shell. */
export function matchesNfmFindShortcut(
  event: KeyboardShortcutEventLike,
  platform: RuntimePlatform,
): boolean {
  return matchesKeyboardEventToAccelerator(event, "CmdOrCtrl+F", platform);
}
