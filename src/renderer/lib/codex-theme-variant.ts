type ThemeVariant = "light" | "dark";

interface Rgb {
  blue: number;
  green: number;
  red: number;
}

interface BaseTheme {
  accent: string;
  accentColors: {
    green: string;
    orange: string;
    red: string;
    yellow: string;
  };
  contrast: number;
  fonts: {
    code: string | null;
    ui: string | null;
  };
  ink: string;
  opaqueWindows: boolean;
  semanticColors: {
    diffAdded: string;
    diffModified: string;
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
const DARK_PRIMARY_FOREGROUND = "#dfdfdf";

const DEFAULT_THEMES: Record<ThemeVariant, BaseTheme> = {
  dark: {
    accent: "#339cff",
    accentColors: {
      green: "#40c977",
      orange: "#fb6a22",
      red: "#ff6764",
      yellow: "#ffd240",
    },
    contrast: 60,
    fonts: { code: null, ui: null },
    ink: "#ffffff",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#40c977",
      diffModified: "#ff8549",
      diffRemoved: "#fa423e",
      skill: "#ad7bf9",
    },
    surface: "#181818",
  },
  light: {
    accent: "#339cff",
    accentColors: {
      green: "#00a240",
      orange: "#e25507",
      red: "#e02e2a",
      yellow: "#ffc300",
    },
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: "#1a1c1f",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#00a240",
      diffModified: "#923b0f",
      diffRemoved: "#ba2623",
      skill: "#924ff7",
    },
    surface: "#ffffff",
  },
};

const BASE_CONTRAST: Record<ThemeVariant, number> = {
  dark: DEFAULT_THEMES.dark.contrast,
  light: DEFAULT_THEMES.light.contrast,
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

export function getCodexThemeVariantStyle(variant: ThemeVariant): Record<string, string> {
  const base = DEFAULT_THEMES[variant];
  const prepared = prepareTheme(base, variant);
  const derived = variant === "light" ? deriveLightTheme(prepared) : deriveDarkTheme(prepared);

  return {
    ...CODEX_RUNTIME_DOCUMENT_STYLE,
    "--codex-base-accent": prepared.theme.accent,
    "--codex-base-contrast": String(prepared.theme.contrast),
    "--codex-base-ink": prepared.theme.ink,
    "--codex-base-surface": prepared.theme.surface,
    "--color-accent-blue": prepared.theme.accent,
    "--color-accent-green": prepared.theme.accentColors.green,
    "--color-accent-orange": prepared.theme.accentColors.orange,
    "--color-accent-purple": prepared.theme.semanticColors.skill,
    "--color-accent-red": prepared.theme.accentColors.red,
    "--color-accent-yellow": prepared.theme.accentColors.yellow,
    "--color-background-accent": derived.accentBackground,
    "--color-background-accent-active": derived.accentBackgroundActive,
    "--color-background-accent-hover": derived.accentBackgroundHover,
    "--color-background-button-primary": derived.buttonPrimaryBackground,
    "--color-background-button-primary-active": derived.buttonPrimaryBackgroundActive,
    "--color-background-button-primary-hover": derived.buttonPrimaryBackgroundHover,
    "--color-background-button-primary-inactive": derived.buttonPrimaryBackgroundInactive,
    "--color-background-button-secondary": derived.buttonSecondaryBackground,
    "--color-background-button-secondary-active": derived.buttonSecondaryBackgroundActive,
    "--color-background-button-secondary-hover": derived.buttonSecondaryBackgroundHover,
    "--color-background-button-secondary-inactive": derived.buttonSecondaryBackgroundInactive,
    "--color-background-button-tertiary": derived.buttonTertiaryBackground,
    "--color-background-button-tertiary-active": derived.buttonTertiaryBackgroundActive,
    "--color-background-button-tertiary-hover": derived.buttonTertiaryBackgroundHover,
    "--color-background-control": derived.controlBackground,
    "--color-background-control-opaque": derived.controlBackgroundOpaque,
    "--color-background-editor-opaque": toRgb(prepared.editorBackground),
    "--color-background-elevated-primary": derived.elevatedPrimary,
    "--color-background-elevated-primary-opaque": derived.elevatedPrimaryOpaque,
    "--color-background-elevated-secondary": derived.elevatedSecondary,
    "--color-background-elevated-secondary-opaque": derived.elevatedSecondaryOpaque,
    "--color-background-panel": computePanelBackground(prepared),
    "--color-background-surface": prepared.theme.surface,
    "--color-background-surface-under": prepared.surfaceUnder,
    "--color-border": derived.border,
    "--color-border-focus": derived.borderFocus,
    "--color-border-heavy": derived.borderHeavy,
    "--color-border-light": derived.borderLight,
    "--color-decoration-added": prepared.theme.semanticColors.diffAdded,
    "--color-decoration-modified": prepared.theme.semanticColors.diffModified,
    "--color-decoration-deleted": prepared.theme.semanticColors.diffRemoved,
    "--color-editor-added": toRgba(
      parseHex(prepared.theme.semanticColors.diffAdded),
      variant === "light" ? 0.15 : 0.23,
    ),
    "--color-editor-deleted": toRgba(
      parseHex(prepared.theme.semanticColors.diffRemoved),
      variant === "light" ? 0.15 : 0.23,
    ),
    "--color-icon-accent": derived.iconAccent,
    "--color-icon-error": prepared.theme.accentColors.red,
    "--color-icon-primary": derived.iconPrimary,
    "--color-icon-secondary": derived.iconSecondary,
    "--color-icon-tertiary": derived.iconTertiary,
    "--color-simple-scrim": derived.simpleScrim,
    "--color-text-accent": derived.textAccent,
    "--color-text-button-primary": derived.textButtonPrimary,
    "--color-text-button-secondary": derived.textButtonSecondary,
    "--color-text-button-tertiary": derived.textButtonTertiary,
    "--color-text-error": prepared.theme.accentColors.red,
    "--color-text-foreground": derived.textForeground,
    "--color-text-foreground-secondary": derived.textForegroundSecondary,
    "--color-text-foreground-tertiary": derived.textForegroundTertiary,
    "--color-text-warning": prepared.theme.accentColors.orange,
  };
}

export function applyCodexThemeVariant(
  root: HTMLElement,
  variant: ThemeVariant,
  body?: HTMLElement,
): void {
  const styles = getCodexThemeVariantStyle(variant);
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
  const controlBase = mixRgb(theme.surface, WHITE, 0.06 + theme.contrast * 0.05);
  const accentTextBase = mixRgb(theme.accent, WHITE, 0.3 + theme.contrast * 0.15);
  const buttonPrimaryBase = mixRgb(theme.surface, theme.ink, 0.38 + theme.contrast * 0.12);
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
    iconAccent: toRgb(accentTextBase),
    iconPrimary: toRgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: toRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: toRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    textAccent: toRgb(accentTextBase),
    textButtonPrimary: toRgb(buttonPrimaryBase),
    textButtonSecondary: mixHex(theme.ink, theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: toRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: DARK_PRIMARY_FOREGROUND,
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
