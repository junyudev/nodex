import { useSyncExternalStore } from "react";

export type DatabasePropertyValuePresentation = "compact" | "page" | "list" | "board";

/** Shared geometry for tokenized values in the Page Property value lane. */
export const DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME =
  "inline-flex h-5.5 min-w-0 items-center rounded-md px-1.5 text-sm/5";

/**
 * A borderless Page Property value, empty or not, keeps its ink on the host's value edge. Its
 * hover and focus surface hangs into the gutter a host declares with
 * `--page-property-value-gutter`; a host without one keeps the surface inside the value's own
 * padding. The surface is painted behind the value rather than made of its box, so the value
 * occupies exactly its ink: nothing beside it shifts, and it never truncates to make room.
 */
export const DATABASE_PAGE_PROPERTY_BORDERLESS_VALUE_CLASS_NAME = [
  "relative isolate min-h-6 rounded-md px-[calc(0.375rem-var(--page-property-value-gutter,0px))]",
  "before:absolute before:inset-y-0 before:inset-x-[calc(var(--page-property-value-gutter,0px)*-1)] before:-z-10 before:rounded-md",
  "hover:bg-transparent hover:before:bg-token-foreground/5",
  "focus-visible:ring-0 focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-token-focus-border",
].join(" ");

/** The same contract for a text field, which cannot paint behind itself and so shifts its box. */
export const DATABASE_PAGE_PROPERTY_BORDERLESS_INPUT_CLASS_NAME =
  "relative left-[calc(var(--page-property-value-gutter,0px)*-1)] rounded-md px-1.5 hover:bg-token-foreground/5";

/** Quiet outline treatment for Page Property values that act as references. */
export const DATABASE_PAGE_PROPERTY_OUTLINED_TOKEN_CLASS_NAME = [
  DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME,
  "bg-transparent ring-[0.5px] ring-inset ring-token-border",
].join(" ");

/** Dense chips keep their host surface opaque and strengthen on direct hover. */
export const DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME = [
  "inline-flex h-6 min-h-6 max-w-[290px] items-center gap-1.5 overflow-hidden rounded-[48px] border-[0.5px]",
  "border-[var(--database-property-chip-border)] bg-[var(--database-property-chip-background)] px-2",
  "text-xs/4 [font-weight:450] text-[var(--database-property-chip-current-text,var(--database-property-chip-text))]",
  "outline-hidden hover:[--database-property-chip-current-text:var(--database-property-chip-hover-text)] hover:border-[var(--database-property-chip-hover-border)] hover:bg-[var(--database-property-chip-hover-background)] hover:text-[var(--database-property-chip-hover-text)] focus-visible:ring-1 focus-visible:ring-[var(--database-property-chip-focus)] disabled:opacity-50",
  "[&_svg]:size-3.5 [&_svg]:shrink-0",
].join(" ");

export const DATABASE_PROPERTY_VALUE_ICON_CHIP_CLASS_NAME = [
  DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME,
  "size-6 min-w-6 justify-center p-0",
].join(" ");

const DATABASE_PROPERTY_OPTION_COLORS: Readonly<Record<string, string>> = {
  gray: "#A4A4A6",
  default: "#A4A4A6",
  brown: "#B18869",
  orange: "#F67E49",
  yellow: "#F8C531",
  green: "#77D677",
  blue: "#56ABFD",
  purple: "#BB87FC",
  pink: "#F84DD0",
  red: "#D04A52",
  teal: "#4ADAD3",
  cyan: "#4ADAD3",
};

const DATABASE_PROPERTY_OPTION_PALETTE = [
  "#9A48FF",
  "#56ABFD",
  "#4BB449",
  "#E15F28",
  "#F67E49",
  "#CC05FF",
  "#17A6A4",
  "#9A3A63",
  "#F84DD0",
  "#1D8AF2",
  "#F8C531",
  "#BB87FC",
  "#D04A52",
  "#831FFF",
  "#D09808",
  "#B18869",
  "#77D677",
  "#A44907",
  "#4ADAD3",
  "#E166FF",
  "#96D71E",
] as const;

const CSS_COLOR_FUNCTION_OR_HEX = /^(?:#|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\()/i;

const stablePaletteIndex = (identity: string): number => {
  let hash = 2_166_136_261;
  for (const character of identity) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % DATABASE_PROPERTY_OPTION_PALETTE.length;
};

export const databasePropertyOptionDotColor = (
  color: string | undefined,
  identity: string,
): string => {
  const normalized = color?.trim();
  if (normalized && CSS_COLOR_FUNCTION_OR_HEX.test(normalized)) return normalized;
  if (normalized) {
    const mapped = DATABASE_PROPERTY_OPTION_COLORS[normalized.toLocaleLowerCase()];
    if (mapped) return mapped;
  }
  return DATABASE_PROPERTY_OPTION_PALETTE[stablePaletteIndex(identity)]!;
};

export const databasePropertyListInlineLabelLimit = (viewportWidth: number): number => {
  if (viewportWidth <= 640) return 2;
  if (viewportWidth <= 1_024) return 3;
  if (viewportWidth >= 1_400) return 6;
  return 4;
};

const viewportSubscribers = new Set<() => void>();
let viewportListening = false;

const notifyViewportSubscribers = () => {
  for (const subscriber of viewportSubscribers) subscriber();
};

const subscribeToViewport = (subscriber: () => void): (() => void) => {
  viewportSubscribers.add(subscriber);
  if (!viewportListening) {
    window.addEventListener("resize", notifyViewportSubscribers, { passive: true });
    viewportListening = true;
  }
  return () => {
    viewportSubscribers.delete(subscriber);
    if (viewportSubscribers.size > 0 || !viewportListening) return;
    window.removeEventListener("resize", notifyViewportSubscribers);
    viewportListening = false;
  };
};

const currentInlineLabelLimit = (): number =>
  databasePropertyListInlineLabelLimit(window.innerWidth);

/** List alone uses a viewport label budget; Board renders all values and wraps. */
export const useDatabasePropertyListInlineLabelLimit = (): number =>
  useSyncExternalStore(subscribeToViewport, currentInlineLabelLimit, () => 4);
