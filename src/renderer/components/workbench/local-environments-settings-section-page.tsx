import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { NodexSettingsPageSurface as SettingsPageSurface } from "../ui/settings";
import { LocalEnvironmentsSettingsPage } from "./local-environments-settings-page";

export function LocalEnvironmentsSettingsSectionPage({
  activeProjectId,
  initialLocalEnvironmentConfigPath,
  initialLocalEnvironmentProjectId,
  onRequestProjectPickerOpen,
  open,
  projects,
}: SettingsSectionPageProps) {
  return (
    <LocalEnvironmentsSettingsPage
      open={open}
      active
      projects={projects}
      activeProjectId={activeProjectId}
      initialProjectId={initialLocalEnvironmentProjectId}
      initialConfigPath={initialLocalEnvironmentConfigPath}
      onAddProject={onRequestProjectPickerOpen}
      renderShell={({ title, subtitle, backSlot, action, children }) => (
        <SettingsPageSurface title={title} subtitle={subtitle} backSlot={backSlot} action={action}>
          {children}
        </SettingsPageSurface>
      )}
    />
  );
}
