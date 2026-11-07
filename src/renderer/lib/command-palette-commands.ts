import type { CommandKeymapState } from "../../shared/command-keybindings";
import {
  createCommandKeymapState,
  formatCommandShortcutLabel,
} from "../../shared/command-keybindings";
import {
  NAVIGATE_BACK_COMMAND_ID,
  NAVIGATE_FORWARD_COMMAND_ID,
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../shared/window-navigation";
import {
  CAPTURE_TO_INBOX_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  TOGGLE_FULL_VIEW_COMMAND_ID,
} from "../../shared/workbench-commands";
import type { CommandPaletteCommand, CommandPaletteCommandGroup } from "./command-palette";
import type { ChatReminderPresetId } from "./chat-reminder";
import type { WorkbenchPanelActionKind } from "./workbench-panel-capabilities";
import { formatToggleFullViewShortcutLabel } from "./workbench-command-shortcuts";

export const OPEN_DB_VIEW_TAB_COMMAND_ID = "openDbViewTab";

/** A reminder preset is resolved to its instant when the command runs, never when it is listed. */
export const REMIND_THREAD_COMMAND_IDS = {
  "in-1-hour": "remindThreadInOneHour",
  "in-3-hours": "remindThreadInThreeHours",
  "next-morning": "remindThreadInTheMorning",
  "next-week": "remindThreadNextWeek",
} as const satisfies Record<ChatReminderPresetId, string>;

type RemindThreadCommandId = (typeof REMIND_THREAD_COMMAND_IDS)[ChatReminderPresetId];

export function isRemindThreadCommandId(id: string): id is RemindThreadCommandId {
  return Object.values(REMIND_THREAD_COMMAND_IDS).some((commandId) => commandId === id);
}

const REMIND_THREAD_COMMAND_TITLES: Readonly<Record<ChatReminderPresetId, string>> = {
  "in-1-hour": "Remind me in 1 hour",
  "in-3-hours": "Remind me in 3 hours",
  "next-morning": "Remind me in the morning",
  "next-week": "Remind me next week",
};

export type CommandPaletteShellCommandId =
  | typeof NAVIGATE_BACK_COMMAND_ID
  | typeof NAVIGATE_FORWARD_COMMAND_ID
  | "newThread"
  | "newThreadInProject"
  | "openFolder"
  | typeof CAPTURE_TO_INBOX_COMMAND_ID
  | "newPage"
  | typeof RENAME_THREAD_COMMAND_ID
  | "archiveThread"
  | "copyConversationMarkdown"
  | "toggleThreadPin"
  | "toggleThreadUnread"
  | RemindThreadCommandId
  | "clearThreadReminder"
  | "openThreadInNewWindow"
  | typeof TOGGLE_SIDEBAR_COMMAND_ID
  | "toggleSidePanel"
  | typeof TOGGLE_BOTTOM_PANEL_COMMAND_ID
  | typeof TOGGLE_FULL_VIEW_COMMAND_ID
  | "toggleFileTreePanel"
  | "toggleGitBlame"
  | "openBrowserTab"
  | "openReviewTab"
  | "toggleTerminal"
  | typeof OPEN_DB_VIEW_TAB_COMMAND_ID
  | "openSideChat"
  | "findInThread"
  | "forceReloadSkills"
  | "manageTasks"
  | "openInbox"
  | "openLibraryFiles"
  | "openProcessManager"
  | "settings"
  | "showKeyboardShortcuts";

export type CommandPaletteShellCommandHandlers = Record<CommandPaletteShellCommandId, () => void>;

export interface CommandPaletteShellCommandContext {
  canGoBack: boolean;
  canSearchFiles?: boolean;
  canSearchText?: boolean;
  canReloadSkills?: boolean;
  canGoForward: boolean;
  canStartNewChat: boolean;
  canStartNewChatInProject: boolean;
  /** Whether the current place has somewhere for a new Page to live. */
  canCreatePage: boolean;
  hasActiveSession: boolean;
  activeSessionPinned: boolean;
  activeSessionUnread: boolean;
  /** Whether the active chat has a pending reminder. */
  activeSessionReminded: boolean;
  hasAttachedThread: boolean;
  canExportConversationMarkdown: boolean;
  panelActionAvailability: Record<WorkbenchPanelActionKind, boolean>;
  canOpenSessionInNewWindow: boolean;
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
  /** Whether the Files editor shows the active line's author and commit. */
  gitBlameEnabled?: boolean;
}

function fallbackCommandKeymapState(isMac: boolean): CommandKeymapState {
  return createCommandKeymapState({}, isMac ? "macOS" : "windows");
}

export function isCommandPaletteShellCommandId(id: string): id is CommandPaletteShellCommandId {
  return (
    id === NAVIGATE_BACK_COMMAND_ID ||
    id === NAVIGATE_FORWARD_COMMAND_ID ||
    id === "newThread" ||
    id === "newThreadInProject" ||
    id === "openFolder" ||
    id === CAPTURE_TO_INBOX_COMMAND_ID ||
    id === "newPage" ||
    id === RENAME_THREAD_COMMAND_ID ||
    id === "archiveThread" ||
    id === "copyConversationMarkdown" ||
    id === "toggleThreadPin" ||
    id === "toggleThreadUnread" ||
    isRemindThreadCommandId(id) ||
    id === "clearThreadReminder" ||
    id === "openThreadInNewWindow" ||
    id === TOGGLE_SIDEBAR_COMMAND_ID ||
    id === "toggleSidePanel" ||
    id === TOGGLE_BOTTOM_PANEL_COMMAND_ID ||
    id === TOGGLE_FULL_VIEW_COMMAND_ID ||
    id === "toggleFileTreePanel" ||
    id === "toggleGitBlame" ||
    id === "openBrowserTab" ||
    id === "openReviewTab" ||
    id === "toggleTerminal" ||
    id === OPEN_DB_VIEW_TAB_COMMAND_ID ||
    id === "openSideChat" ||
    id === "findInThread" ||
    id === "forceReloadSkills" ||
    id === "manageTasks" ||
    id === "openInbox" ||
    id === "openLibraryFiles" ||
    id === "openProcessManager" ||
    id === "settings" ||
    id === "showKeyboardShortcuts"
  );
}

export function executeCommandPaletteShellCommand(
  commandId: CommandPaletteShellCommandId,
  handlers: CommandPaletteShellCommandHandlers,
): void {
  handlers[commandId]();
}

export function buildCommandPaletteCommands(
  context: CommandPaletteShellCommandContext,
): CommandPaletteCommand[] {
  const shortcutState = context.commandKeymapState ?? fallbackCommandKeymapState(context.isMac);
  const shortcutLabel = (commandId: string, fallback?: string): string | undefined =>
    formatCommandShortcutLabel(shortcutState, commandId, fallback);
  const sessionCommandDisabled = !context.hasActiveSession;
  const panelCommandDisabled = !context.hasActiveSession;
  const command = (
    id: CommandPaletteShellCommandId | "searchFiles" | "searchText" | "searchChats" | "searchPages",
    group: CommandPaletteCommandGroup,
    title: string,
    subtitle: string,
    keywords: string[],
    priority: number,
    options: {
      shortcut?: string;
      active?: boolean;
      disabled?: boolean;
      disabledReason?: string;
    } = {},
  ): CommandPaletteCommand => ({
    kind: "command",
    id,
    group,
    title,
    subtitle,
    keywords,
    priority,
    shortcut: options.shortcut,
    active: options.active,
    disabled: options.disabled,
    disabledReason: options.disabledReason,
  });

  return [
    command(
      "searchFiles",
      "Suggested",
      "Search files",
      "Search workspace files",
      ["search", "files", "workspace"],
      1188,
      {
        disabled: context.canSearchFiles === false,
        disabledReason: context.canSearchFiles === false ? "Choose a workspace folder" : undefined,
      },
    ),
    command(
      "searchText",
      "Suggested",
      "Search text in files",
      "Search workspace file contents",
      ["search", "text", "contents", "files", "workspace"],
      1187,
      { disabled: context.canSearchText === false },
    ),
    command(
      "searchChats",
      "Suggested",
      "Search chats",
      "Search chats by title, project, path, and content",
      ["search", "chat", "thread"],
      1200,
      {
        shortcut: shortcutLabel("searchChats", "CmdOrCtrl+G"),
      },
    ),
    command(
      "searchPages",
      "Suggested",
      "Search pages",
      "Search pages with Nodex page filters",
      ["search", "page", "board", "task"],
      1190,
      {
        shortcut: shortcutLabel("searchPages", "CmdOrCtrl+P"),
      },
    ),
    command(
      CAPTURE_TO_INBOX_COMMAND_ID,
      "Suggested",
      "Capture to Inbox",
      "Write a thought, task, or question to the Inbox where you are",
      ["capture", "inbox", "note", "thought", "task", "todo", "message", "new"],
      1185,
      { shortcut: shortcutLabel(CAPTURE_TO_INBOX_COMMAND_ID, "C") },
    ),
    command(
      "newPage",
      "Suggested",
      "New page",
      "Create a Page where this work lives and open it",
      ["new", "create", "page", "document", "note"],
      1184,
      {
        disabled: !context.canCreatePage,
        disabledReason: context.canCreatePage ? undefined : "Open a chat, Project, or Space",
      },
    ),
    command(
      "openLibraryFiles",
      "Suggested",
      "Library files",
      "Browse shared Files, versions, usage, and Trash",
      ["search", "file", "library", "asset", "trash"],
      1180,
      { shortcut: shortcutLabel("openLibraryFiles") },
    ),
    command(
      "newThread",
      "Chat",
      "New chat",
      "Start a new chat in the current context",
      ["new", "chat", "thread", "session"],
      1120,
      {
        shortcut: shortcutLabel("newThread", "CmdOrCtrl+N"),
        disabled: !context.canStartNewChat,
      },
    ),
    command(
      "openThreadInNewWindow",
      "Chat",
      "Open chat in new window",
      "Open the active chat in another Nodex window",
      ["open", "chat", "thread", "session", "window"],
      1100,
      {
        shortcut: shortcutLabel("openThreadInNewWindow"),
        disabled: sessionCommandDisabled || !context.canOpenSessionInNewWindow,
      },
    ),
    command(
      RENAME_THREAD_COMMAND_ID,
      "Chat",
      "Rename chat",
      "Rename the active chat",
      ["rename", "chat", "thread", "session", "title"],
      1090,
      {
        shortcut: shortcutLabel("renameThread", "CmdOrCtrl+Alt+R"),
        disabled: sessionCommandDisabled,
      },
    ),
    command(
      "archiveThread",
      "Chat",
      "Archive chat",
      "Archive the active chat",
      ["archive", "chat", "thread", "session"],
      1080,
      {
        shortcut: shortcutLabel("archiveThread", "CmdOrCtrl+Shift+A"),
        disabled: sessionCommandDisabled,
      },
    ),
    ...(context.canExportConversationMarkdown
      ? [
          command(
            "copyConversationMarkdown",
            "Chat",
            "Copy as Markdown",
            "Copy the complete active chat as Markdown",
            ["copy", "markdown", "chat", "thread", "transcript"],
            1075,
            { shortcut: shortcutLabel("copyConversationMarkdown") },
          ),
        ]
      : []),
    command(
      "toggleThreadPin",
      "Chat",
      context.activeSessionPinned ? "Unpin chat" : "Pin chat",
      context.activeSessionPinned ? "Remove the active chat from pinned" : "Pin the active chat",
      ["pin", "unpin", "chat", "thread", "session"],
      1070,
      {
        shortcut: shortcutLabel("toggleThreadPin", "CmdOrCtrl+Alt+P"),
        active: context.activeSessionPinned,
        disabled: sessionCommandDisabled,
      },
    ),
    command(
      "toggleThreadUnread",
      "Chat",
      context.activeSessionUnread ? "Mark chat as read" : "Mark chat as unread",
      context.activeSessionUnread
        ? "Clear the active chat's unread dot"
        : "Keep the active chat's unread dot to come back to it",
      ["unread", "read", "later", "chat", "thread", "session"],
      1068,
      {
        shortcut: shortcutLabel("toggleThreadUnread", "CmdOrCtrl+Shift+U"),
        disabled: sessionCommandDisabled,
      },
    ),
    ...(
      Object.entries(REMIND_THREAD_COMMAND_IDS) as [ChatReminderPresetId, RemindThreadCommandId][]
    ).map(([presetId, commandId], index) =>
      command(
        commandId,
        "Chat",
        REMIND_THREAD_COMMAND_TITLES[presetId],
        "Make the active chat unread again then",
        ["remind", "reminder", "later", "snooze", "unread", "chat"],
        1066 - index,
        { disabled: sessionCommandDisabled },
      ),
    ),
    ...(context.activeSessionReminded
      ? [
          command(
            "clearThreadReminder",
            "Chat",
            "Cancel reminder",
            "Stop the active chat's reminder",
            ["remind", "reminder", "cancel", "chat"],
            1061,
          ),
        ]
      : []),
    command(
      "openSideChat",
      "Chat",
      "Open side chat",
      "Start a side chat for the active chat",
      ["side", "chat", "thread", "panel", "tab"],
      1060,
      {
        shortcut: shortcutLabel("openSideChat", "CmdOrCtrl+Alt+S"),
        disabled: !context.panelActionAvailability.side_chat,
      },
    ),
    command(
      NAVIGATE_BACK_COMMAND_ID,
      "Navigation",
      "Back",
      "Return to the previous workbench context",
      ["back", "previous", "history", "navigation"],
      1020,
      {
        shortcut: shortcutLabel("navigateBack", "CmdOrCtrl+["),
        disabled: !context.canGoBack,
      },
    ),
    command(
      NAVIGATE_FORWARD_COMMAND_ID,
      "Navigation",
      "Forward",
      "Move to the next workbench context",
      ["forward", "next", "history", "navigation"],
      1010,
      {
        shortcut: shortcutLabel("navigateForward", "CmdOrCtrl+]"),
        disabled: !context.canGoForward,
      },
    ),
    command(
      "findInThread",
      "Navigation",
      "Find",
      "Find in the current chat, review, or browser page",
      ["find", "search", "chat", "review", "browser"],
      1000,
      {
        shortcut: shortcutLabel("findInThread", "CmdOrCtrl+F"),
        disabled: !context.hasActiveSession,
      },
    ),
    command(
      TOGGLE_SIDEBAR_COMMAND_ID,
      "Panels",
      "Toggle sidebar",
      "Show or hide the project sidebar",
      ["sidebar", "project", "shell"],
      940,
      {
        shortcut: shortcutLabel("toggleSidebar", "CmdOrCtrl+B"),
      },
    ),
    command(
      "toggleSidePanel",
      "Panels",
      "Toggle side panel",
      "Show or hide the right panel",
      ["side", "right", "panel", "shell"],
      930,
      {
        shortcut: shortcutLabel("toggleSidePanel", "CmdOrCtrl+Alt+B"),
        disabled: panelCommandDisabled,
      },
    ),
    command(
      TOGGLE_BOTTOM_PANEL_COMMAND_ID,
      "Panels",
      "Toggle bottom panel",
      "Show or hide the bottom panel",
      ["bottom", "panel", "shell"],
      920,
      {
        shortcut: shortcutLabel(TOGGLE_BOTTOM_PANEL_COMMAND_ID, "CmdOrCtrl+J"),
        disabled: panelCommandDisabled,
      },
    ),
    command(
      TOGGLE_FULL_VIEW_COMMAND_ID,
      "Panels",
      "Toggle full view",
      "Expand the content panel to fill the window, or return to split view",
      ["full", "view", "expand", "content", "panel", "split"],
      915,
      {
        shortcut: formatToggleFullViewShortcutLabel(shortcutState),
        disabled: panelCommandDisabled,
      },
    ),
    command(
      "toggleFileTreePanel",
      "Panels",
      "Toggle file tree",
      "Open project files in the active panel",
      ["files", "file", "tree", "panel", "tab"],
      910,
      {
        shortcut: shortcutLabel("toggleFileTreePanel", "CmdOrCtrl+Shift+E"),
        disabled: !context.panelActionAvailability.files,
      },
    ),
    command(
      "toggleGitBlame",
      "Panels",
      context.gitBlameEnabled ? "Disable Git blame" : "Enable Git blame",
      context.gitBlameEnabled
        ? "Hide the author and commit for the active editor line"
        : "Show the author and commit for the active editor line",
      ["git", "blame", "author", "commit", "line", "editor"],
      905,
    ),
    command(
      "openBrowserTab",
      "Panels",
      "Open browser tab",
      "Open a Browser tab in the active panel",
      ["browser", "web", "panel", "tab"],
      900,
      {
        shortcut: shortcutLabel("openBrowserTab", "CmdOrCtrl+T"),
        disabled: !context.panelActionAvailability.browser,
      },
    ),
    command(
      "openReviewTab",
      "Panels",
      "Open review tab",
      "Open or focus code review in the right panel",
      ["review", "diff", "changes", "git", "panel", "tab"],
      880,
      {
        shortcut: shortcutLabel("openReviewTab", "Ctrl+Shift+G"),
        disabled: !context.panelActionAvailability.review,
      },
    ),
    command(
      "toggleTerminal",
      "Panels",
      "Open terminal",
      "Focus or create a terminal tab",
      ["terminal", "shell", "panel", "tab"],
      870,
      {
        shortcut: shortcutLabel("toggleTerminal", "Ctrl+`"),
        disabled: !context.panelActionAvailability.terminal,
      },
    ),
    command(
      OPEN_DB_VIEW_TAB_COMMAND_ID,
      "Panels",
      "Open DB View tab",
      "Open the active project database in the right panel",
      ["db", "database", "view", "board", "board", "panel", "tab"],
      860,
      {
        disabled: !context.panelActionAvailability.db_view,
      },
    ),
    command(
      "newThreadInProject",
      "Project",
      "New chat in project",
      "Start a new chat in the active project",
      ["new", "chat", "project"],
      830,
      {
        disabled: !context.canStartNewChatInProject,
      },
    ),
    command(
      "openFolder",
      "Project",
      "Open folder",
      "Open a local folder",
      ["open", "folder", "project"],
      810,
      { shortcut: shortcutLabel("openFolder", "CmdOrCtrl+O") },
    ),
    command(
      "settings",
      "Configure",
      "Settings",
      "Adjust app, editor, and worktree preferences",
      ["settings", "preferences", "config"],
      740,
      {
        shortcut: shortcutLabel("settings", "CmdOrCtrl+,"),
      },
    ),
    command(
      "showKeyboardShortcuts",
      "Configure",
      "Keyboard shortcuts",
      "Show available shortcuts and open customization",
      ["keyboard", "shortcuts", "hotkeys", "settings"],
      710,
      {
        shortcut: shortcutLabel("showKeyboardShortcuts", "CmdOrCtrl+Shift+/"),
      },
    ),
    ...(context.canReloadSkills === true
      ? [
          command(
            "forceReloadSkills",
            "Skills",
            "Force reload skills",
            "Reload installed skills",
            ["skills", "reload"],
            650,
          ),
        ]
      : []),
    command(
      "openInbox",
      "App",
      "Open Inbox",
      "Capture a thought and review dispatch suggestions",
      ["inbox", "capture", "message", "note", "todo", "dispatch"],
      640,
      { shortcut: shortcutLabel("openInbox", "CmdOrCtrl+Shift+D") },
    ),
    command(
      "manageTasks",
      "App",
      "Manage automations",
      "Open scheduled task management",
      ["automation", "tasks", "manage"],
      630,
    ),
    command(
      "openProcessManager",
      "App",
      "Process Manager",
      "Open the process manager",
      ["process", "manager"],
      620,
      {
        shortcut: shortcutLabel("openProcessManager", "Ctrl+Alt+M"),
      },
    ),
  ];
}
