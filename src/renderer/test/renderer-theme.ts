import { afterEach, beforeEach } from "vite-plus/test";
import { applyCodexDocumentTheme, type CodexAccent } from "@/lib/codex-theme-variant";

/** Applies the same document palette and window classes as renderer startup and appearance changes. */
export function applyRendererThemeForTest(
  variant: "light" | "dark" = "light",
  {
    windowType = "electron",
    accents,
    coloredUserMessages,
  }: {
    readonly windowType?: "browser" | "electron";
    readonly accents?: Readonly<Partial<Record<"light" | "dark", CodexAccent>>>;
    readonly coloredUserMessages?: boolean;
  } = {},
): void {
  const root = document.documentElement;
  root.dataset.codexWindowType = windowType;
  root.classList.toggle("dark", variant === "dark");
  root.classList.toggle("electron-dark", windowType === "electron" && variant === "dark");
  root.classList.toggle("electron-light", windowType === "electron" && variant === "light");
  applyCodexDocumentTheme(document, variant, accents, coloredUserMessages);
}

/** Keeps each product-surface test on a fresh runtime theme rather than static CSS fallbacks. */
export function installRendererThemeFixture(): void {
  beforeEach(() => applyRendererThemeForTest());
  afterEach(() => {
    document.head.querySelector("style[data-codex-app-themes]")?.remove();
    const root = document.documentElement;
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
    root.removeAttribute("data-codex-window-type");
    root.classList.remove("dark", "electron-dark", "electron-light");
    document.body.removeAttribute("style");
  });
}

/** Resolves a semantic role independently of the component's utility or pseudo-element. */
export function readRendererThemeColor(variable: `--${string}`): string {
  const probe = document.createElement("span");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  try {
    const style = getComputedStyle(probe);
    if (!style.getPropertyValue(variable).trim()) {
      throw new Error(`Runtime theme role ${variable} is unresolved`);
    }
    return style.backgroundColor;
  } finally {
    probe.remove();
  }
}
