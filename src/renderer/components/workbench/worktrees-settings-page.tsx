import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { NodexSettingsPageSurface as SettingsPageSurface } from "../ui/settings";
import { ManagedWorktreesSettingControl } from "./managed-worktrees-settings-control";

export function WorktreesSettingsPage({ open, onOpenThread }: SettingsSectionPageProps) {
  return (
    <SettingsPageSurface title="Worktrees">
      <ManagedWorktreesSettingControl open={open} onOpenThread={onOpenThread} />
    </SettingsPageSurface>
  );
}
