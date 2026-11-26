import { isRemoteSpace } from "@/lib/renderer-space";
import { TerminalShellSettingRow } from "./terminal-shell-setting-row";
import { startTransition } from "react";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { LanguageSettingRow } from "./language-setting-row";
import { useFirstRunEntry } from "@/features/first-run/first-run-state";
import { useTipsState } from "@/features/tips/tips-state";
import { CodexRequestDiagnostics } from "@/features/local-conversation/codex-request-diagnostics";
import { AppUpdateSettingRows } from "./app-update-settings-control";
import { AppComponentsSettingsSection } from "@/features/app-components/app-components-settings-section";
import { WindowsStartupSettingsRow } from "./windows-startup-settings-row";
import {
  DiagnosticsSettingRows,
  ThreadNotificationSettingControl,
  TelemetrySettingRows,
  WindowRestoreSettingControl,
} from "./workbench-settings-controls";
import { OPEN_SOURCE_LICENSES_SETTINGS_PATH } from "./workbench-settings-routes";
import { settingsMessages } from "./workbench-settings-search-catalog";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";

export function GeneralSettingsPage({ onPathChange, open }: SettingsSectionPageProps) {
  const intl = useIntl();
  const { runSetupAgain } = useFirstRunEntry();
  const tips = useTipsState();
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.generalGeneral)}
      subtitle={intl.formatMessage(settingsMessages.generalHowNodexStartsAndUpdatesHow)}
    >
      <SectionBlock id="app" title={intl.formatMessage(settingsMessages.generalApp)}>
        <LanguageSettingRow />
        <SettingRow
          label={intl.formatMessage(settingsMessages.generalRestoreWindows)}
          description={intl.formatMessage(
            settingsMessages.generalChooseWhichWindowsReopenAfterQuitting,
          )}
        >
          <WindowRestoreSettingControl />
        </SettingRow>
        <TerminalShellSettingRow />
        <WindowsStartupSettingsRow open={open} />
        <SettingRow
          label={intl.formatMessage(settingsMessages.generalShowTips)}
          description={intl.formatMessage(settingsMessages.generalShowTipsDescription)}
        >
          <NodexSwitch
            ariaLabel={intl.formatMessage(settingsMessages.generalShowTips)}
            checked={tips.state?.on ?? true}
            disabled={tips.state === null}
            onCheckedChange={(on) => void tips.setOn(on).catch(() => undefined)}
          />
        </SettingRow>
        {/* Setup connects this desktop's own Agents and Projects, which a team window never reads. */}
        {isRemoteSpace() ? null : (
          <SettingRow
            label={intl.formatMessage(settingsMessages.generalRunSetupAgain)}
            description={intl.formatMessage(settingsMessages.generalConnectAgentsAndAddProjects)}
          >
            <NodexButton variant="secondary" size="toolbar" onClick={() => void runSetupAgain()}>
              <FormattedMessage id="settings.general.runSetup.action" defaultMessage="Run setup" />
            </NodexButton>
          </SettingRow>
        )}
      </SectionBlock>

      <SectionBlock
        id="notifications"
        title={intl.formatMessage(settingsMessages.generalNotifications)}
      >
        <ThreadNotificationSettingControl open={open} />
      </SectionBlock>

      <SectionBlock id="privacy" title={intl.formatMessage(settingsMessages.generalPrivacy)}>
        <DiagnosticsSettingRows open={open} />
        <TelemetrySettingRows open={open} />
      </SectionBlock>

      <SectionBlock id="about" title={intl.formatMessage(settingsMessages.generalAbout)}>
        <AppUpdateSettingRows open={open} />
        <SettingRow
          label={intl.formatMessage(settingsMessages.generalOpenSourceLicenses)}
          description={intl.formatMessage(
            settingsMessages.generalThirdPartyNoticesForBundledDependencies,
          )}
        >
          <NodexButton
            variant="secondary"
            size="toolbar"
            onClick={() => {
              startTransition(() => {
                onPathChange(OPEN_SOURCE_LICENSES_SETTINGS_PATH);
              });
            }}
          >
            <FormattedMessage id="settings.openSourceLicenses.view" defaultMessage="View" />
          </NodexButton>
        </SettingRow>
      </SectionBlock>

      {/* Add-ons install on this desktop; a team window has none of its own. */}
      {isRemoteSpace() ? null : <AppComponentsSettingsSection />}

      <SectionBlock
        id="app-server-diagnostics"
        title={intl.formatMessage(settingsMessages.generalTroubleshooting)}
      >
        <CodexRequestDiagnostics enabled={open} />
      </SectionBlock>
    </SettingsPageSurface>
  );
}
