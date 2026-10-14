import { DEFAULT_CODE_FONT_SIZE } from "./code-font-size";
import { MONO_FONT_FAMILY } from "./typography-preferences";

export interface TerminalTypography {
  fontFamily: string;
  fontSize: number;
}

const TERMINAL_SYMBOL_FONT_FAMILY = '"Symbols Nerd Font Mono"';
const TERMINAL_SYMBOL_FONT_NAME = "Symbols Nerd Font Mono";
const GENERIC_MONOSPACE_ENTRY_PATTERN = /(^|,\s*)monospace(\s*,|$)/i;

function parsePositivePixelValue(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTerminalFontFamily(value: string): string {
  const trimmed = value.trim();
  const family = !trimmed || trimmed.includes("var(") ? MONO_FONT_FAMILY : trimmed;
  if (family.includes(TERMINAL_SYMBOL_FONT_NAME)) {
    return GENERIC_MONOSPACE_ENTRY_PATTERN.test(family) ? family : `${family}, monospace`;
  }
  if (GENERIC_MONOSPACE_ENTRY_PATTERN.test(family)) {
    return family.replace(
      GENERIC_MONOSPACE_ENTRY_PATTERN,
      `$1${TERMINAL_SYMBOL_FONT_FAMILY}, monospace$2`,
    );
  }
  return `${family}, ${TERMINAL_SYMBOL_FONT_FAMILY}, monospace`;
}

export function sameTerminalTypography(
  left: TerminalTypography,
  right: TerminalTypography,
): boolean {
  return left.fontFamily === right.fontFamily && left.fontSize === right.fontSize;
}

export function resolveTerminalTypography(element: HTMLElement): TerminalTypography {
  const elementStyles = getComputedStyle(element);
  const tokenFontFamily = elementStyles.getPropertyValue("--font-mono").trim();
  const tokenFontSize = elementStyles.getPropertyValue("--font-code-size").trim();
  const probe = document.createElement("span");
  probe.textContent = "W";
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = `var(--font-mono, ${MONO_FONT_FAMILY})`;
  probe.style.fontSize = `var(--font-code-size, ${DEFAULT_CODE_FONT_SIZE}px)`;
  element.appendChild(probe);

  try {
    const styles = getComputedStyle(probe);
    const rawFontFamily =
      tokenFontFamily && !tokenFontFamily.includes("var(") ? tokenFontFamily : styles.fontFamily;
    return {
      fontFamily: normalizeTerminalFontFamily(rawFontFamily),
      fontSize:
        parsePositivePixelValue(tokenFontSize) ??
        parsePositivePixelValue(styles.fontSize) ??
        DEFAULT_CODE_FONT_SIZE,
    };
  } finally {
    probe.remove();
  }
}

export async function ensureTerminalTypographyLoaded({
  fontFamily,
  fontSize,
}: TerminalTypography): Promise<void> {
  if (!("fonts" in document)) return;

  try {
    const descriptor = `${fontSize}px ${fontFamily}`;
    if (!document.fonts.check(descriptor)) {
      await document.fonts.load(descriptor);
    }
    const symbolDescriptor = `${fontSize}px ${TERMINAL_SYMBOL_FONT_FAMILY}`;
    if (!document.fonts.check(symbolDescriptor)) {
      await document.fonts.load(symbolDescriptor);
    }
  } catch {
    // Font loading is best-effort; system and fallback monospace fonts are still usable.
  }
}
