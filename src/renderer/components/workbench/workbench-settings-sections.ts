import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import type { ComponentType } from "react";
import { buildSettingsSearchResults, type SettingsSearchContext } from "@/lib/settings-search";
import { scoreSettingsQueryMatch } from "@/lib/settings-search-score";
import {
  ArchiveIcon,
  InboxIcon,
  KeyboardShortcutsIcon,
  MicIcon,
  PluginsIcon,
  SettingsAgentsIcon,
  SettingsAppearanceIcon,
  SettingsBackupsIcon,
  SettingsBrowserIcon,
  SettingsChatsIcon,
  SettingsComputerUseIcon,
  SettingsEditorIcon,
  SettingsGeneralIcon,
  SettingsGitIcon,
  SettingsImportIcon,
  SettingsRemoteIcon,
  SettingsWorktreeIcon,
} from "../shared/icons";
import { UserRound } from "../shared/icons/generic-icons";
import { WebsiteGitHubIcon } from "../shared/icons/website-icons";
import {
  settingsMessages,
  settingsSearchAnchor,
  settingsSearchIndex,
  settingsSearchSourceMessages,
} from "./workbench-settings-search-catalog";
import type { SettingsPageKey } from "./workbench-settings-page-registry";

export type SettingsSectionId =
  | "account"
  | "remote"
  | "general-settings"
  | "appearance"
  | "editor"
  | "voice"
  | "keyboard-shortcuts"
  | "agent"
  | "chats"
  | "inbox-settings"
  | "plugins-settings"
  | "browser"
  | "computer-use"
  | "github"
  | "git"
  | "worktrees"
  | "import"
  | "archived-chats"
  | "backups";

/**
 * Each group answers one question: who you are and where Nodex reaches you (no heading), the app
 * on this computer, who does the work and how it works with you, what Agents can reach, where code
 * work happens, and the data you bring in or keep.
 */
export type SettingsSectionGroupKey =
  | "account"
  | "app"
  | "agents"
  | "integrations"
  | "coding"
  | "data";

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  labelMessage: MessageDescriptor;
  pageKey: SettingsPageKey;
  icon: ComponentType<{ className?: string }>;
  groupKey: SettingsSectionGroupKey;
  searchMessages: readonly string[];
  searchTerms?: (context: SettingsSearchContext) => readonly string[];
  disabled?: boolean;
  externalUrl?: string;
  visibleWhen?: () => boolean;
}

/** The account group leads the rail without a heading. */
export const SETTINGS_SECTION_GROUP_LABELS: Readonly<
  Record<SettingsSectionGroupKey, MessageDescriptor | null>
> = {
  account: null,
  ...defineMessages({
    app: { id: "settings.navigation.group.app", defaultMessage: "App" },
    agents: { id: "settings.navigation.group.agents", defaultMessage: "Agents" },
    integrations: { id: "settings.navigation.group.integrations", defaultMessage: "Integrations" },
    coding: { id: "settings.navigation.group.coding", defaultMessage: "Coding" },
    data: { id: "settings.navigation.group.data", defaultMessage: "Data" },
  }),
};

export const SETTINGS_SECTION_GROUP_ORDER: readonly SettingsSectionGroupKey[] = [
  "account",
  "app",
  "agents",
  "integrations",
  "coding",
  "data",
];

function section(
  definition: Omit<SettingsSectionDefinition, "label" | "searchMessages"> & {
    readonly searchMessages?: readonly string[];
  },
): SettingsSectionDefinition {
  return {
    ...definition,
    get label() {
      return getIntl().formatMessage(definition.labelMessage);
    },
    get searchMessages() {
      return definition.searchMessages ?? settingsSearchSourceMessages(definition.id);
    },
  };
}

