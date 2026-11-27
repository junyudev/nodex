import { useIntl } from "@/lib/i18n";
import { NodexSegmentedControl } from "@/components/ui/segmented-control";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import { useMiniSettings } from "@/lib/use-mini-settings";
import { resolveCommandShortcutPresentation } from "../../../shared/command-keybindings";
import type { MiniResting } from "../../../shared/mini";
import { NodexSettingsRow } from "../ui/settings";
import { settingsMessages } from "./workbench-settings-search-catalog";

type MiniChoice = MiniResting | "off";

/**
 * Whether Mini shows over other apps and, if so, whether only while something is happening or
 * always. Its shortcut opens it whatever this says; the account menu shows and hides it too.
 */
export function MiniSettingRow() {
  const intl = useIntl();
  const { settings, loading, change } = useMiniSettings();
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
                defaultMessage: "Show your chats over other apps. {shortcut} opens Mini anytime.",
              },
              { shortcut },
            )
          : intl.formatMessage(settingsMessages.generalMiniDescription)
      }
    >
      <NodexSegmentedControl<MiniChoice>
        ariaLabel={label}
        disabled={loading}
        value={settings.shown ? settings.resting : "off"}
        onChange={(choice) =>
          change(choice === "off" ? { shown: false } : { shown: true, resting: choice })
        }
        options={[
          {
            value: "off",
            label: intl.formatMessage({ id: "settings.mini.off", defaultMessage: "Off" }),
          },
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
        ]}
      />
    </NodexSettingsRow>
  );
}
