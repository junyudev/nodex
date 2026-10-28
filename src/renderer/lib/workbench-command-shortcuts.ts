import {
  createCommandKeymapState,
  formatCommandShortcutLabel,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { TOGGLE_FULL_VIEW_COMMAND_ID } from "../../shared/workbench-commands";
import { resolveCodexRendererCommandPlatform } from "./codex-window-runtime";

/** Full-view tooltips and menus share the current binding's platform label. */
export function formatToggleFullViewShortcutLabel(
  state?: CommandKeymapState | null,
): string | undefined {
  return formatCommandShortcutLabel(
    state ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform()),
    TOGGLE_FULL_VIEW_COMMAND_ID,
  );
}
