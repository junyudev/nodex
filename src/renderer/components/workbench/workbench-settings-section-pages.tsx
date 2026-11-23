import { lazy } from "react";
import type { SettingsPageComponentRegistry } from "./workbench-settings-page-registry";

/** Each section loads independently of Settings navigation and every other page. */
export const SETTINGS_PAGE_COMPONENTS: SettingsPageComponentRegistry = {
  account: lazy(async () => ({
    default: (await import("@/features/nodex-account/account-settings-page")).AccountSettingsPage,
  })),
  remote: lazy(async () => ({
    default: (await import("@/features/spaces/spaces-settings-page")).RemoteSettingsPage,
  })),
  general: lazy(async () => ({
    default: (await import("./general-settings-page")).GeneralSettingsPage,
  })),
  appearance: lazy(async () => ({
    default: (await import("./appearance-settings-page")).AppearanceSettingsPage,
  })),
  editor: lazy(async () => ({
    default: (await import("./editor-settings-page")).EditorSettingsPage,
  })),
  voice: lazy(async () => ({
    default: (await import("@/features/dictation/voice-settings-page")).VoiceSettingsPage,
  })),
  "keyboard-shortcuts": lazy(async () => ({
    default: (await import("./keyboard-shortcuts-settings-page")).KeyboardShortcutsSettingsPage,
  })),
  agent: lazy(async () => ({
    default: (await import("./agent-settings-page")).AgentSettingsPage,
  })),
  chats: lazy(async () => ({
    default: (await import("./chats-settings-page")).ChatsSettingsPage,
  })),
  inbox: lazy(async () => ({
    default: (await import("@/features/inbox/inbox-settings-page")).InboxSettingsPage,
  })),
  plugins: lazy(async () => ({
    default: (await import("@/features/plugins/view/plugins-settings-page"))
      .PluginsSettingsSectionPage,
  })),
  browser: lazy(async () => ({
    default: (await import("@/features/browser-sidebar/browser-settings-pages"))
      .BrowserSettingsPage,
  })),
  "computer-use": lazy(async () => ({
    default: (await import("./computer-use-settings-page")).ComputerUseSettingsPage,
  })),
  github: lazy(async () => ({
    default: (await import("./github-settings-page")).GitHubSettingsPage,
  })),
  git: lazy(async () => ({
    default: (await import("./git-settings-page")).GitSettingsPage,
  })),
  worktrees: lazy(async () => ({
    default: (await import("./worktrees-settings-page")).WorktreesSettingsPage,
  })),
  import: lazy(async () => ({
    default: (await import("./conversation-import-settings-page")).ConversationImportSettingsPage,
  })),
  "archived-chats": lazy(async () => ({
    default: (await import("./archived-chats-settings-page")).ArchivedChatsSettingsPage,
  })),
  backups: lazy(async () => ({
    default: (await import("./backups-settings-page")).BackupsSettingsPage,
  })),
};
