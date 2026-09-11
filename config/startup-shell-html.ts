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
    <p data-startup-visible-status hidden>Opening Nodex…</p>
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
  --startup-logo-base: #26272c;
  --startup-logo-highlight: rgba(255, 255, 255, 0.92);
  --startup-text: rgba(38, 39, 44, 0.58);
  --startup-surface: var(--color-background-surface-under);
  color-scheme: light;
}
:root.dark {
  --startup-logo-base: #d9dade;
  --startup-logo-highlight: rgba(255, 255, 255, 0.96);
  --startup-text: rgba(229, 230, 234, 0.58);
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
  color: var(--startup-logo-base);
  font-family: "SF Pro Text", "Avenir Next", ui-sans-serif, sans-serif;
  -webkit-app-region: drag;
}
.nodex-startup-brand { position: relative; width: 68px; height: 68px; }
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
.nodex-startup-logo-highlight > span {
  position: absolute;
  inset-block: -15%;
  left: 0;
  width: 42%;
  background: linear-gradient(90deg, transparent, var(--startup-logo-highlight), transparent);
  transform: translate3d(-180%, 0, 0) skewX(-12deg);
  animation: nodex-startup-shimmer 1.85s cubic-bezier(.4, 0, .2, 1) infinite;
  will-change: transform;
}
.nodex-startup-status { min-height: 20px; color: var(--startup-text); }
.nodex-startup-status p { margin: 0; font-size: 13px; line-height: 20px; letter-spacing: .005em; }
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
.nodex-startup-failure { max-width: 340px; text-align: center; color: var(--startup-text); }
.nodex-startup-failure h1 { margin: 0; color: var(--startup-logo-base); font-size: 16px; font-weight: 580; }
.nodex-startup-failure p { margin: 8px 0 0; font-size: 13px; line-height: 20px; }
.nodex-startup-failure button {
  margin-top: 18px;
  border: 0;
  border-radius: 7px;
  padding: 7px 12px;
  color: var(--startup-surface);
  background: var(--startup-logo-base);
  font: inherit;
  cursor: default;
  -webkit-app-region: no-drag;
}
.nodex-startup-shell[data-startup-phase="failed"] .nodex-startup-status { display: none; }
.nodex-startup-shell[data-startup-phase="failed"] .nodex-startup-brand { width: 54px; height: 54px; }
.nodex-startup-shell[data-startup-phase="failed"] .nodex-startup-logo-highlight { display: none; }
:root.nodex-startup-document-hidden .nodex-startup-logo-highlight > span { animation-play-state: paused; }
:root.hide-startup-shell .nodex-startup-shell { display: none; }
@keyframes nodex-startup-shimmer {
  0%, 22% { transform: translate3d(-180%, 0, 0) skewX(-12deg); }
  72%, 100% { transform: translate3d(340%, 0, 0) skewX(-12deg); }
}
@media (prefers-reduced-motion: reduce) {
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
