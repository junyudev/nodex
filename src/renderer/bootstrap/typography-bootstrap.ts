import {
  applyTypographyPreferences,
  readTypographyPreferences,
} from "../lib/typography-preferences";

function apply(): void {
  const root = document.documentElement;
  applyTypographyPreferences(
    root,
    document.body,
    readTypographyPreferences(),
    root.dataset.theme === "dark" ? "dark" : "light",
  );
}

apply();
if (document.body === null) document.addEventListener("DOMContentLoaded", apply, { once: true });
