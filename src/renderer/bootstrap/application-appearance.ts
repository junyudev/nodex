import { applyCodexThemeVariant } from "../lib/codex-theme-variant";
import { readAccentColorPreferences, resolveAccentColorPreference } from "../lib/theme-preferences";

/** Application roles must resolve before components mount or measure their styles. */
export function initializeApplicationAppearance(): void {
  const root = document.documentElement;
  const variant = root.classList.contains("dark") ? "dark" : "light";
  applyCodexThemeVariant(
    root,
    variant,
    document.body,
    resolveAccentColorPreference(readAccentColorPreferences(), variant),
  );
}
