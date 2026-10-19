import type { Plugin } from "vite";
import { getCodexThemeVariantStyle } from "../src/renderer/lib/codex-theme-variant";
import {
  NODEX_LOGO_GEOMETRY,
  NODEX_LOGO_MASK_IMAGE,
  NODEX_LOGO_VIEW_BOX,
} from "../src/renderer/bootstrap/nodex-logo-source";

export const STARTUP_SHELL_STYLE_ANCHOR = "<!-- nodex-startup-shell:styles -->";
export const STARTUP_SHELL_ROOT_ANCHOR = "<!-- nodex-startup-shell:root -->";

export function createStartupShellMarkup(): string {
  return `<main class="nodex-startup-shell" data-startup-phase="opening">
  <div class="nodex-startup-brand" aria-hidden="true">
    <svg class="nodex-startup-logo-base" viewBox="${NODEX_LOGO_VIEW_BOX}" fill="none">${NODEX_LOGO_GEOMETRY}</svg>
    <span class="nodex-startup-logo-highlight"><span></span></span>
  </div>
  <div class="nodex-startup-status" role="status" aria-live="polite" aria-atomic="true">
    <span class="nodex-startup-sr-only" data-startup-a11y-status>Opening Nodex…</span>
    <p data-startup-visible-status hidden></p>
  </div>
  <div class="nodex-startup-failure" data-startup-failure hidden>
    <h1>Nodex could not finish opening</h1>
    <p>Restart Nodex to try again.</p>
    <button type="button" data-startup-restart>Restart Nodex</button>
  </div>
</main>`;
}

export function createStartupShellCriticalCss(): string {
  const themeCss = (["light", "dark"] as const)
    .map((variant) => {
      const declarations = Object.entries(getCodexThemeVariantStyle(variant))
        .map(([name, value]) => `${name}: ${value};`)
        .join("\n");
      return `${variant === "dark" ? ":root.dark" : ":root"} {\n${declarations}\n}`;
    })
    .join("\n");
  return `${themeCss}
:root {
  --startup-logo-base: rgb(0 0 0 / 0.24);
  --startup-logo-shimmer-soft: rgb(255 255 255 / 0.04);
  --startup-logo-shimmer-peak: rgb(255 255 255 / 0.48);
  --startup-logo-shimmer-tail: rgb(255 255 255 / 0.08);
  --startup-surface: var(--app-color-background-surface-under);
  color-scheme: light;
}
:root.dark {
  --startup-logo-base: rgb(255 255 255 / 0.68);
  color-scheme: dark;
}
html, body, #root { width: 100%; height: 100%; margin: 0; background: transparent; }
body { overflow: hidden; }
:root.electron-opaque body { background: var(--startup-surface); }
.nodex-startup-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--app-color-text-foreground-secondary);
  font-family: var(--font-ui-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  -webkit-app-region: drag;
}
.nodex-startup-brand {
  position: relative;
  width: 56px;
  height: 56px;
  opacity: 0;
  animation: nodex-startup-fade-in 180ms ease-out 60ms forwards;
}
.nodex-startup-logo-base { display: block; width: 100%; height: 100%; color: var(--startup-logo-base); }
.nodex-startup-logo-highlight {
  position: absolute;
  inset: 0;
  overflow: hidden;
  -webkit-mask-image: ${NODEX_LOGO_MASK_IMAGE};
  mask-image: ${NODEX_LOGO_MASK_IMAGE};
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}
/* A 220%-wide sweep translated by its own width keeps the gradient geometry of a
   background-position sweep from 140% to -105% while animating only transform. */
.nodex-startup-logo-highlight > span {
  position: absolute;
  inset-block: 0;
  left: 0;
  width: 220%;
  background: linear-gradient(
    112deg,
    transparent 22%,
    var(--startup-logo-shimmer-soft) 38%,
    var(--startup-logo-shimmer-peak) 49%,
    var(--startup-logo-shimmer-tail) 56%,
    transparent 74%
  );
  transform: translate3d(-76.3636%, 0, 0);
  animation: nodex-startup-shimmer 2.2s cubic-bezier(.4, 0, .2, 1) infinite;
  will-change: transform;
}
.nodex-startup-status {
  position: absolute;
  top: calc(50% + 44px);
  inset-inline: 0;
  min-height: 20px;
  text-align: center;
  color: var(--app-color-text-foreground-tertiary);
}
.nodex-startup-status p { margin: 0; font-size: var(--text-sm, 13px); line-height: 20px; letter-spacing: .005em; }
.nodex-startup-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.nodex-startup-failure { max-width: 340px; text-align: center; }
.nodex-startup-failure h1 { margin: 0; color: var(--app-color-text-foreground); font-size: var(--text-lg, 16px); font-weight: 500; }
.nodex-startup-failure p { margin: 8px 0 0; font-size: var(--text-sm, 13px); line-height: 20px; }
.nodex-startup-failure button {
  margin-top: 18px;
  border: 0;
  border-radius: 7px;
  padding: 7px 12px;
  color: var(--app-color-text-button-primary);
  background: var(--app-color-background-button-primary);
  font: inherit;
  cursor: default;
  -webkit-app-region: no-drag;
}
.nodex-startup-shell[data-startup-phase="failed"] .nodex-startup-status { display: none; }
.nodex-startup-shell[data-startup-phase="failed"] .nodex-startup-logo-highlight { display: none; }
:root.nodex-startup-document-hidden .nodex-startup-logo-highlight > span { animation-play-state: paused; }
:root.hide-startup-shell .nodex-startup-shell { display: none; }
@keyframes nodex-startup-fade-in {
  to { opacity: 1; }
}
@keyframes nodex-startup-shimmer {
  to { transform: translate3d(57.2727%, 0, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .nodex-startup-brand { animation: none; opacity: 1; }
  .nodex-startup-logo-highlight { display: none; }
}`;
}

export function createStartupShellHtmlPlugin(): Plugin {
  return {
    name: "nodex:startup-shell-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(STARTUP_SHELL_STYLE_ANCHOR)) {
          throw new Error("Renderer index is missing the startup shell style anchor");
        }
        if (!html.includes(STARTUP_SHELL_ROOT_ANCHOR)) {
          throw new Error("Renderer index is missing the startup shell root anchor");
        }
        return html
          .replace(STARTUP_SHELL_STYLE_ANCHOR, `<style>${createStartupShellCriticalCss()}</style>`)
          .replace(STARTUP_SHELL_ROOT_ANCHOR, createStartupShellMarkup());
      },
    },
  };
}
