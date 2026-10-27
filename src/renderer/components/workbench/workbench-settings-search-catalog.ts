import { buildSettingsSearchResults, type SettingsSearchContext } from "@/lib/settings-search";
import { scoreSettingsQueryMatch } from "@/lib/settings-search-score";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../lib/worktree-branch-prefix";
import { FILE_LINK_OPENER_OPTIONS } from "../../../shared/file-link-openers";

export interface SettingsSearchCatalogSection {
  messages: readonly string[];
  searchTerms?: (context: SettingsSearchContext) => readonly string[];
}

interface SettingsSearchCatalogPanel {
  title: string;
  subtitle?: string;
  groups: readonly SettingsSearchCatalogGroup[];
  messages?: readonly string[];
}

interface SettingsSearchCatalogGroup {
  anchor?: string;
  title: string;
  description?: string;
  entries?: readonly SettingsSearchCatalogEntry[];
  messages?: readonly string[];
}

interface SettingsSearchCatalogEntry {
  label: string;
  description?: string;
  terms?: readonly string[];
}

function entry(
  label: string,
  description?: string,
  terms: readonly string[] = [],
): SettingsSearchCatalogEntry {
  return { description, label, terms };
}

function uniqueText(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];

  const collect = (value: unknown) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      texts.push(text);
      return;
    }

    if (!Array.isArray(value)) return;

    for (const entry of value) {
      collect(entry);
    }
  };

  for (const value of values) {
    collect(value);
  }

  return texts;
}

function materializePanelSearchMessages(panel: SettingsSearchCatalogPanel): readonly string[] {
  const groups = panel.groups.flatMap((group) => [
    group.title,
    group.description,
    group.messages,
    group.entries?.flatMap((setting) => [setting.label, setting.description, setting.terms]),
  ]);

  return uniqueText([panel.title, panel.subtitle, panel.messages, groups]);
}

function projectNameTerms({
  activeProjectName,
  projectNames,
}: SettingsSearchContext): readonly string[] {
  return uniqueText([projectNames, activeProjectName]);
}

export const APPEARANCE_ADVANCED_ANCHOR = "advanced";