/** The rail, in order. */
export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  section({
    id: "account",
    labelMessage: settingsMessages.accountTitle,
    pageKey: "account",
    icon: UserRound,
    groupKey: "account",
  }),
  section({
    id: "remote",
    labelMessage: settingsMessages.remoteTitle,
    pageKey: "remote",
    icon: SettingsRemoteIcon,
    groupKey: "account",
  }),
  section({
    id: "general-settings",
    labelMessage: settingsMessages.generalGeneral,
    pageKey: "general",
    icon: SettingsGeneralIcon,
    groupKey: "app",
  }),
  section({
    id: "appearance",
    labelMessage: settingsMessages.appearanceTitle,
    pageKey: "appearance",
    icon: SettingsAppearanceIcon,
    groupKey: "app",
  }),
  section({
    id: "editor",
    labelMessage: settingsMessages.editorTitle,
    pageKey: "editor",
    icon: SettingsEditorIcon,
    groupKey: "app",
  }),
  section({
    id: "voice",
    labelMessage: settingsMessages.voiceTitle,
    pageKey: "voice",
    icon: MicIcon,
    groupKey: "app",
  }),
  section({
    id: "keyboard-shortcuts",
    labelMessage: settingsMessages.keyboardShortcutsTitle,
    pageKey: "keyboard-shortcuts",
    icon: KeyboardShortcutsIcon,
    groupKey: "app",
  }),
  section({
    id: "agent",
    labelMessage: settingsMessages.agentsTitle,
    pageKey: "agent",
    icon: SettingsAgentsIcon,
    groupKey: "agents",
    searchTerms: ({ activeProjectName }) => (activeProjectName ? [activeProjectName] : []),
  }),
  section({
    id: "chats",
    labelMessage: settingsMessages.chatsTitle,
    pageKey: "chats",
    icon: SettingsChatsIcon,
    groupKey: "agents",
  }),
  section({
    id: "inbox-settings",
    labelMessage: settingsMessages.inboxTitle,
    pageKey: "inbox",
    icon: InboxIcon,
    groupKey: "agents",
  }),
  section({
    id: "plugins-settings",
    labelMessage: settingsMessages.pluginsTitle,
    pageKey: "plugins",
    icon: PluginsIcon,
    groupKey: "integrations",
  }),
  section({
    id: "browser",
    labelMessage: settingsMessages.browserTitle,
    pageKey: "browser",
    icon: SettingsBrowserIcon,
    groupKey: "integrations",
  }),
  section({
    id: "computer-use",
    labelMessage: settingsMessages.computerUseTitle,
    pageKey: "computer-use",
    visibleWhen: () => readSettingsHostPresentation().computerUse,
    icon: SettingsComputerUseIcon,
    groupKey: "integrations",
  }),
  section({
    id: "github",
    labelMessage: settingsMessages.githubTitle,
    pageKey: "github",
    icon: WebsiteGitHubIcon,
    groupKey: "integrations",
    searchMessages: [
      "GitHub",
      "Sources",
      "Assigned to me",
      "Review requests",
      "Mentions",
      "Repositories",
    ],
  }),
  section({
    id: "git",
    labelMessage: settingsMessages.gitTitle,
    pageKey: "git",
    icon: SettingsGitIcon,
    groupKey: "coding",
  }),
  section({
    id: "worktrees",
    labelMessage: settingsMessages.worktreesTitle,
    pageKey: "worktrees",
    icon: SettingsWorktreeIcon,
    groupKey: "coding",
    searchTerms: ({ projectNames, activeProjectName }) =>
      activeProjectName ? [...projectNames, activeProjectName] : projectNames,
  }),
  section({
    id: "import",
    labelMessage: settingsMessages.importTitle,
    pageKey: "import",
    icon: SettingsImportIcon,
    groupKey: "data",
  }),
  section({
    id: "archived-chats",
    labelMessage: settingsMessages.archivedChatsTitle,
    pageKey: "archived-chats",
    icon: ArchiveIcon,
    groupKey: "data",
  }),
  section({
    id: "backups",
    labelMessage: settingsMessages.backupsTitle,
    pageKey: "backups",
    icon: SettingsBackupsIcon,
    groupKey: "data",
  }),
];

export function resolveVisibleSettingsSections(): SettingsSectionDefinition[] {
  return SETTINGS_SECTIONS.filter((section) => section.visibleWhen?.() ?? true);
}

export function settingsCommandId(sectionId: SettingsSectionId): string {
  return `settings:${sectionId}`;
}

/**
 * Where a Command K Settings command opens: its visible, enabled section, at the group or Agent the
 * query that found it names, exactly as Settings search lands.
 */
export function resolveSettingsCommandTarget(
  commandId: string,
  query: string,
): { readonly sectionId: SettingsSectionId; readonly anchor?: string } | null {
  const section = resolveVisibleSettingsSections().find(
    (candidate) => settingsCommandId(candidate.id) === commandId,
  );
  if (!section || section.disabled) return null;
  const anchor = settingsSearchAnchor(section.id, query);
  return anchor ? { sectionId: section.id, anchor } : { sectionId: section.id };
}

export function resolveDefaultSettingsSectionId(
  sections: readonly SettingsSectionDefinition[] = resolveVisibleSettingsSections(),
): SettingsSectionId {
  return (
    sections.find((section) => section.id === "general-settings")?.id ??
    sections[0]?.id ??
    "general-settings"
  );
}

export function searchWorkbenchSettings(
  sections: readonly SettingsSectionDefinition[],
  context: SettingsSearchContext,
  query: string,
  intl: IntlShape,
) {
  if (!query.trim()) return [];
  const indexes = new Map<SettingsSectionId, Map<string, string>>();
  const targets = sections.flatMap((section) => {
    if (section.disabled || section.externalUrl != null) return [];
    const panelLabel = intl.formatMessage(section.labelMessage);
    const index = settingsSearchIndex(section.id, intl);
    for (const message of section.searchMessages) {
      if (!index.has(message)) index.set(message, message);
    }
    const sourceLabel = String(section.labelMessage.defaultMessage);
    index.set(sourceLabel, panelLabel);
    indexes.set(section.id, index);
    const matchLabel =
      scoreSettingsQueryMatch(sourceLabel, query) > scoreSettingsQueryMatch(panelLabel, query)
        ? sourceLabel
        : panelLabel;
    return [
      {
        sectionId: section.id,
        panelLabel: matchLabel,
        messageTexts: [...index.keys()],
        termTexts: section.searchTerms?.(context) ?? [],
      },
    ];
  });

  return buildSettingsSearchResults({
    query,
    targets,
    visibleSectionIds: sections.map((section) => section.id),
  }).map((result) => ({
    ...result,
    label: indexes.get(result.sectionId)?.get(result.label) ?? result.label,
    panelLabel: indexes.get(result.sectionId)?.get(result.panelLabel) ?? result.panelLabel,
  }));
}
