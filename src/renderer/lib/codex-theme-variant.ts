type ThemeVariant = "light" | "dark";

export const CODEX_ACCENT_PRESETS = [
  "default",
  "blue",
  "green",
  "yellow",
  "pink",
  "orange",
  "purple",
  "black",
] as const;

export type CodexAccentPreset = (typeof CODEX_ACCENT_PRESETS)[number];
export function codexAccentPresetLabel(name: CodexAccentPreset, variant: ThemeVariant): string {
  if (name === "black" && variant === "dark") return "White";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type CodexAccent =
  | { readonly kind: "preset"; readonly name: CodexAccentPreset }
  | { readonly kind: "custom"; readonly color: string };

export const DEFAULT_CODEX_ACCENT = {
  kind: "preset",
  name: "default",
} as const satisfies CodexAccent;

type AccentColor = Exclude<CodexAccentPreset, "default" | "black">;
type AccentScale = Record<25 | 50 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;

const ACCENT_COLORS: Record<AccentColor, AccentScale> = {
  blue: {
    25: "#f6fafe",
    50: "#e8f3fe",
    200: "#63a8f8",
    300: "#539af8",
    400: "#3a83f7",
    500: "#2c67c5",
    600: "#1f4e94",
    700: "#173e76",
    800: "#133463",
    900: "#0c274a",
  },
  green: {
    25: "#effaf3",
    50: "#def3e5",
    200: "#83d197",
    300: "#6bc67f",
    400: "#53b559",
    500: "#48a04c",
    600: "#3a843f",
    700: "#2c6732",
    800: "#1f4e25",
    900: "#14361a",
  },
  yellow: {
    25: "#fefbee",
    50: "#fdf6dc",
    200: "#f9dc78",
    300: "#f8d45d",
    400: "#f6c543",
    500: "#d9a337",
    600: "#b8802b",
    700: "#95611f",
    800: "#734615",
    900: "#51300c",
  },
  pink: {
    25: "#fef8fb",
    50: "#fdedf4",
    200: "#f8a6c8",
    300: "#f68ebc",
    400: "#f077af",
    500: "#cf6194",
    600: "#ab4f7a",
    700: "#873e60",
    800: "#663049",
    900: "#462132",
  },
  orange: {
    25: "#fdf5f1",
    50: "#fbe8db",
    200: "#f1a275",
    300: "#ef8b57",
    400: "#ee7c37",
    500: "#d25e28",
    600: "#ac4f23",
    700: "#87401d",
    800: "#653218",
    900: "#45240d",
  },
  purple: {
    25: "#f8f5fd",
    50: "#ede5fc",
    200: "#b897f4",
    300: "#a67df2",
    400: "#8952ee",
    500: "#7849d1",
    600: "#643cae",
    700: "#4e2f88",
    800: "#3b2366",
    900: "#291947",
  },
};

export function normalizeCodexAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

/** Validates persisted appearance preferences at their input boundary. */
export function parseCodexAccent(value: unknown): CodexAccent {
  if (typeof value !== "object" || value === null) return DEFAULT_CODEX_ACCENT;
  if (!("kind" in value)) return DEFAULT_CODEX_ACCENT;
  if (value.kind === "custom" && "color" in value) {
    const color = normalizeCodexAccentColor(value.color);
    return color === null ? DEFAULT_CODEX_ACCENT : { kind: "custom", color };
  }
  if (value.kind !== "preset" || !("name" in value)) return DEFAULT_CODEX_ACCENT;
  const name = CODEX_ACCENT_PRESETS.find((preset) => preset === value.name);
  return name === undefined ? DEFAULT_CODEX_ACCENT : { kind: "preset", name };
}

/** Default follows the current blue palette while explicit presets retain their identity. */
export function resolveEffectiveCodexAccent(
  accent: CodexAccent = DEFAULT_CODEX_ACCENT,
): CodexAccent {
  const selected = parseCodexAccent(accent);
  if (selected.kind === "preset" && selected.name === "default")
    return { kind: "preset", name: "blue" };
  return selected;
}

function accentColor(accent: CodexAccent): string {
  if (accent.kind === "custom") return accent.color;
  const color =
    ACCENT_COLORS[accent.name === "default" || accent.name === "black" ? "blue" : accent.name];
  return color[accent.name === "purple" ? 300 : 400];
}

interface Rgb {
  blue: number;
  green: number;
  red: number;
}

interface BaseTheme {
  accent: string;
  contrast: number;
  ink: string;
  semanticColors: {
    diffAdded: string;
    diffRemoved: string;
    skill: string;
  };
  surface: string;
}

interface PreparedTheme {
  accent: Rgb;
  contrast: number;
  editorBackground: Rgb;
  ink: Rgb;
  surface: Rgb;
  surfaceUnder: string;
  theme: BaseTheme;
  variant: ThemeVariant;
}

interface DerivedTheme {
  accentBackground: string;
  accentBackgroundActive: string;
  accentBackgroundHover: string;
  border: string;
  borderFocus: string;
  borderHeavy: string;
  borderLight: string;
  buttonPrimaryBackground: string;
  buttonPrimaryBackgroundActive: string;
  buttonPrimaryBackgroundHover: string;
  buttonPrimaryBackgroundInactive: string;
  buttonSecondaryBackground: string;
  buttonSecondaryBackgroundActive: string;
  buttonSecondaryBackgroundHover: string;
  buttonSecondaryBackgroundInactive: string;
  buttonTertiaryBackground: string;
  buttonTertiaryBackgroundActive: string;
  buttonTertiaryBackgroundHover: string;
  controlBackground: string;
  controlBackgroundOpaque: string;
  elevatedPrimary: string;
  elevatedPrimaryOpaque: string;
  elevatedSecondary: string;
  elevatedSecondaryOpaque: string;
  elevatedTertiaryOpaque: string;
  iconAccent: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  simpleScrim: string;
  textAccent: string;
  textButtonPrimary: string;
  textButtonSecondary: string;
  textButtonTertiary: string;
  textForeground: string;
  textForegroundSecondary: string;
  textForegroundTertiary: string;
}

const BLACK: Rgb = { blue: 0, green: 0, red: 0 };
const WHITE: Rgb = { blue: 255, green: 255, red: 255 };

// Resolved preset colors. Interpolation baselines below are a separate contract.
const DEFAULT_THEMES: Record<ThemeVariant, BaseTheme> = {
  dark: {
    accent: "#3a83f7",
    contrast: 60,
    ink: "#fcfcfc",
    semanticColors: {
      diffAdded: "#00a240",
      diffRemoved: "#e02e2a",
      skill: "#b06dff",
    },
    surface: "#111111",
  },
  light: {
    accent: "#3a83f7",
    contrast: 45,
    ink: "#0d0d0d",
    semanticColors: {
      diffAdded: "#00a240",
      diffRemoved: "#e02e2a",
      skill: "#751ed9",
    },
    surface: "#ffffff",
  },
};

const BASE_CONTRAST: Record<ThemeVariant, number> = {
  dark: 60,
  light: 45,
};

const CONTRAST_BLEND = 0.7;
const CONTRAST_SCALE = 2;
const SURFACE_UNDER_BASE: Record<ThemeVariant, number> = {
  dark: 0.16,
  light: 0.04,
};
const SURFACE_UNDER_SLOPE: Record<ThemeVariant, number> = {
  dark: 0.0015,
  light: 0.0012,
};
const PANEL_BASE: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.18,
};
const PANEL_SLOPE: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.008,
};

