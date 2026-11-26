import {
  FIND_MATCH_SHORTCUT_POLICY,
  FIND_MATCH_SHORTCUTS,
  matchesKeyboardEventToAccelerator,
} from "../../../shared/command-keybindings";
import type { RuntimePlatform } from "../../../shared/runtime-platform";
import { keyboardActionMayRun, type KeyboardActionEventLike } from "@/lib/keyboard-action-runtime";

type FindNavigation = (direction: "next" | "previous") => boolean;
let navigate: FindNavigation | null = null;

/** One mounted Find supplies the app keyboard router's navigation capability. */
export function registerContentSearchNavigation(handler: FindNavigation): () => void {
  navigate = handler;
  return () => {
    if (navigate === handler) navigate = null;
  };
}

export function navigateContentSearch(direction: "next" | "previous"): boolean {
  return navigate?.(direction) ?? false;
}

/** Open Find claims its navigation chords before the workbench opens another surface. */
export function handleContentSearchNavigationShortcut(
  event: KeyboardActionEventLike,
  platform: RuntimePlatform,
): boolean {
  for (const direction of ["next", "previous"] as const) {
    if (!matchesKeyboardEventToAccelerator(event, FIND_MATCH_SHORTCUTS[direction], platform))
      continue;
    return (
      keyboardActionMayRun(event, FIND_MATCH_SHORTCUT_POLICY, platform) &&
      navigateContentSearch(direction)
    );
  }
  return false;
}
