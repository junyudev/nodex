import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import { TaskShorthandPagePromotionSettingControl } from "./workbench-settings-controls";

export function PageSettingsPage({
  onTaskShorthandPagePromotionEnabledChange,
  taskShorthandPagePromotionEnabled,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.pageTitle)}
      subtitle={intl.formatMessage(settingsMessages.pagePageCreationAndImportBehavior)}
    >
      <SectionBlock id="block-import" title={intl.formatMessage(settingsMessages.pageBlockImport)}>
        <SettingRow
          label={intl.formatMessage(settingsMessages.pageTaskShorthandLabel)}
          description={intl.formatMessage(settingsMessages.pageTaskShorthandDescription)}
        >
          <TaskShorthandPagePromotionSettingControl
            value={taskShorthandPagePromotionEnabled}
            onChange={onTaskShorthandPagePromotionEnabledChange}
          />
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}
