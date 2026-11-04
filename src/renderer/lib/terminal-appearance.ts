import type { ITheme, Terminal } from "@xterm/xterm";

const ANSI_ROLES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export function readTerminalTheme(surface: HTMLElement): ITheme {
  const document = surface.ownerDocument;
  const surfaceStyle = getComputedStyle(surface);
  const rootStyle = getComputedStyle(document.documentElement);
  const probe = document.createElement("div");
  surface.append(probe);

  const resolve = (role: string) => {
    const token = `--color-codex-terminal-${role}`;
    const value =
      surfaceStyle.getPropertyValue(token).trim() || rootStyle.getPropertyValue(token).trim();
    if (!value) return undefined;
    probe.style.color = value;
    return getComputedStyle(probe).color || value;
  };

  const theme: ITheme = {
    background: resolve("background") || surfaceStyle.backgroundColor,
    foreground: resolve("foreground") || surfaceStyle.color,
    cursor: resolve("foreground") || surfaceStyle.color,
    selectionBackground: resolve("selection"),
    selectionInactiveBackground: resolve("selection-inactive"),
  };
  for (const role of ANSI_ROLES) {
    theme[role] = resolve(`ansi-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  probe.remove();
  return theme;
}

export function applyTerminalTheme(
  term: Pick<Terminal, "options" | "refresh" | "rows">,
  surface: HTMLElement,
): void {
  term.options.theme = readTerminalTheme(surface);
  if (term.rows > 0) term.refresh(0, term.rows - 1);
}
