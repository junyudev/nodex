import {
  matchesKeyboardActionCommand,
  type KeyboardActionEventLike,
} from "@/lib/keyboard-action-runtime";
import type { CommandKeymapState } from "../../../../shared/command-keybindings";

/** Page Find uses the same binding as the shell and preserves the Page-specific search seed. */
export function matchesNfmFindShortcut(
  event: KeyboardActionEventLike,
  keymap: CommandKeymapState,
): boolean {
  return matchesKeyboardActionCommand(event, keymap, "findInThread");
}
