import { applyCodexDocumentTheme } from "../lib/codex-theme-variant";
import { readAccentColorPreferences } from "../lib/theme-preferences";

/** Application roles must resolve before components mount or measure their styles. */
export function initializeApplicationAppearance(): void {
  const variant = document.documentElement.classList.contains("dark") ? "dark" : "light";
  applyCodexDocumentTheme(document, variant, readAccentColorPreferences());
}
