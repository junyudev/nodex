import type { ComponentType } from "react";
import type { SettingsSearchContext } from "@/lib/settings-search";
import {
  ArchiveIcon,
  HooksIcon,
  InboxIcon,
  KeyboardShortcutsIcon,
  MicIcon,
  PageIcon,
  SettingsAgentIcon,
  SettingsAppearanceIcon,
  SettingsBrowserIcon,
  SettingsComputerUseIcon,
  SettingsGeneralIcon,
  SettingsGitIcon,
  SettingsImportIcon,
  SettingsLocalEnvironmentsIcon,
  SettingsWorktreeIcon,
} from "../shared/icons";
import { UserRound } from "../shared/icons/generic-icons";
import { SETTINGS_SEARCH_CATALOG, settingsSearchAnchor } from "./workbench-settings-search-catalog";
import type { SettingsPageKey } from "./workbench-settings-page-registry";

export type SettingsSectionId =
  | "account"
  | "general-settings"
  | "agent-import"
  | "appearance"
  | "voice"
  | "agent"
  | "keyboard-shortcuts"
  | "inbox-settings"
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
  pageKey: SettingsPageKey;
  icon: ComponentType<{ className?: string }>;
  groupKey: SettingsSectionGroupKey;
  searchMessages: readonly string[];
  searchTerms?: (context: SettingsSearchContext) => readonly string[];
  disabled?: boolean;
  externalUrl?: string;
  placeholderKind?: "unavailable" | "external";
  visibleWhen?: () => boolean;
}

export const SETTINGS_SECTION_GROUP_LABELS: Record<SettingsSectionGroupKey, string> = {
  agents: "AI",
  coding: "Coding",
  data: "Data & recovery",
  integrations: "Integrations",
  personal: "Personal",
  workspace: "Workspace",
};

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
    id: "account",
    label: "Account",
    pageKey: "account",
    icon: UserRound,
    groupKey: "personal",
    searchMessages: SETTINGS_SEARCH_CATALOG.account.messages,
  },
  {
    id: "general-settings",
    label: "General",
    pageKey: "general",
    icon: SettingsGeneralIcon,
    groupKey: "personal",
    searchMessages: SETTINGS_SEARCH_CATALOG["general-settings"].messages,
  },
  {
    id: "appearance",
    label: "Appearance",
    pageKey: "appearance",
    icon: SettingsAppearanceIcon,
    groupKey: "personal",
    searchMessages: SETTINGS_SEARCH_CATALOG.appearance.messages,
  },
  {
    id: "voice",
    label: "Voice",
    pageKey: "voice",
    icon: MicIcon,
    groupKey: "personal",
    searchMessages: SETTINGS_SEARCH_CATALOG.voice.messages,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard shortcuts",
    pageKey: "keyboard-shortcuts",
    icon: KeyboardShortcutsIcon,
    groupKey: "personal",
    searchMessages: SETTINGS_SEARCH_CATALOG["keyboard-shortcuts"].messages,
  },
  {
    id: "agent",
    label: "Agents",
    pageKey: "agent",
    icon: SettingsAgentIcon,
    groupKey: "agents",
    searchMessages: SETTINGS_SEARCH_CATALOG.agent.messages,
    searchTerms: SETTINGS_SEARCH_CATALOG.agent.searchTerms,
  },
  {
    id: "agent-import",
    label: "Conversations",
    pageKey: "import",
    icon: SettingsImportIcon,
    groupKey: "agents",
    searchMessages: SETTINGS_SEARCH_CATALOG["agent-import"].messages,
  },
  {
    id: "hooks-settings",
    label: "Hooks",
    pageKey: "hooks",
    icon: HooksIcon,
    groupKey: "agents",
    searchMessages: SETTINGS_SEARCH_CATALOG["hooks-settings"].messages,
  },
  {
    id: "browser",
    label: "Browser",
    pageKey: "browser",
    icon: SettingsBrowserIcon,
    groupKey: "integrations",
    searchMessages: SETTINGS_SEARCH_CATALOG.browser.messages,
  },
  {
    id: "computer-use",
    label: "Computer use",
    pageKey: "computer-use",
    icon: SettingsComputerUseIcon,
    groupKey: "integrations",
    searchMessages: SETTINGS_SEARCH_CATALOG["computer-use"].messages,
  },
  {
    id: "git",
    label: "Git",
    pageKey: "git",
    icon: SettingsGitIcon,
    groupKey: "coding",
    searchMessages: SETTINGS_SEARCH_CATALOG.git.messages,
  },
  {
    id: "local-environments",
    label: "Environments",
    pageKey: "local-environments",
    icon: SettingsLocalEnvironmentsIcon,
    groupKey: "coding",
    searchMessages: SETTINGS_SEARCH_CATALOG["local-environments"].messages,
    searchTerms: SETTINGS_SEARCH_CATALOG["local-environments"].searchTerms,
  },
  {
    id: "worktrees",
    label: "Worktrees",
    pageKey: "worktrees",
    icon: SettingsWorktreeIcon,
    groupKey: "coding",
    searchMessages: SETTINGS_SEARCH_CATALOG.worktrees.messages,
  },
  {
    id: "page",
    label: "Pages",
    pageKey: "page",
    icon: PageIcon,
    groupKey: "workspace",
    searchMessages: SETTINGS_SEARCH_CATALOG.page.messages,
  },
  {
    id: "inbox-settings",
    label: "Inbox",
    pageKey: "inbox",
    icon: InboxIcon,
    groupKey: "workspace",
    searchMessages: SETTINGS_SEARCH_CATALOG["inbox-settings"].messages,
  },
  {
    id: "data-controls",
    label: "Data controls",
    pageKey: "data-controls",
    icon: ArchiveIcon,
    groupKey: "data",
    searchMessages: SETTINGS_SEARCH_CATALOG["data-controls"].messages,
  },
  {
    id: "backups",
    label: "Backups",
    pageKey: "backups",
    icon: ArchiveIcon,
    groupKey: "data",
    searchMessages: SETTINGS_SEARCH_CATALOG.backups.messages,
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