const CODEX_RUNTIME_DOCUMENT_STYLE = {
  "--cursor-interaction": "pointer",
} as const;

/** Projects a raw palette. Resolve selected preferences first; applyCodexThemeVariant does this. */
export function getCodexThemeVariantStyle(
  variant: ThemeVariant,
  accent: CodexAccent = DEFAULT_CODEX_ACCENT,
  coloredUserMessages = true,
): Record<string, string> {
  const resolvedAccent = parseCodexAccent(accent);
  const base = { ...DEFAULT_THEMES[variant], accent: accentColor(resolvedAccent) };
  const prepared = prepareTheme(base, variant);
  const derived = variant === "light" ? deriveLightTheme(prepared) : deriveDarkTheme(prepared);
  const applicationMenu = mixRgb(prepared.surface, prepared.ink, 0.02 + prepared.contrast * 0.02);

  return {
    ...CODEX_RUNTIME_DOCUMENT_STYLE,
    // Legacy content consumers share the same surface and text hierarchy.
    "--background": "var(--app-color-background-surface)",
    "--foreground": "var(--app-color-text-foreground)",
    "--foreground-secondary": "var(--app-color-text-foreground-secondary)",
    "--foreground-tertiary": "var(--app-color-text-foreground-tertiary)",
    "--codex-base-accent": prepared.theme.accent,
    "--codex-base-contrast": String(prepared.theme.contrast),
    "--codex-base-ink": prepared.theme.ink,
    "--codex-base-surface": prepared.theme.surface,
    "--app-color-accent-blue": prepared.theme.accent,
    "--app-color-accent-purple": prepared.theme.semanticColors.skill,
    "--app-color-background-accent": derived.accentBackground,
    "--app-color-background-accent-active": derived.accentBackgroundActive,
    "--app-color-background-accent-hover": derived.accentBackgroundHover,
    "--app-color-background-application-menu": toHex(applicationMenu),
    "--app-color-background-button-primary": derived.buttonPrimaryBackground,
    "--app-color-background-button-primary-active": derived.buttonPrimaryBackgroundActive,
    "--app-color-background-button-primary-hover": derived.buttonPrimaryBackgroundHover,
    "--app-color-background-button-primary-inactive": derived.buttonPrimaryBackgroundInactive,
    "--app-color-background-button-secondary": derived.buttonSecondaryBackground,
    "--app-color-background-button-secondary-active": derived.buttonSecondaryBackgroundActive,
    "--app-color-background-button-secondary-hover": derived.buttonSecondaryBackgroundHover,
    "--app-color-background-button-secondary-inactive": derived.buttonSecondaryBackgroundInactive,
    "--app-color-background-button-tertiary": derived.buttonTertiaryBackground,
    "--app-color-background-button-tertiary-active": derived.buttonTertiaryBackgroundActive,
    "--app-color-background-button-tertiary-hover": derived.buttonTertiaryBackgroundHover,
    "--color-background-callout-surface": derived.elevatedPrimary,
    "--color-background-composer-action-bar":
      variant === "light" ? prepared.surfaceUnder : derived.elevatedSecondaryOpaque,
    "--app-color-background-control": derived.controlBackground,
    "--color-background-control-opaque": derived.controlBackgroundOpaque,
    "--app-color-background-editor-opaque": toRgb(prepared.editorBackground),
    "--app-color-background-elevated-primary": derived.elevatedPrimary,
    "--app-color-background-elevated-primary-opaque": derived.elevatedPrimaryOpaque,
    "--app-color-background-elevated-secondary": derived.elevatedSecondary,
    "--app-color-background-elevated-secondary-opaque": derived.elevatedSecondaryOpaque,
    "--app-color-background-elevated-tertiary-opaque": derived.elevatedTertiaryOpaque,
    "--color-background-mode-toggle-track":
      variant === "light" ? prepared.surfaceUnder : derived.buttonTertiaryBackgroundHover,
    "--color-background-mode-toggle-selected":
      variant === "dark"
        ? derived.controlBackgroundOpaque
        : `color-mix(in oklab, ${derived.controlBackground} 90%, transparent)`,
    "--color-background-panel": computePanelBackground(prepared),
    "--app-color-background-surface": prepared.theme.surface,
    "--app-color-background-surface-under": prepared.surfaceUnder,
    "--app-color-border": derived.border,
    "--app-color-border-application-menu-separator":
      variant === "dark" ? mixHex(applicationMenu, prepared.ink, 0.28) : derived.borderHeavy,
    "--app-color-border-focus": derived.borderFocus,
    "--app-color-border-heavy": derived.borderHeavy,
    "--app-color-border-light": derived.borderLight,
    "--color-border-mode-toggle-selected": derived.border,
    "--app-color-decoration-added": prepared.theme.semanticColors.diffAdded,
    "--app-color-decoration-deleted": prepared.theme.semanticColors.diffRemoved,
    "--app-color-editor-added": toRgba(
      parseHex(prepared.theme.semanticColors.diffAdded),
      variant === "light" ? 0.15 : 0.23,
    ),
    "--app-color-editor-deleted": toRgba(
      parseHex(prepared.theme.semanticColors.diffRemoved),
      variant === "light" ? 0.15 : 0.23,
    ),
    "--app-color-icon-accent": derived.iconAccent,
    "--app-color-icon-primary": derived.iconPrimary,
    "--app-color-icon-secondary": derived.iconSecondary,
    "--app-color-icon-tertiary": derived.iconTertiary,
    "--app-color-foreground-application-menu":
      variant === "dark" ? mixHex(applicationMenu, prepared.ink, 0.875) : derived.textForeground,
    "--app-color-simple-scrim": derived.simpleScrim,
    "--app-color-text-accent": derived.textAccent,
    "--app-color-text-on-accent": toRgb(contrastingInk(prepared.accent)),
    "--app-color-text-button-primary": derived.textButtonPrimary,
    "--app-color-text-button-secondary": derived.textButtonSecondary,
    "--app-color-text-button-tertiary": derived.textButtonTertiary,
    "--app-color-text-foreground": derived.textForeground,
    "--app-color-text-foreground-secondary": derived.textForegroundSecondary,
    "--app-color-text-foreground-tertiary": derived.textForegroundTertiary,
    "--app-color-text-secondary": "initial",
    "--app-color-text-primary-solid": "initial",
    "--app-color-background-card": "initial",
    "--color-image-generation-accent": prepared.theme.accent,
    "--color-image-generation-text": "var(--color-text-accent)",
    "--color-image-generation-foreground": "var(--app-color-text-on-accent)",
    "--color-text-mode-toggle-inactive": `color-mix(in oklab, ${derived.textForeground} 80%, transparent)`,
    "--shadow-mode-toggle-selected": "var(--shadow-md)",
    ...deriveAccentStyle(variant, resolvedAccent, prepared, derived, coloredUserMessages),
  };
}

