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
  return (
    <SettingsPageSurface title="Pages" subtitle="Page creation and import behavior.">
      <SectionBlock id="block-import" title="Block import">
        <SettingRow
          label="Task shorthand on Block → Page"
          description="Interpret task metadata when a Block is promoted into a Page. 1XL(ui, unclear) Fix import → Fix import · P1 · XL · ui · unclear"
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
