import { lazy } from "react";
import type { SettingsPageComponentRegistry } from "./workbench-settings-page-registry";

/** Each section loads independently of Settings navigation and every other page. */
export const SETTINGS_PAGE_COMPONENTS: SettingsPageComponentRegistry = {
  account: lazy(async () => ({
    default: (await import("@/features/nodex-account/account-settings-page")).AccountSettingsPage,
  })),
  general: lazy(async () => ({
    default: (await import("./general-settings-page")).GeneralSettingsPage,
  })),
  appearance: lazy(async () => ({
    default: (await import("./appearance-settings-page")).AppearanceSettingsPage,
  })),
  voice: lazy(async () => ({
    default: (await import("@/features/dictation/voice-settings-page")).VoiceSettingsPage,
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
  "keyboard-shortcuts": lazy(async () => ({
    default: (await import("./keyboard-shortcuts-settings-page")).KeyboardShortcutsSettingsPage,
  })),
  inbox: lazy(async () => ({
    default: (await import("@/features/inbox/inbox-settings-page")).InboxSettingsPage,
  })),
  agent: lazy(async () => ({
    default: (await import("./agent-settings-page")).AgentSettingsPage,
  })),
  import: lazy(async () => ({
    default: (await import("./conversation-import-settings-page")).ConversationImportSettingsPage,
  })),
  page: lazy(async () => ({
    default: (await import("./page-settings-page")).PageSettingsPage,
  })),
  git: lazy(async () => ({
    default: (await import("./git-settings-page")).GitSettingsPage,
  })),
  worktrees: lazy(async () => ({
    default: (await import("./worktrees-settings-page")).WorktreesSettingsPage,
  })),
  "local-environments": lazy(async () => ({
    default: (await import("./local-environments-settings-section-page"))
      .LocalEnvironmentsSettingsSectionPage,
  })),
  hooks: lazy(async () => ({
    default: (await import("./workbench-hooks-settings-page")).WorkbenchHooksSettingsPage,
  })),
  "data-controls": lazy(async () => ({
    default: (await import("./archived-chats-settings-page")).ArchivedChatsSettingsPage,
  })),
  backups: lazy(async () => ({
    default: (await import("./backups-settings-page")).BackupsSettingsPage,
  })),
};