/** Projects a raw accent palette. Preview callers must resolve selected preferences first. */
export function getCodexAccentStyle(
  variant: ThemeVariant,
  accent: CodexAccent = DEFAULT_CODEX_ACCENT,
  coloredUserMessages = true,
): Record<string, string> {
  const resolved = parseCodexAccent(accent);
  const base = { ...DEFAULT_THEMES[variant], accent: accentColor(resolved) };
  const prepared = prepareTheme(base, variant);
  const derived = variant === "light" ? deriveLightTheme(prepared) : deriveDarkTheme(prepared);
  return deriveAccentStyle(variant, resolved, prepared, derived, coloredUserMessages);
}

function deriveAccentStyle(
  variant: ThemeVariant,
  accent: CodexAccent,
  prepared: PreparedTheme,
  derived: DerivedTheme,
  coloredUserMessages: boolean,
): Record<string, string> {
  const isDark = variant === "dark";
  const preset = accent.kind === "preset" ? accent.name : closestCodexAccentPreset(accent.color);
  const colorName = preset === null || preset === "default" || preset === "black" ? "blue" : preset;
  const onAccent = toRgb(contrastingInk(prepared.accent));
  const shared = {
    "--codex-base-accent": prepared.theme.accent,
    "--app-color-accent-blue": prepared.theme.accent,
    "--app-color-text-on-accent": onAccent,
    "--app-color-text-unread-badge":
      accent.kind === "custom"
        ? onAccent
        : preset === "yellow"
          ? "var(--gray-fixed-1000)"
          : "var(--white)",
    "--color-chart-sequential-1": `var(--${colorName}-${isDark ? 800 : 75})`,
    "--color-chart-sequential-2": `var(--${colorName}-${isDark ? 600 : 200})`,
    "--color-chart-sequential-3": `var(--${colorName}-400)`,
    "--color-chart-sequential-4": `var(--${colorName}-${isDark ? 200 : 600})`,
    "--color-image-generation-accent":
      accent.kind === "preset" && preset === "black" ? "var(--color-text)" : prepared.theme.accent,
    "--color-image-generation-text":
      accent.kind === "preset" && preset === "black"
        ? "var(--color-text)"
        : "var(--color-text-accent)",
    "--color-image-generation-foreground":
      accent.kind === "preset" && preset === "black"
        ? "var(--app-color-background-surface)"
        : "var(--app-color-text-on-accent)",
  };
  if (accent.kind === "custom")
    return {
      ...shared,
      "--app-color-background-accent": derived.accentBackground,
      "--app-color-background-accent-active": derived.accentBackgroundActive,
      "--app-color-background-accent-hover": derived.accentBackgroundHover,
      "--app-color-border-focus": derived.borderFocus,
      "--app-color-icon-accent": derived.iconAccent,
      "--app-color-text-accent": derived.textAccent,
      "--color-background-accent-action": "var(--color-background-info-solid)",
      "--color-text-accent-action": "var(--color-text-info-solid)",
      "--color-background-composer-primary": "var(--color-background-primary-solid)",
      "--color-text-composer-primary": "var(--color-text-primary-solid)",
      "--color-background-user-message": "color-mix(in oklab, var(--color-text) 5%, transparent)",
      "--color-text-user-message": "var(--color-text)",
      "--color-background-text-selection": "var(--color-background-info-soft)",
      "--color-background-attribution-highlight": "var(--color-background-info-soft)",
    };

  const palette = ACCENT_COLORS[colorName];
  const monochrome = preset === "default" || preset === "black";
  const textTone =
    preset === "yellow"
      ? isDark
        ? 400
        : 600
      : isDark && (preset === "pink" || preset === "orange")
        ? 400
        : 500;
  const selection =
    preset === "default"
      ? isDark
        ? `${palette[200]}66`
        : `${palette[300]}59`
      : preset === "black"
        ? isDark
          ? "#78787866"
          : "#afafaf66"
        : isDark
          ? `${palette[400]}${preset === "yellow" ? "80" : "99"}`
          : `${palette[300]}59`;
  const useNeutralMessage = monochrome || !coloredUserMessages;
  const messageBackground = useNeutralMessage
    ? isDark
      ? "rgb(50 50 50 / 85%)"
      : "rgb(233 233 233 / 50%)"
    : palette[isDark ? 700 : 50];
  const messageText = useNeutralMessage
    ? isDark
      ? "#ffffff"
      : "#0d0d0d"
    : palette[isDark ? 25 : 900];
  const soft = palette[isDark ? 800 : 50];
  const actionBackground = monochrome
    ? isDark
      ? "#ffffff"
      : "#000000"
    : palette[isDark && preset !== "pink" ? 500 : 400];
  const actionText = monochrome && isDark ? "#000000" : "#ffffff";
  return {
    ...shared,
    "--app-color-background-accent": soft,
    "--app-color-background-accent-active": soft,
    "--app-color-background-accent-hover": soft,
    "--app-color-border-focus": prepared.theme.accent,
    "--app-color-icon-accent": palette[textTone],
    "--app-color-text-accent": palette[textTone],
    "--color-background-accent-action": actionBackground,
    "--color-text-accent-action": actionText,
    "--color-background-composer-primary": actionBackground,
    "--color-text-composer-primary": actionText,
    "--color-background-user-message":
      preset === "black" && !isDark ? "#000000" : messageBackground,
    "--color-text-user-message": preset === "black" && !isDark ? "#ffffff" : messageText,
    "--color-background-text-selection": selection,
    "--color-background-attribution-highlight":
      preset === "default" ? (isDark ? "#734615" : "#fcefbe") : selection,
  };
}

