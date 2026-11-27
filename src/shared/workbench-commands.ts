import type { BrowserSidebarTabIdentity } from "./browser-sidebar";
import type { InboxScope } from "./inbox";
import type { CommandId } from "./command-keybindings";

export const TOGGLE_BOTTOM_PANEL_COMMAND_ID = "toggleBottomPanel";
export const TOGGLE_FULL_VIEW_COMMAND_ID = "toggleFullView";
export const CAPTURE_TO_INBOX_COMMAND_ID = "captureToInbox";
export const EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL = "execute-workbench-command";
/** Workbench Find match navigation has fixed chords rather than registry entries. */
export const FIND_NEXT_COMMAND_ID = "findNext";
export const FIND_PREVIOUS_COMMAND_ID = "findPrevious";

/** Commands another process can ask the Workbench to run, such as the menu or a Browser page. */
export type WorkbenchCommandId =
  | Extract<
      CommandId,
      | "openInbox"
      | "settings"
      | "focusBrowserAddressBar"
      | "newThread"
      | "openBrowserTab"
      | "closeTab"
      | "openCommandMenu"
      | "searchPages"
      | "findInThread"
      | "nextThread"
      | "previousThread"
      | "nextThreadNeedingAttention"
      | typeof TOGGLE_BOTTOM_PANEL_COMMAND_ID
      | typeof TOGGLE_FULL_VIEW_COMMAND_ID
      | typeof CAPTURE_TO_INBOX_COMMAND_ID
    >
  | typeof FIND_NEXT_COMMAND_ID
  | typeof FIND_PREVIOUS_COMMAND_ID;
export type WorkbenchCommandSource = "keyboard_shortcut" | "menu" | "command_palette" | "toolbar";

export interface WorkbenchCommandInvocation {
  commandId: WorkbenchCommandId;
  source: WorkbenchCommandSource;
  /** The Browser page that had focus, so Browser commands act on its own group. */
  browserTab?: BrowserSidebarTabIdentity;
  inboxScope?: InboxScope;
}

export interface WorkbenchCommandRequest extends WorkbenchCommandInvocation {
  tick: number;
}