export const SETTINGS_SEARCH_PANELS = {
  account: {
    title: "Account",
    subtitle: "Optional. Everything local works without signing in.",
    groups: [
      {
        title: "Nodex Account",
        entries: [entry("Sign in"), entry("Sign out")],
      },
    ],
  },
  "general-settings": {
    title: "General",
    subtitle: "How Nodex starts and updates, how chats and writing behave, and what you share.",
    groups: [
      {
        anchor: "app",
        title: "App",
        entries: [
          entry("Restore windows", "Choose which windows reopen after quitting Nodex.", [
            "All",
            "Last",
            "None",
            "quit",
            "reopen",
          ]),
          entry("Nodex version", "Check for updates, or restart to install a downloaded one.", [
            "App updates",
            "Check now",
            "Restart to update",
            "download updates",
            "install updates",
          ]),
          entry(
            "Check automatically",
            "Look for updates in the background and download them when they're ready.",
            ["automatic updates", "check updates"],
          ),
          entry(
            "Update channel",
            "Nightly gets new builds first. Switching channels never installs an older build.",
            ["Stable", "Nightly", "beta"],
          ),
          entry("Open source licenses", "Third-party notices for bundled dependencies.", [
            "open source",
            "licenses",
            "dependencies",
          ]),
        ],
      },
      {
        anchor: "chats",
        title: "Chats",
        entries: [
          entry("Thread detail", "Choose how much command output to show in threads.", [
            "Steps",
            "Steps with code commands",
            "Steps with code output",
            "Hide commands and outputs.",
            "Show commands, collapse output.",
            "Show commands and expand output.",
          ]),
          entry("Show predictions", "Suggest your next message after an agent replies.", [
            "autocomplete",
            "suggestions",
          ]),
          entry(
            "Cmd+Enter to send long prompts",
            "Single-line prompts still send on Enter. Multiline prompts send with the modifier instead.",
            ["Ctrl+Enter to send long prompts", "composer", "modifier chord"],
          ),
          entry(
            "Queue follow-ups",
            "While a thread is running, queue new messages by default instead of steering it right away.",
            ["steer", "composer"],
          ),
        ],
      },
      {
        anchor: "writing",
        title: "Writing",
        entries: [
          entry("Spellcheck", "Mark misspelled words wherever you type.", ["spelling"]),
          entry("Auto-link while typing", "Turn typed URLs into links as you finish the token."),
          entry(
            "Auto-link on paste",
            "Recognize links in pasted text, including inline URL spans inside longer content.",
          ),
          entry(
            "Recognize bare domains",
            "Link plain domains like example.com. Leave off to avoid filename-like text such as .md paths.",
          ),
          entry(
            "Large paste text threshold",
            "Prompt when pasted plain text reaches this many characters, so you can materialize it instead of inflating the note.",
            ["Paste resource text threshold"],
          ),
          entry(
            "Large paste description soft limit",
            "Prompt before pasted plain text pushes the note near its description size ceiling.",
            ["Paste resource description soft limit"],
          ),
        ],
      },
      {
        anchor: "files-and-links",
        title: "Files & links",
        entries: [
          entry(
            "Copy file references as local paths",
            "Use absolute local paths in copied plain text; Library Files resolve to this Profile’s immutable .blob files.",
            ["absolute path", "portable file reference", "NFM copy"],
          ),
          entry(
            "Markdown file links",
            "Choose which desktop app handles absolute local file links in rendered markdown.",
            [
              "Open markdown file links in",
              ...FILE_LINK_OPENER_OPTIONS.map((option) => option.label),
            ],
          ),
        ],
      },
      {
        anchor: "notifications",
        title: "Notifications",
        entries: [
          entry("Turn completion notifications", "Set when agent alerts you that it's finished.", [
            "Enable question notifications",
            "Show alerts when notification permissions are required",
            "Show alerts when input is needed to continue",
            "Never",
            "Only when unfocused",
            "Always",
          ]),
        ],
      },
      {
        anchor: "privacy",
        title: "Privacy",
        entries: [
          entry(
            "Share crash reports",
            "Send crash diagnostics to Sentry. Prompts, transcripts, card text and local payloads are scrubbed before upload.",
            ["Diagnostics", "crash diagnostics", "Sentry", "scrubbed"],
          ),
          entry("Share session replays", "Include masked replays of the app with crash reports.", [
            "masked session replays",
          ]),
          entry(
            "Share product telemetry",
            "Send anonymous product events to Statsig. Prompts, transcripts, card text and file paths are never sent.",
            ["Telemetry", "anonymous product events", "Statsig"],
          ),
          entry(
            "Share web analytics",
            "Include filtered technical web analytics with product telemetry.",
            ["technical web analytics"],
          ),
        ],
      },
      {
        anchor: "app-server-diagnostics",
        title: "Troubleshooting",
        entries: [
          entry("App server requests", "Record requests while expanded.", [
            "App server diagnostics",
            "request log",
            "failed requests",
          ]),
        ],
      },
    ],
  },
  appearance: {
    title: "Appearance",
    groups: [
      {
        title: "Mode",
        messages: ["Visual style"],
        entries: [entry("Mode", "", ["System", "Light", "Dark", "Theme", "force fixed theme"])],
      },
      {
        title: "Theme",
        entries: [
          entry("Accent color", "", [
            "Default",
            "Blue",
            "Green",
            "Yellow",
            "Pink",
            "Orange",
            "Purple",
            "Black",
            "White",
            "Custom",
            "hex color",
          ]),
          entry("Font", "", ["UI font", "System", "font family", "Light theme", "Dark theme"]),
        ],
      },
      {
        title: "Advanced",
        anchor: APPEARANCE_ADVANCED_ANCHOR,
        messages: ["Reset", "Reset advanced appearance"],
        entries: [
          entry("UI font size", "", ["Default", "font size", "interface", "chat text"]),
          entry("Content font size", "Pages", ["Page font size", "document", "body", "headings"]),
          entry("Code font size", "", [
            "Default",
            "editor font size",
            "chats",
            "diffs",
            "terminals",
          ]),
          entry("Font smoothing", "", ["macOS", "anti-aliasing", "antialiasing"]),
          entry("Reduce motion", "", [
            "System",
            "On",
            "Off",
            "Reduced motion",
            "animation",
            "accessibility",
          ]),
          entry("Separate light/dark modes", "", ["Light theme", "Dark theme", "font appearance"]),
          entry("Content font", "", ["Same as UI font", "Light", "Dark", "font family"]),
          entry("Code font", "", ["System", "Light", "Dark", "monospace", "font family"]),
        ],
      },
    ],
  },
  voice: {
    title: "Voice",
    subtitle: "Microphone, dictation behavior, and recoverable recordings.",
    groups: [
      {
        title: "General",
        messages: [
          "Microphone",
          "Used for voice chat and dictation",
          "System default",
          "Allow access",
          "Open settings",
        ],
      },
      {
        title: "Dictation",
        messages: [
          "Hold-to-dictate hotkey",
          "Toggle dictation hotkey",
          "Keep global bar visible",
          "Play dictation sounds",
          "Dictation dictionary",
          "Words or phrases dictation should recognize",
          "Add entry",
        ],
      },
      {
        title: "Recent recordings",
        messages: ["Copy transcript", "Retry", "Download recording", "Delete recording"],
      },
    ],
  },
  agent: {
    title: "Agents",
    subtitle: "The coding agents Nodex can run. Open one to change how it starts and signs in.",
    groups: [
      {
        anchor: "codex",
        title: "Codex",
        entries: [
          entry(
            "Speed",
            "The speed new Codex chats start with. A speed you pick in a Codex chat becomes the new default.",
            ["Service tier", "Standard", "Fast", "Fast mode"],
          ),
          entry("Codex home", "Settings, skills and conversation history.", [
            "CODEX_HOME",
            "~/.codex",
            "restart",
          ]),
          entry("Account directory", "A separate folder for another Codex sign-in.", [
            "account",
            "sign-in",
          ]),
          entry(
            "Copy setup from",
            "Brings in instructions, skills, MCP servers and more once you review them. Only what Codex is missing is added.",
            [
              "Claude Code",
              "Other Codex home",
              "migrate",
              "instructions",
              "AGENTS.md",
              "skills",
              "MCP servers",
              "hooks",
              "plugins",
              "subagents",
              "commands",
              "memory",
            ],
          ),
        ],
      },
      {
        anchor: "claude",
        title: "Claude Code",
        entries: [
          entry("Profile", "Use a profile for each Claude setup or account.", [
            "Add profile",
            "Name",
            "Executable",
            "claude",
          ]),
          entry("Config directory", "Where this profile keeps its sign-in and settings.", [
            "~/.claude",
            "CLAUDE_CONFIG_DIR",
            "account",
          ]),
          entry("Environment variables", "Paste a .env file or export lines.", [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "export",
            "token",
            "proxy",
          ]),
          entry("Custom models", "Models this profile can choose besides Claude's own."),
        ],
      },
      {
        anchor: "opencode",
        title: "OpenCode",
        entries: [
          entry("Profile", "Use a profile for each OpenCode setup.", [
            "Add profile",
            "Name",
            "Executable",
            "opencode",
          ]),
          entry("Profile directory", "OpenCode's settings and data for this profile.", ["account"]),
          entry("Server URL", "Connect to an OpenCode server that's already running.", [
            "Local server",
            "OPENCODE_SERVER_PASSWORD",
          ]),
          entry("Environment variables", "Provider credentials for this OpenCode profile.", [
            "API key",
            "Moonshot",
            "Kimi",
            "DeepSeek",
            "OpenRouter",
            "Secret",
            "export",
          ]),
        ],
      },
      {
        anchor: "acp",
        title: "Other agents",
        entries: [
          entry(
            "Agent Client Protocol",
            "Install agents from the ACP Registry or run your own command.",
            [
              "ACP",
              "Add agent",
              "ACP Registry",
              "Local command",
              "Install",
              "Update",
              "Uninstall",
              "Connect",
              "Sign in",
              "Sign out",
              "Account storage",
              "Arguments",
              "Distribution",
              "Executable override",
              "System proxy",
              "Custom models",
              "Model services",
              "Qoder",
              "Copilot",
              "Gemini",
            ],
          ),
        ],
      },
    ],
  },
  "agent-import": {
    title: "Conversations",
    groups: [
      {
        title: "Import",
        entries: [
          entry(
            "Import conversations",
            "Copy Codex and Claude Code conversations into new chats.",
            [
              "codex://threads",
              "Conversation link or ID",
              "Claude Code",
              "Codex",
              "CODEX_HOME",
              "CLAUDE_CONFIG_DIR",
              "Browse",
              "batch",
            ],
          ),
        ],
        messages: [
          "Destination",
          "Projectless",
          "Folder missing",
          "Choose folder",
          "Import and open",
          "Already imported",
        ],
      },
    ],
  },
  "inbox-settings": {
    title: "Inbox",
    subtitle: "How messages you capture are suggested and dispatched.",
    groups: [
      {
        title: "Suggestions",
        entries: [
          entry(
            "Suggest where messages go",
            "An Agent reads new messages and proposes a chat, a Project, or keeping them.",
            ["inbox", "suggestions", "dispatch", "agent", "capture"],
          ),
          entry("Suggest with", "The Agent and model that write suggestions.", [
            "suggestion agent",
            "codex",
            "claude",
            "model",
          ]),
          entry(
            "Routing preferences",
            "Standing instructions suggestions follow over Nodex's own guidance.",
            ["instructions", "routing"],
          ),
        ],
      },
      {
        title: "Chats",
        entries: [
          entry("New chats run on", "The Agent, model and effort for chats the Inbox starts.", [
            "dispatch",
            "runtime",
            "model",
            "effort",
            "speed",
          ]),
        ],
      },
    ],
  },
  "keyboard-shortcuts": {
    title: "Keyboard shortcuts",
    groups: [
      {
        title: "Keyboard shortcuts",
        messages: [
          "Search keyboard shortcuts",
          "Search shortcuts",
          "Search by keystrokes",
          "Press shortcut",
          "Loading shortcuts...",
          "Could not load shortcuts.",
          "No matching shortcuts",
          "Command",
          "Keybinding",
          "Actions",
          "Change shortcut",
          "Set shortcut",
          "Clear shortcut",
          "Reset shortcut",
          "Reset all to defaults",
          "Reset all keyboard shortcuts?",
          "This will discard all custom shortcuts and restore the default keyboard shortcuts.",
          "Unassigned",
          "Conflict",
          "Command keybindings",
        ],
      },
    ],
  },
  page: {
    title: "Pages",
    subtitle: "Page creation and import behavior.",
    groups: [
      {
        title: "Block import",
        entries: [
          entry(
            "Task shorthand on Block → Page",
            "Interpret priority, estimate, and tags such as 1XL(ui, unclear) when a Block is promoted into a Page.",
            ["task shorthand", "block import", "priority", "estimate", "tags", "1XL"],
          ),
        ],
      },
    ],
  },
  git: {
    title: "Git",
    subtitle: "Branch naming and instructions used by Nodex for Git operations.",
    groups: [
      {
        title: "Branches",
        entries: [
          entry("Branch prefix", "Prefix used when Nodex creates new branches.", [
            DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
          ]),
        ],
      },
      {
        title: "Commit instructions",
        description: "Added to commit message generation prompts.",
        messages: ["Add commit message guidance", "Save"],
      },
      {
        title: "Pull request instructions",
        description: "Added to PR title and description generation prompts.",
        messages: ["Add pull request guidance", "Save"],
      },
    ],
  },
  worktrees: {
    title: "Worktrees",
    subtitle: "Managed worktree creation, naming, and cleanup.",
    groups: [
      {
        title: "Defaults",
        entries: [
          entry(
            "Worktree start mode",
            "Choose whether new worktree threads auto-create a branch or start detached.",
            ["Auto branch", "Detached HEAD"],
          ),
        ],
      },
      {
        title: "Managed worktrees",
        description: "Worktrees created by card threads. Hover a row to remove.",
        messages: ["Git", "Branch", "Managed directory", "Cleanup", "Remove worktree record"],
      },
    ],
  },
  "local-environments": {
    title: "Local environments",
    subtitle: "Local environments tell Nodex how to set up worktrees for a project. Learn more.",
    groups: [
      {
        title: "Select a project",
        messages: [
          "Add project",
          "No projects yet. Add one to configure local environments.",
          "Available projects",
          "Loading local environments",
          "Fetching your project configuration.",
        ],
      },
      {
        title: "Setup",
        description: "This script runs on worktree creation",
        entries: [
          entry("Name"),
          entry("Setup script environment variables", "Variables available to the setup script.", [
            "Source workspace path",
            "New worktree path",
            "CODEX_SOURCE_TREE_PATH",
            "CODEX_WORKTREE_PATH",
          ]),
        ],
        messages: [
          "Default",
          "macOS",
          "Linux",
          "Windows",
          "No script configured",
          "No script configured for this platform",
          "No platform override. Using the default script",
        ],
      },
      {
        title: "Cleanup",
        description: "Runs at the project root before worktree cleanup",
        messages: [
          "Default",
          "macOS",
          "Linux",
          "Windows",
          "No script configured",
          "No script configured for this platform",
        ],
      },
      {
        title: "Actions",
        description: "These actions can run any command and will be displayed in the header.",
        messages: [
          "Add action",
          "No actions configured",
          "All platforms",
          "Enter an action name",
          "Enter an action command",
          "Edit local environment",
          "Discard edits",
          "Retry save",
        ],
      },
    ],
  },
  "hooks-settings": {
    title: "Hooks",
    subtitle: "Manage lifecycle hooks from config and enabled plugins.",
    groups: [
      {
        title: "From Config",
        entries: [
          entry("User config", "Hooks configured for the current user."),
          entry("Admin config", "Hooks managed by system and organization policy."),
        ],
      },
      {
        title: "From Plugins",
        messages: ["Unknown plugin", "Trust", "Managed hooks are always on"],
      },
      {
        title: "From Projects",
        messages: ["Project config", "Reload hooks", "No hooks found", "Could not load hooks"],
      },
      {
        title: "Other sources",
        messages: ["Session flags", "Unknown source", "Configured hooks will appear here"],
      },
    ],
  },
  "data-controls": {
    title: "Data controls",
    subtitle: "Manage archived chats and permanent local deletion.",
    groups: [
      {
        title: "Archived chats",
        messages: [
          "Search archived chats",
          "Group archived chats",
          "Sort archived chats",
          "Unarchive",
          "Delete archived chat",
          "Delete all archived local chats",
        ],
      },
    ],
  },
  backups: {
    title: "Backups",
    subtitle: "Snapshot cadence, retention, and restore operations.",
    groups: [
      {
        title: "Automatic snapshots",
        entries: [
          entry("Auto backups", "Schedule background snapshots for the local store."),
          entry("Frequency", "Minimum is one hour.", ["hours"]),
          entry("Retention", "Snapshots kept before pruning.", ["max"]),
        ],
        messages: ["Some values locked by env vars.", "Refresh", "Save schedule"],
      },
      {
        title: "History retention",
        entries: [
          entry(
            "History retention",
            "Newest deleted Block records kept per Project before safe collection. Use 0 to collect every unreferenced tombstone.",
            ["records"],
          ),
        ],
        messages: ["Value locked by env var.", "Applied by background maintenance.", "Apply"],
      },
      {
        title: "Snapshots",
        entries: [entry("Safety backup", "Create a fresh snapshot before restoring an older one.")],
        messages: [
          "Optional snapshot label",
          "Create snapshot",
          "No snapshots yet.",
          "Manual",
          "Auto",
          "Safety",
          "Confirm restore",
          "Restore",
          "Confirm delete",
          "Cancel",
          "Delete snapshot",
          "Snapshot deleted.",
          "Backup restored.",
        ],
      },
    ],
  },
} satisfies Record<string, SettingsSearchCatalogPanel>;