/** Matches an exact custom color to a chart family without changing its selected hue. */
export function closestCodexAccentPreset(value: string): CodexAccentPreset | null {
  const normalized = normalizeCodexAccentColor(value);
  if (normalized === null) return null;
  const color = parseHex(normalized);
  const average = (color.red + color.green + color.blue) / 3;
  const neutralDistance = colorDistance(color, { red: average, green: average, blue: average });
  let closest: CodexAccentPreset | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const preset of CODEX_ACCENT_PRESETS) {
    const name = preset === "default" ? "blue" : preset;
    const distance =
      name === "black" ? neutralDistance : distanceToPalette(color, ACCENT_COLORS[name]);
    if (distance > closestDistance || (distance === closestDistance && closest !== "default"))
      continue;
    closest = preset;
    closestDistance = distance;
  }
  return closest;
}

function distanceToPalette(color: Rgb, palette: AccentScale): number {
  const shades = Object.values(palette).map(parseHex);
  return Math.min(
    ...shades.slice(1).map((shade, index) => {
      const start = shades[index]!;
      const delta = {
        red: shade.red - start.red,
        green: shade.green - start.green,
        blue: shade.blue - start.blue,
      };
      const length = delta.red ** 2 + delta.green ** 2 + delta.blue ** 2;
      const ratio = Math.min(
        1,
        Math.max(
          0,
          ((color.red - start.red) * delta.red +
            (color.green - start.green) * delta.green +
            (color.blue - start.blue) * delta.blue) /
            length,
        ),
      );
      return colorDistance(color, {
        red: start.red + delta.red * ratio,
        green: start.green + delta.green * ratio,
        blue: start.blue + delta.blue * ratio,
      });
    }),
  );
}

