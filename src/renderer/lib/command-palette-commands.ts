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
  CREATE_PAGE_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
} from "../../shared/workbench-commands";
import type { CommandPaletteCommand, CommandPaletteCommandGroup } from "./command-palette";
import type { WorkbenchPanelActionKind } from "./workbench-panel-capabilities";

export const OPEN_DB_VIEW_TAB_COMMAND_ID = "openDbViewTab";

export type CommandPaletteShellCommandId =
  | typeof NAVIGATE_BACK_COMMAND_ID
  | typeof NAVIGATE_FORWARD_COMMAND_ID
  | "newThread"
  | "newThreadInProject"
  | typeof CREATE_PAGE_COMMAND_ID
  | typeof RENAME_THREAD_COMMAND_ID
  | "archiveThread"
  | "copyConversationMarkdown"
  | "toggleThreadPin"
  | "openThreadInNewWindow"
  | typeof TOGGLE_SIDEBAR_COMMAND_ID
  | "toggleSidePanel"
  | typeof TOGGLE_BOTTOM_PANEL_COMMAND_ID
  | "toggleFileTreePanel"
  | "openBrowserTab"
  | "openReviewTab"
  | "toggleTerminal"
  | typeof OPEN_DB_VIEW_TAB_COMMAND_ID
  | "openSideChat"
  | "findInThread"
  | "manageTasks"
  | "openLibraryFiles"
  | "openProcessManager"
  | "settings"
  | "showKeyboardShortcuts";

export type CommandPaletteShellCommandHandlers = Record<CommandPaletteShellCommandId, () => void>;

