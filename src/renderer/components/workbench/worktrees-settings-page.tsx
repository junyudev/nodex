import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { NodexSettingsPageSurface as SettingsPageSurface } from "../ui/settings";
import { ManagedWorktreesSettingControl } from "./managed-worktrees-settings-control";

export function WorktreesSettingsPage({ open, onOpenThread }: SettingsSectionPageProps) {
  const intl = useIntl();
  return (
    <SettingsPageSurface title={intl.formatMessage(settingsMessages.worktreesTitle)}>
      <ManagedWorktreesSettingControl open={open} onOpenThread={onOpenThread} />
    </SettingsPageSurface>
  );
}