function colorDistance(from: Rgb, to: Rgb): number {
  return (from.red - to.red) ** 2 + (from.green - to.green) ** 2 + (from.blue - to.blue) ** 2;
}

function contrastingInk(color: Rgb): Rgb {
  const luminance = relativeLuminance(color);
  if (color.blue > color.red && color.blue > color.green) {
    const range = color.blue - Math.min(color.red, color.green);
    const hue = ((color.red - color.green) / range + 4) * 60;
    const saturation = range / color.blue;
    if (
      (saturation >= 0.8 && hue >= 205 && hue <= 212) ||
      (saturation >= 0.6 && hue >= 218 && hue <= 233 && luminance <= 0.21)
    )
      return WHITE;
  }
  return luminance > 0.179 ? BLACK : WHITE;
}

function relativeLuminance(color: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return linear(color.red) * 0.2126 + linear(color.green) * 0.7152 + linear(color.blue) * 0.0722;
}

export function applyCodexThemeVariant(
  root: HTMLElement,
  variant: ThemeVariant,
  body?: HTMLElement,
  accent: CodexAccent = DEFAULT_CODEX_ACCENT,
  coloredUserMessages = true,
): void {
  root.dataset.theme = variant;
  const styles = getCodexThemeVariantStyle(
    variant,
    resolveEffectiveCodexAccent(accent),
    coloredUserMessages,
  );
  for (const [name, value] of Object.entries(styles)) {
    root.style.setProperty(name, value);
  }

  if (!body) return;
  for (const [name, value] of Object.entries(CODEX_RUNTIME_DOCUMENT_STYLE)) {
    body.style.setProperty(name, value);
  }
}

