import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import type { ComponentType } from "react";
import { buildSettingsSearchResults, type SettingsSearchContext } from "@/lib/settings-search";
import { scoreSettingsQueryMatch } from "@/lib/settings-search-score";
import {
  ArchiveIcon,
  HooksIcon,
  InboxIcon,
  KeyboardShortcutsIcon,
  MicIcon,
  PageIcon,
  PluginsIcon,
  SettingsAgentIcon,
  SettingsAppearanceIcon,
  SettingsBrowserIcon,
  SettingsComputerUseIcon,
  SettingsGeneralIcon,
  SettingsGitIcon,
  SettingsImportIcon,
  SettingsLocalEnvironmentsIcon,
  SettingsWorktreeIcon,
  SlashModelIcon,
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
  | "spaces"
  | "github"
  | "account"
  | "general-settings"
  | "agent-import"
  | "appearance"
  | "voice"
  | "agent"
  | "models"
  | "keyboard-shortcuts"
  | "inbox-settings"
  | "plugins-settings"
  | "browser"
  | "computer-use"
  | "hooks-settings"
  | "git"
  | "local-environments"
  | "worktrees"
  | "page"
  | "data-controls"
  | "backups";

export type SettingsSectionGroupKey =
  | "personal"
  | "agents"
  | "integrations"
  | "coding"
  | "workspace"
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

export const SETTINGS_SECTION_GROUP_LABELS = defineMessages({
  agents: { id: "settings.navigation.group.agents", defaultMessage: "AI" },
  coding: { id: "settings.navigation.group.coding", defaultMessage: "Coding" },
  data: { id: "settings.navigation.group.data", defaultMessage: "Data & recovery" },
  integrations: { id: "settings.navigation.group.integrations", defaultMessage: "Integrations" },
  personal: { id: "settings.navigation.group.personal", defaultMessage: "Personal" },
  workspace: { id: "settings.navigation.group.workspace", defaultMessage: "Workspace" },
});

export const SETTINGS_SECTION_GROUP_ORDER: readonly SettingsSectionGroupKey[] = [
  "personal",
  "agents",
  "integrations",
  "coding",
  "workspace",
  "data",
];

export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "spaces",
    labelMessage: settingsMessages.spacesTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "spaces",
    icon: SettingsGeneralIcon,
    groupKey: "workspace",
    searchMessages: [
      "Spaces",
      "Remote access",
      "Devices",
      "Link a device",
      "Revoke",
      "People",
      "Invite someone",
      "Join a Space",
      "Leave",
      "Certificate fingerprint",
      "One-time code",
    ],
  },
  {
    id: "account",
    labelMessage: settingsMessages.accountTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "account",
    icon: UserRound,
    groupKey: "personal",
    get searchMessages() {
      return settingsSearchSourceMessages("account");
    },
  },
  {
    id: "general-settings",
    labelMessage: settingsMessages.generalGeneral,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "general",
    icon: SettingsGeneralIcon,
    groupKey: "personal",
    get searchMessages() {
      return settingsSearchSourceMessages("general-settings");
    },
  },
  {
    id: "appearance",
    labelMessage: settingsMessages.appearanceTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "appearance",
    icon: SettingsAppearanceIcon,
    groupKey: "personal",
    get searchMessages() {
      return settingsSearchSourceMessages("appearance");
    },
  },
  {
    id: "voice",
    labelMessage: settingsMessages.voiceTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "voice",
    icon: MicIcon,
    groupKey: "personal",
    get searchMessages() {
      return settingsSearchSourceMessages("voice");
    },
  },
  {
    id: "keyboard-shortcuts",
    labelMessage: settingsMessages.keyboardShortcutsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "keyboard-shortcuts",
    icon: KeyboardShortcutsIcon,
    groupKey: "personal",
    get searchMessages() {
      return settingsSearchSourceMessages("keyboard-shortcuts");
    },
  },
  {
    id: "agent",
    labelMessage: settingsMessages.agentsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "agent",
    icon: SettingsAgentIcon,
    groupKey: "agents",
    get searchMessages() {
      return settingsSearchSourceMessages("agent");
    },
    searchTerms: ({ activeProjectName }) => (activeProjectName ? [activeProjectName] : []),
  },
  {
    id: "models",
    labelMessage: settingsMessages.modelsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "models",
    icon: SlashModelIcon,
    groupKey: "agents",
    get searchMessages() {
      return settingsSearchSourceMessages("models");
    },
  },
  {
    id: "agent-import",
    labelMessage: settingsMessages.conversationImportTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "import",
    icon: SettingsImportIcon,
    groupKey: "agents",
    get searchMessages() {
      return settingsSearchSourceMessages("agent-import");
    },
  },
  {
    id: "hooks-settings",
    labelMessage: settingsMessages.hooksTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "hooks",
    icon: HooksIcon,
    groupKey: "agents",
    get searchMessages() {
      return settingsSearchSourceMessages("hooks-settings");
    },
  },
  {
    id: "plugins-settings",
    labelMessage: settingsMessages.pluginsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "plugins",
    icon: PluginsIcon,
    groupKey: "integrations",
    get searchMessages() {
      return settingsSearchSourceMessages("plugins-settings");
    },
  },
  {
    id: "browser",
    labelMessage: settingsMessages.browserTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "browser",
    icon: SettingsBrowserIcon,
    groupKey: "integrations",
    get searchMessages() {
      return settingsSearchSourceMessages("browser");
    },
  },
  {
    id: "computer-use",
    labelMessage: settingsMessages.computerUseTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "computer-use",
    visibleWhen: () => readSettingsHostPresentation().computerUse,
    icon: SettingsComputerUseIcon,
    groupKey: "integrations",
    get searchMessages() {
      return settingsSearchSourceMessages("computer-use");
    },
  },
  {
    id: "github",
    labelMessage: settingsMessages.githubTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
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
  },
  {
    id: "git",
    labelMessage: settingsMessages.gitTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "git",
    icon: SettingsGitIcon,
    groupKey: "coding",
    get searchMessages() {
      return settingsSearchSourceMessages("git");
    },
  },
  {
    id: "local-environments",
    labelMessage: settingsMessages.environmentsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "local-environments",
    icon: SettingsLocalEnvironmentsIcon,
    groupKey: "coding",
    get searchMessages() {
      return settingsSearchSourceMessages("local-environments");
    },
    searchTerms: ({ projectNames, activeProjectName }) =>
      activeProjectName ? [...projectNames, activeProjectName] : projectNames,
  },
  {
    id: "worktrees",
    labelMessage: settingsMessages.worktreesTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "worktrees",
    icon: SettingsWorktreeIcon,
    groupKey: "coding",
    get searchMessages() {
      return settingsSearchSourceMessages("worktrees");
    },
  },
  {
    id: "page",
    labelMessage: settingsMessages.pageTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "page",
    icon: PageIcon,
    groupKey: "workspace",
    get searchMessages() {
      return settingsSearchSourceMessages("page");
    },
  },
  {
    id: "inbox-settings",
    labelMessage: settingsMessages.inboxTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "inbox",
    icon: InboxIcon,
    groupKey: "workspace",
    get searchMessages() {
      return settingsSearchSourceMessages("inbox-settings");
    },
  },
  {
    id: "data-controls",
    labelMessage: settingsMessages.archivedChatsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "data-controls",
    icon: ArchiveIcon,
    groupKey: "data",
    get searchMessages() {
      return settingsSearchSourceMessages("data-controls");
    },
  },
  {
    id: "backups",
    labelMessage: settingsMessages.backupsTitle,
    get label() {
      return getIntl().formatMessage(this.labelMessage);
    },
    pageKey: "backups",
    icon: ArchiveIcon,
    groupKey: "data",
    get searchMessages() {
      return settingsSearchSourceMessages("backups");
    },
  },
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