export interface CommandPaletteShellCommandContext {
  canGoBack: boolean;
  canGoForward: boolean;
  canStartNewChat: boolean;
  canStartNewChatInProject: boolean;
  pageCreateUnavailableReason: string | null;
  showMockCommands: boolean;
  hasActiveSession: boolean;
  activeSessionPinned: boolean;
  hasAttachedThread: boolean;
  canExportConversationMarkdown: boolean;
  panelActionAvailability: Record<WorkbenchPanelActionKind, boolean>;
  canOpenSessionInNewWindow: boolean;
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
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
    id === CREATE_PAGE_COMMAND_ID ||
    id === RENAME_THREAD_COMMAND_ID ||
    id === "archiveThread" ||
    id === "copyConversationMarkdown" ||
    id === "toggleThreadPin" ||
    id === "openThreadInNewWindow" ||
    id === TOGGLE_SIDEBAR_COMMAND_ID ||
    id === "toggleSidePanel" ||
    id === TOGGLE_BOTTOM_PANEL_COMMAND_ID ||
    id === "toggleFileTreePanel" ||
    id === "openBrowserTab" ||
    id === "openReviewTab" ||
    id === "toggleTerminal" ||
    id === OPEN_DB_VIEW_TAB_COMMAND_ID ||
    id === "openSideChat" ||
    id === "findInThread" ||
    id === "manageTasks" ||
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
    id: string,
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
      mockReason?: string;
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
    mockReason: options.mockReason,
  });
  const mockCommand = (
    id: string,
    group: CommandPaletteCommandGroup,
    title: string,
    subtitle: string,
    keywords: string[],
    priority: number,
    shortcut?: string,
  ): CommandPaletteCommand =>
    command(id, group, title, subtitle, keywords, priority, {
      shortcut,
      disabled: true,
      mockReason: "Mock UI only. Not available in Nodex yet.",
    });
  const maybeMockCommand = (
    id: string,
    group: CommandPaletteCommandGroup,
    title: string,
    subtitle: string,
    keywords: string[],
    priority: number,
    shortcut?: string,
  ): CommandPaletteCommand[] =>
    context.showMockCommands
      ? [mockCommand(id, group, title, subtitle, keywords, priority, shortcut)]
      : [];

  return [
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
      CREATE_PAGE_COMMAND_ID,
      "Project",
      "Create Page",
      "Create a Page in the active Project Board",
      ["create", "new", "page", "board", "board"],
      1185,
      {
        shortcut: shortcutLabel(CREATE_PAGE_COMMAND_ID, "CmdOrCtrl+Shift+C"),
        disabled: context.pageCreateUnavailableReason !== null,
        disabledReason: context.pageCreateUnavailableReason ?? undefined,
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
    ...maybeMockCommand(
      "quickChat",
      "Chat",
      "New quick chat",
      "Start a quick chat",
      ["new", "quick", "chat"],
      1110,
      shortcutLabel("quickChat", "CmdOrCtrl+Alt+N"),
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
    ...maybeMockCommand(
      "previousThread",
      "Navigation",
      "Previous chat",
      "Move to the previous chat",
      ["previous", "chat", "navigation"],
      1040,
    ),
    ...maybeMockCommand(
      "nextThread",
      "Navigation",
      "Next chat",
      "Move to the next chat",
      ["next", "chat", "navigation"],
      1030,
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
    ...maybeMockCommand(
      "focusBrowserAddressBar",
      "Navigation",
      "Focus browser address bar",
      "Focus the active Browser tab address bar",
      ["browser", "address", "url"],
      990,
      shortcutLabel("focusBrowserAddressBar", "CmdOrCtrl+L"),
    ),
    ...maybeMockCommand(
      "switchMode1",
      "Navigation",
      "Switch mode 1",
      "Switch to the first reference app mode",
      ["switch", "mode"],
      980,
    ),
    ...maybeMockCommand(
      "switchMode2",
      "Navigation",
      "Switch mode 2",
      "Switch to the second reference app mode",
      ["switch", "mode"],
      970,
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
    ...maybeMockCommand(
      "switchProject",
      "Project",
      "Switch project",
      "Switch to another project",
      ["switch", "project", "workspace"],
      820,
    ),
    ...maybeMockCommand(
      "openFolder",
      "Project",
      "Open folder",
      "Open a local folder",
      ["open", "folder", "project"],
      810,
      shortcutLabel("openFolder", "CmdOrCtrl+O"),
    ),
    ...(context.showMockCommands
      ? Array.from({ length: 9 }, (_, index) =>
          mockCommand(
            `environmentAction${index + 1}`,
            "Project",
            `Environment action ${index + 1}`,
            "Run a configured project environment action",
            ["environment", "action", "project"],
            800 - index,
          ),
        )
      : []),
    ...maybeMockCommand(
      "git.commit",
      "Project",
      "Git commit",
      "Commit project changes",
      ["git", "commit", "changes"],
      780,
    ),
    ...maybeMockCommand(
      "git.push",
      "Project",
      "Git push",
      "Push project changes",
      ["git", "push", "changes"],
      770,
    ),
    ...maybeMockCommand(
      "git.createPullRequest",
      "Project",
      "Create pull request",
      "Create a pull request for project changes",
      ["git", "pull", "request", "pr"],
      760,
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
    ...maybeMockCommand(
      "mcpSettings",
      "Configure",
      "MCP settings",
      "Open MCP server settings",
      ["mcp", "settings", "tools"],
      730,
    ),
    ...maybeMockCommand(
      "personalitySettings",
      "Configure",
      "Personality settings",
      "Open assistant personality settings",
      ["personality", "settings"],
      720,
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
    ...maybeMockCommand(
      "installPrimaryRuntime",
      "Configure",
      "Install Nodex Agent Runtime",
      "Install the primary Nodex agent runtime",
      ["install", "workspace", "runtime"],
      700,
    ),
    ...maybeMockCommand(
      "switchTheme",
      "Configure",
      "Switch theme",
      "Switch between light and dark theme",
      ["theme", "appearance", "light", "dark"],
      690,
    ),
    ...maybeMockCommand(
      "themePreset",
      "Configure",
      "Theme presets",
      "Choose a theme preset",
      ["theme", "preset", "appearance"],
      680,
    ),
    ...maybeMockCommand(
      "openSkills",
      "Skills",
      "Go to skills",
      "Open the skills surface",
      ["skills", "plugins"],
      660,
    ),
    ...maybeMockCommand(
      "forceReloadSkills",
      "Skills",
      "Force reload skills",
      "Reload installed skills",
      ["skills", "reload"],
      650,
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
    ...maybeMockCommand(
      "openControlWindow",
      "App",
      "Open control window",
      "Open the control window",
      ["control", "window"],
      610,
    ),
    ...maybeMockCommand(
      "logOut",
      "App",
      "Log out",
      "Log out of your account",
      ["logout", "account"],
      600,
    ),
    ...maybeMockCommand(
      "feedback",
      "App",
      "Feedback",
      "Send feedback",
      ["feedback", "support"],
      590,
    ),
    ...maybeMockCommand(
      "openAvatarOverlay",
      "App",
      "Wake Pet",
      "Wake the Nodex pet",
      ["pet", "avatar"],
      580,
    ),
    ...maybeMockCommand(
      "tuckAwayPetOverlay",
      "App",
      "Tuck Away Pet",
      "Hide the Nodex pet",
      ["pet", "avatar"],
      570,
    ),
  ];
}