function prepareTheme(theme: BaseTheme, variant: ThemeVariant): PreparedTheme {
  const normalizedContrast = normalizeContrast(theme.contrast, variant);
  const surface = parseHex(theme.surface);
  const ink = parseHex(theme.ink);

  return {
    accent: parseHex(theme.accent),
    contrast: normalizedContrast,
    editorBackground:
      variant === "light" ? mixRgb(surface, WHITE, 0.12) : mixRgb(surface, ink, 0.07),
    ink,
    surface,
    surfaceUnder: computeSurfaceUnder(theme, surface, ink, variant),
    theme,
    variant,
  };
}

function deriveLightTheme(theme: PreparedTheme): DerivedTheme {
  const controlBase = mixRgb(theme.surface, WHITE, 0.09 + theme.contrast * 0.04);
  const elevatedSecondaryBase = mixRgb(theme.surface, WHITE, 0.08 + theme.contrast * 0.08);
  const elevatedPrimaryBase = mixRgb(theme.surface, WHITE, 0.16 + theme.contrast * 0.12);

  return {
    accentBackground: mixHex(theme.surface, theme.accent, 0.11 + theme.contrast * 0.04),
    accentBackgroundActive: mixHex(theme.surface, theme.accent, 0.13 + theme.contrast * 0.05),
    accentBackgroundHover: mixHex(theme.surface, theme.accent, 0.12 + theme.contrast * 0.045),
    border: toRgba(theme.ink, 0.06 + theme.contrast * 0.04),
    borderFocus: theme.theme.accent,
    borderHeavy: toRgba(theme.ink, 0.09 + theme.contrast * 0.06),
    borderLight: toRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: toRgba(theme.ink, 0.1 + theme.contrast * 0.12),
    buttonPrimaryBackgroundHover: toRgba(theme.ink, 0.05 + theme.contrast * 0.06),
    buttonPrimaryBackgroundInactive: toRgba(theme.ink, 0.18 + theme.contrast * 0.14),
    buttonSecondaryBackground: toRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: toRgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonSecondaryBackgroundHover: toRgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: toRgba(theme.ink, 0.01 + theme.contrast * 0.02),
    buttonTertiaryBackground: toRgba(theme.ink, 0),
    buttonTertiaryBackgroundActive: toRgba(theme.ink, 0.16 + theme.contrast * 0.08),
    buttonTertiaryBackgroundHover: toRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    controlBackground: toRgba(controlBase, 0.96),
    controlBackgroundOpaque: toRgb(controlBase),
    elevatedPrimary: toRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: toRgb(elevatedPrimaryBase),
    elevatedSecondary: toRgba(elevatedSecondaryBase, 0.96),
    elevatedSecondaryOpaque: toRgb(elevatedSecondaryBase),
    elevatedTertiaryOpaque: mixHex(elevatedSecondaryBase, theme.ink, 0.04 + theme.contrast * 0.02),
    iconAccent: theme.theme.accent,
    iconPrimary: theme.theme.ink,
    iconSecondary: toRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: toRgba(BLACK, 0.08 + theme.contrast * 0.04),
    textAccent: theme.theme.accent,
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: theme.theme.ink,
    textButtonTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: toRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
  };
}

