import type { SettingsSearchContext } from "@/lib/settings-search";
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

const SETTINGS_SEARCH_PANELS = {
  "general-settings": {
    title: "General",
    subtitle: "App-wide shell behavior and notifications.",
    groups: [
      {
        title: "Permissions",
        entries: [
          entry("Default permissions mode", "Choose the preset used for new local tasks.", [
            "Ask for approval",
            "Approve for me",
            "Default permissions",
            "Auto-review",
            "Full access",
            "Custom (config.toml)",
            "guardian-approvals",
            "full-access",
            "custom",
            "sandbox",
            "Nodex Library",
            "without approval prompts",
            "elevated requests",
          ]),
        ],
      },
      {
        title: "General",
        entries: [
          entry("Restore windows", "Choose which workbench windows reopen after quitting Nodex.", [
            "All",
            "Last",
            "None",
            "quit",
            "reopen",
          ]),
          entry(
            "Service tier",
            "Choose the default speed for new thread requests. Standard is the default; Fast opts into the faster tier.",
            ["Standard", "Fast"],
          ),
          entry(
            "App updates",
            "Packaged macOS builds can check, download, and install stable updates in the background.",
            ["check updates", "download updates", "install updates"],
          ),
          entry(
            "Diagnostics",
            "Optionally send crash diagnostics and masked session replays to Sentry. Prompts, transcripts, card text, and local payloads are scrubbed before upload.",
            ["crash diagnostics", "masked session replays", "Sentry", "scrubbed"],
          ),
          entry(
            "Telemetry",
            "Optionally send anonymous product events and filtered technical web analytics to Statsig. Prompts, transcripts, card text, and file paths are not sent.",
            ["anonymous product events", "technical web analytics", "Statsig"],
          ),
          entry("Open source licenses", "Third-party notices for bundled dependencies.", [
            "open source",
            "licenses",
            "dependencies",
          ]),
        ],
      },
      {
        title: "Composer",
        entries: [
          entry("Thread detail", "Choose how much command output to show in threads.", [
            "Steps",
            "Steps with code commands",
            "Steps with code output",
            "Hide commands and outputs.",
            "Show commands, collapse output.",
            "Show commands and expand output.",
          ]),
          entry("Spellcheck", "Inline text correction for editable writing surfaces."),
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
          entry(
            "Cmd+Enter to send long prompts",
            "Single-line prompts still send on Enter. Multiline prompts switch to the modifier chord when this is enabled.",
            ["Ctrl+Enter to send long prompts", "modifier chord"],
          ),
          entry(
            "Queue follow-ups",
            "While a thread is running, use queue as the default submit action instead of immediate steering.",
          ),
        ],
      },
      {
        title: "Files & links",
        entries: [
          entry(
            "Copy file references as local paths",
            "Use absolute local paths in copied plain text; Page Files resolve to this Profile’s immutable .blob files.",
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
        title: "Notifications",
        entries: [
          entry("Turn completion notifications", "Set when agent alerts you that it's finished.", [
            "Enable permission notifications",
            "Enable question notifications",
            "Show alerts when notification permissions are required",
            "Show alerts when input is needed to continue",
            "Never",
            "Only when unfocused",
            "Always",
          ]),
        ],
      },
    ],
  },
  appearance: {
    title: "Appearance",
    subtitle: "Theme and typography tokens used across the app.",
    groups: [
      {
        title: "Theme",
        entries: [
          entry("Theme", "Match system mode or force a fixed theme.", ["System", "Light", "Dark"]),
          entry(
            "Reduced motion",
            "Follow the system setting, reduce interface motion, or allow full motion.",
            ["System", "On", "Off", "animation", "accessibility"],
          ),
          entry(
            "Sans font size",
            "Scales shared sans typography tokens and chat body text across the app.",
            ["Default", "font size", "sans typography"],
          ),
          entry(
            "Code font size",
            "Sets editor/code typography globally via --vscode-editor-font-size.",
            ["Default", "editor font size", "--vscode-editor-font-size"],
          ),
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
    title: "Agent",
    subtitle: "Configuration and raw config.toml settings.",
    groups: [
      {
        title: "Agent",
        messages: [
          "Open a project workspace to edit agent permissions.",
          "Could not load agent settings.",
          "Could not save permission mode.",
          "Could not save config setting.",
        ],
      },
      {
        title: "Custom config.toml settings",
        entries: [
          entry("Approval policy", "Raw `approval_policy` value for this config target.", [
            "granular",
            "untrusted",
            "on-request",
            "never",
          ]),
          entry("Sandbox settings", "Raw `sandbox_mode` value for this config target.", [
            "unset",
            "read-only",
            "workspace-write",
            "danger-full-access",
          ]),
          entry("Allow network access", "Controls `sandbox_workspace_write.network_access`.", [
            "network_access",
            "sandbox workspace write",
          ]),
          entry("config.toml", "No writable config target", [
            "Reveal",
            "writable config target",
            "configuration",
          ]),
        ],
      },
    ],
  },
  "agent-import": {
    title: "Import agent data",
    subtitle: "Copy selected history and setup into Nodex without changing the source.",
    groups: [
      {
        title: "Sources",
        entries: [
          entry("Claude Code", "Import recent conversations and supported setup.", ["CLAUDE.md"]),
          entry("Codex", "Import rollout history and safe native configuration.", [
            "CODEX_HOME",
            ".codex",
          ]),
          entry("Open Interpreter", "Import rollout history and native agent configuration.", [
            "INTERPRETER_HOME",
            ".openinterpreter",
          ]),
        ],
      },
      {
        title: "Import preview",
        messages: [
          "Choose folder",
          "Recent conversations",
          "Instructions",
          "Safe settings",
          "Skills",
          "MCP servers",
          "Provider credentials and authentication state are never imported.",
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

export const SETTINGS_SEARCH_CATALOG = {
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
  backups: {
    messages: materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.backups),
  },
} satisfies Record<string, SettingsSearchCatalogSection>;
