import { useIntl } from "@/lib/i18n";
import { NodexSegmentedControl } from "@/components/ui/segmented-control";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import { useMiniVisibility } from "@/lib/use-mini-visibility";
import { resolveCommandShortcutPresentation } from "../../../shared/command-keybindings";
import type { MiniVisibility } from "../../../shared/mini";
import { NodexSettingsRow } from "../ui/settings";
import { settingsMessages } from "./workbench-settings-search-catalog";

/** When Mini rests over other apps; its shortcut opens it whatever this says. */
export function MiniVisibilitySettingRow() {
  const intl = useIntl();
  const mini = useMiniVisibility();
  const keymap = useCommandKeymapState().data;
  const shortcut = keymap ? resolveCommandShortcutPresentation(keymap, "openMini")?.label : null;
  const label = intl.formatMessage(settingsMessages.generalMini);
  return (
    <NodexSettingsRow
      label={label}
      description={
        shortcut
          ? intl.formatMessage(
              {
                id: "settings.mini.descriptionWithShortcut",
                defaultMessage:
                  "When Mini shows your chats over other apps. {shortcut} opens it anytime.",
              },
              { shortcut },
            )
          : intl.formatMessage(settingsMessages.generalMiniDescription)
      }
    >
      <NodexSegmentedControl<MiniVisibility>
        ariaLabel={label}
        value={mini.visibility}
        onChange={mini.setVisibility}
        options={[
          {
            value: "active",
            label: intl.formatMessage({
              id: "settings.mini.active",
              defaultMessage: "When active",
            }),
          },
          {
            value: "always",
            label: intl.formatMessage({ id: "settings.mini.always", defaultMessage: "Always" }),
          },
          {
            value: "on-demand",
            label: intl.formatMessage({
              id: "settings.mini.onDemand",
              defaultMessage: "On demand",
            }),
          },
        ]}
      />
    </NodexSettingsRow>
  );
}
