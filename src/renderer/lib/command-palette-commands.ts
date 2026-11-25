import { getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { isRemoteSpace } from "./renderer-space";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import {
  commandDescriptionMessage,
  commandTitleMessage,
  createCommandKeymapState,
  getCommandEntry,
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
import type { ChatSnoozePresetId } from "./chat-snooze";
import type { WorkbenchPanelActionKind } from "./workbench-panel-capabilities";
import { formatToggleFullViewShortcutLabel } from "./workbench-command-shortcuts";

export const OPEN_DB_VIEW_TAB_COMMAND_ID = "openDbViewTab";

/** A snooze preset is resolved to its instant when the command runs, never when it is listed. */
export const SNOOZE_THREAD_COMMAND_IDS = {
  "in-1-hour": "snoozeThreadInOneHour",
  "in-3-hours": "snoozeThreadInThreeHours",
  "next-morning": "snoozeThreadInTheMorning",
  "next-week": "snoozeThreadNextWeek",
} as const satisfies Record<ChatSnoozePresetId, string>;

type SnoozeThreadCommandId = (typeof SNOOZE_THREAD_COMMAND_IDS)[ChatSnoozePresetId];

export function isSnoozeThreadCommandId(id: string): id is SnoozeThreadCommandId {
  return Object.values(SNOOZE_THREAD_COMMAND_IDS).some((commandId) => commandId === id);
}

/** The word every snooze command starts with, so a palette opened on it lists only those. */
export const snoozeCommandQuery = () =>
  getIntl().formatMessage({
    id: "lib.commandPaletteCommands.snoozeQuery",
    defaultMessage: "Snooze",
  });

const SNOOZE_THREAD_COMMAND_TITLES: Readonly<Record<ChatSnoozePresetId, MessageDescriptor>> = {
  "in-1-hour": {
    id: "lib.commandPaletteCommands.snoozeOneHour",
    defaultMessage: "Snooze for 1 hour",
  },
  "in-3-hours": {
    id: "lib.commandPaletteCommands.snoozeThreeHours",
    defaultMessage: "Snooze for 3 hours",
  },
  "next-morning": {
    id: "lib.commandPaletteCommands.snoozeMorning",
    defaultMessage: "Snooze until the morning",
  },
  "next-week": {
    id: "lib.commandPaletteCommands.snoozeNextWeek",
    defaultMessage: "Snooze until next week",
  },
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
  | "settleThread"
  | SnoozeThreadCommandId
  | "wakeThread"
  | "openThreadInNewWindow"
  | typeof TOGGLE_SIDEBAR_COMMAND_ID
  | "toggleSidePanel"
  | typeof TOGGLE_BOTTOM_PANEL_COMMAND_ID
  | typeof TOGGLE_FULL_VIEW_COMMAND_ID
  | "toggleFileTreePanel"
  | "toggleGitBlame"
  | "openBrowserTab"
  | "openReviewTab"
  | "openAgentsTab"
  | "toggleTerminal"
  | typeof OPEN_DB_VIEW_TAB_COMMAND_ID
  | "openSideChat"
  | "findInThread"
  | "forceReloadSkills"
  | "manageTasks"
  | "openInbox"
  | "openLibraryFiles"
  | "openProcessManager"
  | "runSetupAgain"
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
  activeSessionSettled: boolean;
  /** False when Core leaves renaming and archiving the active chat to its owner or a Space Owner. */
  activeSessionCanManage: boolean;
  /** Whether the active chat has a pending snooze. */
  activeSessionSnoozed: boolean;
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
    id === "settleThread" ||
    isSnoozeThreadCommandId(id) ||
    id === "wakeThread" ||
    id === "openThreadInNewWindow" ||
    id === TOGGLE_SIDEBAR_COMMAND_ID ||
    id === "toggleSidePanel" ||
    id === TOGGLE_BOTTOM_PANEL_COMMAND_ID ||
    id === TOGGLE_FULL_VIEW_COMMAND_ID ||
    id === "toggleFileTreePanel" ||
    id === "toggleGitBlame" ||
    id === "openBrowserTab" ||
    id === "openReviewTab" ||
    id === "openAgentsTab" ||
    id === "toggleTerminal" ||
    id === OPEN_DB_VIEW_TAB_COMMAND_ID ||
    id === "openSideChat" ||
    id === "findInThread" ||
    id === "forceReloadSkills" ||
    id === "manageTasks" ||
    id === "openInbox" ||
    id === "openLibraryFiles" ||
    id === "openProcessManager" ||
    id === "runSetupAgain" ||
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
  intl: IntlShape = getIntl(),
): CommandPaletteCommand[] {
  const shortcutState = context.commandKeymapState ?? fallbackCommandKeymapState(context.isMac);
  const shortcutLabel = (commandId: string, fallback?: string): string | undefined =>
    formatCommandShortcutLabel(shortcutState, commandId, fallback);
  const sessionCommandDisabled = !context.hasActiveSession;
  const panelCommandDisabled = !context.hasActiveSession;
  const command = (
    id: CommandPaletteShellCommandId | "searchFiles" | "searchText" | "searchChats" | "searchPages",
    group: CommandPaletteCommandGroup,
    title: MessageDescriptor,
    subtitle: MessageDescriptor,
    keywords: string[],
    priority: number,
    options: {
      shortcut?: string;
      active?: boolean;
      disabled?: boolean;
      disabledReason?: string;
    } = {},
  ): CommandPaletteCommand => {
    const entry = getCommandEntry(shortcutState, id);
    return {
      kind: "command",
      id,
      group,
      title: intl.formatMessage(
        entry && entry.title === title.defaultMessage ? commandTitleMessage(entry) : title,
      ),
      subtitle: intl.formatMessage(
        entry && entry.description === subtitle.defaultMessage
          ? commandDescriptionMessage(entry)
          : subtitle,
      ),
      keywords: [
        ...keywords,
        ...new Set(
          [title.defaultMessage, subtitle.defaultMessage, entry?.title].filter(
            (label): label is string => typeof label === "string" && !intl.locale.startsWith("en"),
          ),
        ),
      ],
      priority,
      shortcut: options.shortcut,
      active: options.active,
      disabled: options.disabled,
      disabledReason: options.disabledReason,
    };
  };

  return [
    command(
      "searchFiles",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.searchFiles.title",
        defaultMessage: "Search files",
      },
      {
        id: "lib.commandPaletteCommands.searchFiles.description",
        defaultMessage: "Search workspace files",
      },
      ["search", "files", "workspace"],
      1188,
      {
        disabled: context.canSearchFiles === false,
        disabledReason:
          context.canSearchFiles === false
            ? intl.formatMessage({
                id: "lib.commandPaletteCommands.chooseWorkspaceFolder",
                defaultMessage: "Choose a workspace folder",
              })
            : undefined,
      },
    ),
    command(
      "searchText",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.searchText.title",
        defaultMessage: "Search text in files",
      },
      {
        id: "lib.commandPaletteCommands.searchText.description",
        defaultMessage: "Search workspace file contents",
      },
      ["search", "text", "contents", "files", "workspace"],
      1187,
      { disabled: context.canSearchText === false },
    ),
    command(
      "searchChats",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.searchChats.title",
        defaultMessage: "Search chats",
      },
      {
        id: "lib.commandPaletteCommands.searchChats.description",
        defaultMessage: "Search chats by title, project, path, and content",
      },
      ["search", "chat", "thread"],
      1200,
      {
        shortcut: shortcutLabel("searchChats"),
      },
    ),
    command(
      "searchPages",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.searchPages.title",
        defaultMessage: "Search pages",
      },
      {
        id: "lib.commandPaletteCommands.searchPages.description",
        defaultMessage: "Search Pages across the Library",
      },
      ["search", "page", "board", "task"],
      1190,
      {
        shortcut: shortcutLabel("searchPages", "CmdOrCtrl+P"),
      },
    ),
    command(
      CAPTURE_TO_INBOX_COMMAND_ID,
      "Suggested",
      {
        id: "lib.commandPaletteCommands.capture.title",
        defaultMessage: "Capture to Inbox",
      },
      {
        id: "lib.commandPaletteCommands.capture.description",
        defaultMessage: "Write a thought, task, or question to the Inbox where you are",
      },
      ["capture", "inbox", "note", "thought", "task", "todo", "message", "new"],
      1185,
      { shortcut: shortcutLabel(CAPTURE_TO_INBOX_COMMAND_ID, "C") },
    ),
    command(
      "newPage",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.createPage.title",
        defaultMessage: "New page",
      },
      {
        id: "lib.commandPaletteCommands.createPage.description",
        defaultMessage: "Create a Page where this work lives and open it",
      },
      ["new", "create", "page", "document", "note"],
      1184,
      {
        disabled: !context.canCreatePage,
        disabledReason: context.canCreatePage
          ? undefined
          : intl.formatMessage({
              id: "lib.commandPaletteCommands.openContextFirst",
              defaultMessage: "Open a chat, Project, or Space",
            }),
      },
    ),
    command(
      "openLibraryFiles",
      "Suggested",
      {
        id: "lib.commandPaletteCommands.library.title",
        defaultMessage: "Library files",
      },
      {
        id: "lib.commandPaletteCommands.library.description",
        defaultMessage: "Browse shared Files, versions, usage, and Trash",
      },
      ["search", "file", "library", "asset", "trash"],
      1180,
      { shortcut: shortcutLabel("openLibraryFiles") },
    ),
    command(
      "newThread",
      "Chat",
      {
        id: "lib.commandPaletteCommands.newChat.title",
        defaultMessage: "New chat",
      },
      {
        id: "lib.commandPaletteCommands.newChat.description",
        defaultMessage: "Start a new chat in the current context",
      },
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
      {
        id: "lib.commandPaletteCommands.newWindow.title",
        defaultMessage: "Open chat in new window",
      },
      {
        id: "lib.commandPaletteCommands.newWindow.description",
        defaultMessage: "Open the active chat in another Nodex window",
      },
      ["open", "chat", "thread", "session", "window"],
      1100,
      {
        shortcut: shortcutLabel("openThreadInNewWindow"),
        disabled: sessionCommandDisabled || !context.canOpenSessionInNewWindow,
      },
    ),
    ...(context.activeSessionCanManage
      ? [
          command(
            RENAME_THREAD_COMMAND_ID,
            "Chat",
            {
              id: "lib.commandPaletteCommands.rename.title",
              defaultMessage: "Rename chat",
            },
            {
              id: "lib.commandPaletteCommands.rename.description",
              defaultMessage: "Rename the active chat",
            },
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
            {
              id: "lib.commandPaletteCommands.archive.title",
              defaultMessage: "Archive chat",
            },
            {
              id: "lib.commandPaletteCommands.archive.description",
              defaultMessage: "Archive the active chat",
            },
            ["archive", "chat", "thread", "session"],
            1080,
            {
              shortcut: shortcutLabel("archiveThread", "CmdOrCtrl+Shift+A"),
              disabled: sessionCommandDisabled,
            },
          ),
        ]
      : []),
    ...(context.canExportConversationMarkdown
      ? [
          command(
            "copyConversationMarkdown",
            "Chat",
            {
              id: "lib.commandPaletteCommands.markdown.title",
              defaultMessage: "Copy as Markdown",
            },
            {
              id: "lib.commandPaletteCommands.markdown.description",
              defaultMessage: "Copy the complete active chat as Markdown",
            },
            ["copy", "markdown", "chat", "thread", "transcript"],
            1075,
            { shortcut: shortcutLabel("copyConversationMarkdown") },
          ),
        ]
      : []),
    command(
      "toggleThreadPin",
      "Chat",
      context.activeSessionPinned
        ? {
            id: "lib.commandPaletteCommands.unpin.title",
            defaultMessage: "Unpin chat",
          }
        : {
            id: "lib.commandPaletteCommands.pin.title",
            defaultMessage: "Pin chat",
          },
      context.activeSessionPinned
        ? {
            id: "lib.commandPaletteCommands.unpin.description",
            defaultMessage: "Remove the active chat from pinned",
          }
        : {
            id: "lib.commandPaletteCommands.pin.description",
            defaultMessage: "Pin the active chat",
          },
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
      context.activeSessionUnread
        ? {
            id: "lib.commandPaletteCommands.markRead.title",
            defaultMessage: "Mark chat as read",
          }
        : {
            id: "lib.commandPaletteCommands.markUnread.title",
            defaultMessage: "Mark chat as unread",
          },
      context.activeSessionUnread
        ? {
            id: "lib.commandPaletteCommands.markRead.description",
            defaultMessage: "Clear the active chat's unread dot",
          }
        : {
            id: "lib.commandPaletteCommands.markUnread.description",
            defaultMessage: "Keep the active chat's unread dot to come back to it",
          },
      ["unread", "read", "later", "chat", "thread", "session"],
      1068,
      {
        shortcut: shortcutLabel("toggleThreadUnread", "CmdOrCtrl+Shift+U"),
        disabled: sessionCommandDisabled,
      },
    ),
    command(
      "settleThread",
      "Chat",
      context.activeSessionSettled
        ? {
            id: "lib.commandPaletteCommands.reopen.title",
            defaultMessage: "Reopen chat",
          }
        : {
            id: "lib.commandPaletteCommands.settle.title",
            defaultMessage: "Settle chat",
          },
      context.activeSessionSettled
        ? {
            id: "lib.commandPaletteCommands.reopen.description",
            defaultMessage: "Return the active chat to your open chats",
          }
        : {
            id: "lib.commandPaletteCommands.settle.description",
            defaultMessage: "Move the active chat to Settled. It returns when it needs you",
          },
      ["settle", "reopen", "chat", "thread", "session"],
      1067,
      {
        shortcut: shortcutLabel("settleThread", "CmdOrCtrl+Alt+E"),
        disabled: sessionCommandDisabled,
      },
    ),
    ...(
      Object.entries(SNOOZE_THREAD_COMMAND_IDS) as [ChatSnoozePresetId, SnoozeThreadCommandId][]
    ).map(([presetId, commandId], index) =>
      command(
        commandId,
        "Chat",
        SNOOZE_THREAD_COMMAND_TITLES[presetId],
        {
          id: "lib.commandPaletteCommands.snoozeDescription",
          defaultMessage: "Make the active chat unread again then",
        },
        ["snooze", "unread", "chat"],
        1066 - index,
        { disabled: sessionCommandDisabled },
      ),
    ),
    ...(context.activeSessionSnoozed
      ? [
          command(
            "wakeThread",
            "Chat",
            {
              id: "lib.commandPaletteCommands.wake.title",
              defaultMessage: "Wake",
            },
            {
              id: "lib.commandPaletteCommands.wake.description",
              defaultMessage: "Wake the active chat",
            },
            ["wake", "snooze", "chat"],
            1061,
          ),
        ]
      : []),
    command(
      "openSideChat",
      "Chat",
      {
        id: "lib.commandPaletteCommands.sideChat.title",
        defaultMessage: "Open side chat",
      },
      {
        id: "lib.commandPaletteCommands.sideChat.description",
        defaultMessage: "Start a side chat for the active chat",
      },
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
      {
        id: "lib.commandPaletteCommands.back.title",
        defaultMessage: "Back",
      },
      {
        id: "lib.commandPaletteCommands.back.description",
        defaultMessage: "Return to the previous workbench context",
      },
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
      {
        id: "lib.commandPaletteCommands.forward.title",
        defaultMessage: "Forward",
      },
      {
        id: "lib.commandPaletteCommands.forward.description",
        defaultMessage: "Move to the next workbench context",
      },
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
      {
        id: "lib.commandPaletteCommands.find.title",
        defaultMessage: "Find",
      },
      {
        id: "lib.commandPaletteCommands.find.description",
        defaultMessage: "Find in the current chat, review, or browser page",
      },
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
      {
        id: "lib.commandPaletteCommands.sidebar.title",
        defaultMessage: "Toggle sidebar",
      },
      {
        id: "lib.commandPaletteCommands.sidebar.description",
        defaultMessage: "Show or hide the project sidebar",
      },
      ["sidebar", "project", "shell"],
      940,
      {
        shortcut: shortcutLabel("toggleSidebar", "CmdOrCtrl+B"),
      },
    ),
    command(
      "toggleSidePanel",
      "Panels",
      {
        id: "lib.commandPaletteCommands.sidePanel.title",
        defaultMessage: "Toggle side panel",
      },
      {
        id: "lib.commandPaletteCommands.sidePanel.description",
        defaultMessage: "Show or hide the right panel",
      },
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
      {
        id: "lib.commandPaletteCommands.bottomPanel.title",
        defaultMessage: "Toggle bottom panel",
      },
      {
        id: "lib.commandPaletteCommands.bottomPanel.description",
        defaultMessage: "Show or hide the bottom panel",
      },
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
      {
        id: "lib.commandPaletteCommands.fullView.title",
        defaultMessage: "Toggle full view",
      },
      {
        id: "lib.commandPaletteCommands.fullView.description",
        defaultMessage: "Expand the content panel to fill the window, or return to split view",
      },
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
      {
        id: "lib.commandPaletteCommands.fileTree.title",
        defaultMessage: "Toggle file tree",
      },
      {
        id: "lib.commandPaletteCommands.fileTree.description",
        defaultMessage: "Open project files in the active panel",
      },
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
      context.gitBlameEnabled
        ? {
            id: "lib.commandPaletteCommands.hideBlame.title",
            defaultMessage: "Disable Git blame",
          }
        : {
            id: "lib.commandPaletteCommands.showBlame.title",
            defaultMessage: "Enable Git blame",
          },
      context.gitBlameEnabled
        ? {
            id: "lib.commandPaletteCommands.hideBlame.description",
            defaultMessage: "Hide the author and commit for the active editor line",
          }
        : {
            id: "lib.commandPaletteCommands.showBlame.description",
            defaultMessage: "Show the author and commit for the active editor line",
          },
      ["git", "blame", "author", "commit", "line", "editor"],
      905,
    ),
    command(
      "openBrowserTab",
      "Panels",
      {
        id: "lib.commandPaletteCommands.browser.title",
        defaultMessage: "Open browser tab",
      },
      {
        id: "lib.commandPaletteCommands.browser.description",
        defaultMessage: "Open a Browser tab in the active panel",
      },
      ["browser", "web", "panel", "tab"],
      900,
      {
        shortcut: shortcutLabel("openBrowserTab", "CmdOrCtrl+T"),
        disabled: !context.panelActionAvailability.browser,
      },
    ),
    ...(context.panelActionAvailability.agents
      ? [
          command(
            "openAgentsTab",
            "Panels",
            {
              id: "lib.commandPaletteCommands.agents.title",
              defaultMessage: "Open aerial view",
            },
            {
              id: "lib.commandPaletteCommands.agents.description",
              defaultMessage: "Every chat at work, with its subagents",
            },
            ["aerial", "overview", "agents", "subagents", "delegation", "panel", "tab"],
            890,
          ),
        ]
      : []),
    command(
      "openReviewTab",
      "Panels",
      {
        id: "lib.commandPaletteCommands.review.title",
        defaultMessage: "Open review tab",
      },
      {
        id: "lib.commandPaletteCommands.review.description",
        defaultMessage: "Open or focus code review in the right panel",
      },
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
      {
        id: "lib.commandPaletteCommands.terminal.title",
        defaultMessage: "Open terminal",
      },
      {
        id: "lib.commandPaletteCommands.terminal.description",
        defaultMessage: "Focus or create a terminal tab",
      },
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
      {
        id: "lib.commandPaletteCommands.database.title",
        defaultMessage: "Open DB View tab",
      },
      {
        id: "lib.commandPaletteCommands.database.description",
        defaultMessage: "Open the active project database in the right panel",
      },
      ["db", "database", "view", "board", "board", "panel", "tab"],
      860,
      {
        disabled: !context.panelActionAvailability.db_view,
      },
    ),
    command(
      "newThreadInProject",
      "Project",
      {
        id: "lib.commandPaletteCommands.projectChat.title",
        defaultMessage: "New chat in project",
      },
      {
        id: "lib.commandPaletteCommands.projectChat.description",
        defaultMessage: "Start a new chat in the active project",
      },
      ["new", "chat", "project"],
      830,
      {
        disabled: !context.canStartNewChatInProject,
      },
    ),
    command(
      "openFolder",
      "Project",
      {
        id: "lib.commandPaletteCommands.folder.title",
        defaultMessage: "Open folder",
      },
      {
        id: "lib.commandPaletteCommands.folder.description",
        defaultMessage: "Open a local folder",
      },
      ["open", "folder", "project"],
      810,
      { shortcut: shortcutLabel("openFolder", "CmdOrCtrl+O") },
    ),
    command(
      "settings",
      "Configure",
      {
        id: "lib.commandPaletteCommands.settings.title",
        defaultMessage: "Settings",
      },
      {
        id: "lib.commandPaletteCommands.settings.description",
        defaultMessage: "Adjust app, editor, and worktree preferences",
      },
      ["settings", "preferences", "config"],
      740,
      {
        shortcut: shortcutLabel("settings", "CmdOrCtrl+,"),
      },
    ),
    command(
      "showKeyboardShortcuts",
      "Configure",
      {
        id: "lib.commandPaletteCommands.shortcuts.title",
        defaultMessage: "Keyboard shortcuts",
      },
      {
        id: "lib.commandPaletteCommands.shortcuts.description",
        defaultMessage: "Show available shortcuts and open customization",
      },
      ["keyboard", "shortcuts", "hotkeys", "settings"],
      710,
      {
        shortcut: shortcutLabel("showKeyboardShortcuts", "CmdOrCtrl+Shift+/"),
      },
    ),
    // Setup connects this desktop's own Agents and Projects, which a team window never reads.
    ...(!isRemoteSpace()
      ? [
          command(
            "runSetupAgain",
            "Configure",
            {
              id: "lib.commandPaletteCommands.setup.title",
              defaultMessage: "Run setup again",
            },
            {
              id: "lib.commandPaletteCommands.setup.description",
              defaultMessage: "Connect Agents and add projects",
            },
            ["setup", "welcome", "onboarding", "agents", "connect"],
            705,
          ),
        ]
      : []),
    ...(context.canReloadSkills === true
      ? [
          command(
            "forceReloadSkills",
            "Skills",
            {
              id: "lib.commandPaletteCommands.reloadSkills.title",
              defaultMessage: "Force reload skills",
            },
            {
              id: "lib.commandPaletteCommands.reloadSkills.description",
              defaultMessage: "Reload installed skills",
            },
            ["skills", "reload"],
            650,
          ),
        ]
      : []),
    command(
      "openInbox",
      "App",
      {
        id: "lib.commandPaletteCommands.inbox.title",
        defaultMessage: "Open Inbox",
      },
      {
        id: "lib.commandPaletteCommands.inbox.description",
        defaultMessage: "Capture a thought and review dispatch suggestions",
      },
      ["inbox", "capture", "message", "note", "todo", "dispatch"],
      640,
      { shortcut: shortcutLabel("openInbox", "CmdOrCtrl+Shift+D") },
    ),
    ...(!isRemoteSpace()
      ? [
          command(
            "manageTasks",
            "App",
            {
              id: "lib.commandPaletteCommands.automations.title",
              defaultMessage: "Manage automations",
            },
            {
              id: "lib.commandPaletteCommands.automations.description",
              defaultMessage: "Open automation management",
            },
            ["automations", "schedule", "manage"],
            630,
          ),
        ]
      : []),
    command(
      "openProcessManager",
      "App",
      {
        id: "lib.commandPaletteCommands.processes.title",
        defaultMessage: "Process Manager",
      },
      {
        id: "lib.commandPaletteCommands.processes.description",
        defaultMessage: "Open the process manager",
      },
      ["process", "manager"],
      620,
      {
        shortcut: shortcutLabel("openProcessManager", "Ctrl+Alt+M"),
      },
    ),
  ];
}