function deriveDarkTheme(theme: PreparedTheme): DerivedTheme {
  const controlBase = mixRgb(theme.surface, theme.ink, 0.06 + theme.contrast * 0.05);
  const accentTextBase = mixRgb(theme.accent, WHITE, 0.3 + theme.contrast * 0.15);
  const buttonPrimaryBase = mixRgb(theme.surface, BLACK, 0.38 + theme.contrast * 0.12);
  const elevatedPrimaryBase = mixRgb(theme.surface, theme.ink, 0.08 + theme.contrast * 0.08);

  return {
    accentBackground: mixHex(BLACK, theme.accent, 0.2 + theme.contrast * 0.08),
    accentBackgroundActive: mixHex(BLACK, theme.accent, 0.22 + theme.contrast * 0.12),
    accentBackgroundHover: mixHex(BLACK, theme.accent, 0.21 + theme.contrast * 0.1),
    border: toRgba(theme.ink, 0.06 + theme.contrast * 0.04),
    borderFocus: toRgba(accentTextBase, 0.7 + theme.contrast * 0.1),
    borderHeavy: toRgba(theme.ink, 0.12 + theme.contrast * 0.06),
    borderLight: toRgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonPrimaryBackground: toRgb(buttonPrimaryBase),
    buttonPrimaryBackgroundActive: toRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonPrimaryBackgroundHover: toRgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonPrimaryBackgroundInactive: toRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    buttonSecondaryBackground: toRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: toRgba(theme.ink, 0.09 + theme.contrast * 0.05),
    buttonSecondaryBackgroundHover: toRgba(theme.ink, 0.06 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: toRgba(theme.ink, 0.02 + theme.contrast * 0.03),
    buttonTertiaryBackground: toRgba(theme.ink, 0.02 + theme.contrast * 0.015),
    buttonTertiaryBackgroundActive: toRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonTertiaryBackgroundHover: toRgba(theme.ink, 0.05 + theme.contrast * 0.03),
    controlBackground: toRgba(controlBase, 0.96),
    controlBackgroundOpaque: toRgb(controlBase),
    elevatedPrimary: toRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: toRgb(elevatedPrimaryBase),
    elevatedSecondary: toRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    elevatedSecondaryOpaque: mixHex(theme.surface, theme.ink, 0.04 + theme.contrast * 0.05),
    elevatedTertiaryOpaque: toRgb(theme.editorBackground),
    iconAccent: toRgb(accentTextBase),
    iconPrimary: toRgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: toRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: toRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    textAccent: toRgb(accentTextBase),
    textButtonPrimary: toRgb(buttonPrimaryBase),
    textButtonSecondary: mixHex(theme.ink, theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: toRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: toRgba(theme.ink, 0.42 + theme.contrast * 0.13),
  };
}

function normalizeContrast(contrast: number, variant: ThemeVariant): number {
  const baseContrast = BASE_CONTRAST[variant];
  const normalizedBase = baseContrast / 100;
  const blended = contrast / 100 + ((contrast - baseContrast) / 60) * CONTRAST_BLEND;
  return contrast <= baseContrast
    ? blended
    : normalizedBase + (blended - normalizedBase) * CONTRAST_SCALE;
}

function computeSurfaceUnder(
  theme: BaseTheme,
  surface: Rgb,
  ink: Rgb,
  variant: ThemeVariant,
): string {
  const baseContrast = BASE_CONTRAST[variant];
  const alpha =
    SURFACE_UNDER_BASE[variant] + (theme.contrast - baseContrast) * SURFACE_UNDER_SLOPE[variant];

  return variant === "light" ? mixHex(surface, ink, alpha) : mixHex(surface, BLACK, alpha);
}

function computePanelBackground(theme: PreparedTheme): string {
  const panelTarget = theme.variant === "light" ? WHITE : theme.ink;
  return mixHex(
    theme.surface,
    panelTarget,
    PANEL_BASE[theme.variant] + theme.contrast * PANEL_SLOPE[theme.variant],
  );
}

function parseHex(hex: string): Rgb {
  const value = hex.slice(1);
  return {
    blue: Number.parseInt(value.slice(4, 6), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    red: Number.parseInt(value.slice(0, 2), 16),
  };
}

function toRgba(color: Rgb, alpha: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${normalizeAlpha(alpha)})`;
}

function mixHex(from: Rgb, to: Rgb, amount: number): string {
  return toHex(mixRgb(from, to, amount));
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  const ratio = Math.min(1, Math.max(0, amount));
  return {
    blue: mixChannel(from.blue, to.blue, ratio),
    green: mixChannel(from.green, to.green, ratio),
    red: mixChannel(from.red, to.red, ratio),
  };
}

function mixChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

function normalizeAlpha(alpha: number): string {
  return Math.min(1, Math.max(0, alpha)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function toHex(color: Rgb): string {
  return `#${toHexChannel(color.red)}${toHexChannel(color.green)}${toHexChannel(color.blue)}`;
}

function toRgb(color: Rgb): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

function toHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}
