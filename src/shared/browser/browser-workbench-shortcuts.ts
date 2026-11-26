import type { KeyboardShortcutEventLike } from "../command-keybindings";
import type { RuntimePlatform } from "../runtime-platform";

interface GuestShortcutBinding {
  readonly commandId: string;
  readonly bindings: string[];
}

export interface BrowserGuestShortcutBindings {
  readonly platform: RuntimePlatform;
  readonly reserved: readonly GuestShortcutBinding[];
  readonly pageFirst: readonly GuestShortcutBinding[];
}

/** Leave typing and Ctrl+Alt to the DOM, where Chromium exposes editability and AltGraph. */
export function guestShortcutUsesNativeIngress(event: KeyboardShortcutEventLike): boolean {
  return (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.altKey);
}

const EDIT_KEYS = new Set([
  "a",
  "c",
  "v",
  "x",
  "y",
  "z",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "delete",
  "end",
  "home",
]);

/** A guest keeps its native editing shortcuts, including copy on a noneditable selection. */
export function isBrowserEditingChord(event: KeyboardShortcutEventLike): boolean {
  return (
    (event.metaKey || event.ctrlKey) && !event.altKey && EDIT_KEYS.has(event.key.toLowerCase())
  );
}