/**
 * The anchored group a settings search result lands on inside its panel: the best-matching group
 * when it has an anchor, or none when the query names the panel itself.
 */
export function settingsSearchAnchor(sectionId: string, query: string | undefined): string | null {
  const panel: SettingsSearchCatalogPanel | undefined =
    SETTINGS_SEARCH_PANELS[sectionId as keyof typeof SETTINGS_SEARCH_PANELS];
  if (!panel || !query?.trim() || scoreSettingsQueryMatch(panel.title, query) > 0) return null;
  const targets = panel.groups.map((group, index) => ({
    sectionId: String(index),
    panelLabel: group.title,
    messageTexts: materializePanelSearchMessages({ title: group.title, groups: [group] }),
    termTexts: [],
  }));
  const [best] = buildSettingsSearchResults({
    query,
    targets,
    visibleSectionIds: targets.map((target) => target.sectionId),
  });
  return best ? (panel.groups[Number(best.sectionId)]?.anchor ?? null) : null;
}

/** Use the canonical Advanced group when a settings search opens Appearance. */
export function shouldExpandAppearanceAdvanced(query: string | undefined): boolean {
  return settingsSearchAnchor("appearance", query) === APPEARANCE_ADVANCED_ANCHOR;
}

export const SETTINGS_SEARCH_CATALOG = {
  account: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.account),
  },
  "general-settings": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["general-settings"]),
  },
  appearance: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.appearance),
  },
  voice: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.voice),
  },
  browser: {
    messages: [
      "Browser",
      "Built-in Browser Profile",
      "Import browser data",
      "Cookies",
      "Site data",
      "Cache",
      "Download history",
      "Provider availability",
      "General",
      "Autofill and passwords",
      "Saved passwords",
      "Password manager",
      "Credential storage",
      "Import from your browser",
      "Remove password",
      "Contact info",
      "Autofill",
      "Name",
      "Email",
      "Phone",
      "Address",
      "History",
      "Search history",
      "Clear Browser history",
      "Visited pages",
      "Extensions",
      "Control existing browsers",
      "Waiting for extension",
      "Browser control provider",
      "Extension manager",
      "Load unpacked",
      "Remove extension",
      "Shared Browser Profile",
      "Downloads",
      "Permissions",
      "Website access",
      "Browsing history",
      "Uploads",
      "Site permissions",
      "Remembered origins",
      "Developer mode",
      "Full CDP access",
    ],
  },
  "plugins-settings": {
    messages: [
      "Plugins",
      "Manage plugins, skills, and MCPs",
      "Browse directory",
      "Add a marketplace",
      "Skills",
    ],
  },
  "computer-use": {
    messages: [
      "Computer use",
      "Any app",
      "Always-allowed apps",
      "Always allowed to send",
      "Click sounds",
      "Locked use",
      "Picture in picture",
      "Always hide picture in picture",
    ],
  },
  agent: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.agent),
    searchTerms: ({ activeProjectName }: SettingsSearchContext) =>
      activeProjectName ? [activeProjectName] : [],
  },
  "agent-import": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["agent-import"]),
  },
  "keyboard-shortcuts": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["keyboard-shortcuts"]),
  },
  "inbox-settings": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["inbox-settings"]),
  },
  page: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.page),
  },
  git: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.git),
  },
  worktrees: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.worktrees),
  },
  "local-environments": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["local-environments"]),
    searchTerms: projectNameTerms,
  },
  "hooks-settings": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["hooks-settings"]),
    searchTerms: projectNameTerms,
  },
  "data-controls": {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["data-controls"]),
  },
  backups: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.backups),
  },
} satisfies Record<string, SettingsSearchCatalogSection>;
