import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
import type { CodexAccentPreset } from "@/lib/codex-theme-variant";

const accentPresetMessages = defineMessages({
  default: { id: "settings.appearance.accent.default", defaultMessage: "Default" },
  blue: { id: "settings.appearance.accent.blue", defaultMessage: "Blue" },
  green: { id: "settings.appearance.accent.green", defaultMessage: "Green" },
  yellow: { id: "settings.appearance.accent.yellow", defaultMessage: "Yellow" },
  pink: { id: "settings.appearance.accent.pink", defaultMessage: "Pink" },
  orange: { id: "settings.appearance.accent.orange", defaultMessage: "Orange" },
  purple: { id: "settings.appearance.accent.purple", defaultMessage: "Purple" },
  black: { id: "settings.appearance.accent.black", defaultMessage: "Black" },
  white: { id: "settings.appearance.accent.white", defaultMessage: "White" },
});

export function presentAccentPresetLabel(
  name: CodexAccentPreset,
  appearance: "light" | "dark",
  intl: IntlShape = getIntl(),
): string {
  return intl.formatMessage(
    accentPresetMessages[name === "black" && appearance === "dark" ? "white" : name],
  );
}
