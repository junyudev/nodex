import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { NodexSettingsPageSurface as SettingsPageSurface, NodexSettingsTabs } from "../ui/settings";
import { ManagedWorktreesSettingControl } from "./managed-worktrees-settings-control";
import { LocalEnvironmentsSettingsPage } from "./local-environments-settings-page";
import {
  buildSettingsPath,
  ENVIRONMENTS_SETTINGS_ANCHOR,
  ENVIRONMENTS_SETTINGS_PATH,
} from "./workbench-settings-routes";

type WorktreesTab = "worktrees" | "environments";

/**
 * Settings › Worktrees: the worktrees Nodex manages, and on its Environments tab how each
 * Project sets them up.
 */
export function WorktreesSettingsPage({
  activeProjectId,
  initialLocalEnvironmentConfigPath,
  initialLocalEnvironmentProjectId,
  onOpenThread,
  onPathChange,
  onRequestProjectPickerOpen,
  open,
  projects,
  settingsAnchor,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  const tab: WorktreesTab =
    settingsAnchor === ENVIRONMENTS_SETTINGS_ANCHOR ? "environments" : "worktrees";
  const title = intl.formatMessage(settingsMessages.worktreesTitle);
  const tabs = (
    <NodexSettingsTabs
      label={title}
      tabs={[
        { id: "worktrees", label: title },
        { id: "environments", label: intl.formatMessage(settingsMessages.environmentsTitle) },
      ]}
      selected={tab}
      onSelect={(next) =>
        onPathChange(
          next === "environments" ? ENVIRONMENTS_SETTINGS_PATH : buildSettingsPath("worktrees"),
        )
      }
    />
  );

  if (tab === "environments")
    return (
      <LocalEnvironmentsSettingsPage
        open={open}
        active
        projects={projects}
        activeProjectId={activeProjectId}
        initialProjectId={initialLocalEnvironmentProjectId}
        initialConfigPath={initialLocalEnvironmentConfigPath}
        onAddProject={onRequestProjectPickerOpen}
        renderShell={(shell) =>
          // A Project's environment is a detail page with its own heading and way back.
          shell.backSlot ? (
            <SettingsPageSurface
              title={shell.title}
              subtitle={shell.subtitle}
              backSlot={shell.backSlot}
              action={shell.action}
            >
              {shell.children}
            </SettingsPageSurface>
          ) : (
            <SettingsPageSurface title={title} subtitle={shell.subtitle} action={shell.action}>
              {tabs}
              {shell.children}
            </SettingsPageSurface>
          )
        }
      />
    );

  return (
    <SettingsPageSurface
      title={title}
      subtitle={intl.formatMessage(settingsMessages.worktreesSubtitle)}
    >
      {tabs}
      <ManagedWorktreesSettingControl open={open} onOpenThread={onOpenThread} />
    </SettingsPageSurface>
  );
}
