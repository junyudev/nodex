const DEFAULT_FALLBACK_VALUE = "var(--color-text-foreground)";

const EXACT_MAPPINGS: Readonly<Record<string, string>> = {
  foreground: "var(--color-text-foreground)",
  disabledForeground: "var(--color-text-foreground-tertiary)",
  descriptionForeground: "var(--color-text-foreground-tertiary)",
  errorForeground: "var(--color-text-error)",
  focusBorder: "var(--color-border-focus)",
  contrastBorder: "var(--border-strong)",
  contrastActiveBorder: "var(--accent-blue)",
  "icon.foreground": "var(--color-icon-primary)",
  "badge.background": "var(--color-background-button-secondary)",
  "badge.foreground": "var(--color-text-foreground-secondary)",
  "scrollbarSlider.background": "var(--color-border)",
  "scrollbarSlider.hoverBackground": "var(--color-border-heavy)",
  "scrollbarSlider.activeBackground": "var(--color-border-heavy)",
  "titleBar.activeBackground": "var(--background-secondary)",
  "titleBar.inactiveBackground": "var(--background-tertiary)",
  "titleBar.activeForeground": "var(--color-text-foreground)",
  "titleBar.inactiveForeground": "var(--color-text-foreground-tertiary)",
  "titleBar.border": "var(--border)",
  "editor.background": "var(--background)",
  "editor.foreground": "var(--color-text-foreground)",
  "input.background": "var(--color-background-elevated-primary)",
  "input.foreground": "var(--color-text-foreground)",
  "input.border": "var(--input)",
  "input.placeholderForeground": "var(--color-text-foreground-tertiary)",
  "dropdown.background": "var(--color-background-elevated-primary-opaque)",
  "dropdown.foreground": "var(--color-text-foreground)",
  "dropdown.border": "var(--border)",
  "dropdown.listBackground": "var(--color-background-elevated-primary)",
  "textLink.foreground": "var(--color-text-accent)",
  "textLink.activeForeground": "var(--color-text-accent)",
  "textSeparator.foreground": "var(--color-text-foreground)",
  "textPreformat.foreground": "var(--color-text-foreground)",
  "textPreformat.background": "var(--color-background-elevated-secondary)",
  "textPreformat.border": "var(--border)",
  "textBlockQuote.background": "var(--color-background-elevated-secondary)",
  "textBlockQuote.border": "var(--color-border)",
  "textCodeBlock.background": "var(--color-border)",
  "statusBar.debuggingBackground": "var(--accent-blue)",
  "statusBar.debuggingForeground": "var(--color-text-foreground)",
  "statusBar.noFolderBackground": "var(--background-tertiary)",
  "sideBar.background": "var(--color-background-surface)",
  "sideBar.dropBackground": "color-mix(in srgb, var(--accent-blue) 18%, var(--sidebar))",
  "sideBarStickyScroll.background": "var(--background-secondary)",
  "sideBarStickyScroll.shadow": "var(--border-secondary)",
  "editorError.foreground": "var(--color-text-error)",
  "editorWarning.foreground": "var(--color-text-warning)",
  "editorInfo.foreground": "var(--color-text-accent)",
  "editorHint.foreground": "var(--color-text-accent)",
  "chart.line": "var(--color-text-foreground)",
  "chart.axis": "var(--color-text-foreground-tertiary)",
  "chart.guide": "var(--color-text-foreground-tertiary)",
  "charts.red": "var(--color-accent-red)",
  "charts.green": "var(--color-accent-green)",
  "charts.blue": "var(--color-accent-blue)",
  "charts.yellow": "var(--color-accent-yellow)",
  "charts.orange": "var(--color-accent-orange)",
  "charts.purple": "var(--color-accent-purple)",
};

const LEGACY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["--color-token-description-foreground", "var(--vscode-descriptionForeground)"],
  [
    "--color-token-scrollbar-slider-hover-background",
    "var(--vscode-scrollbarSlider-hoverBackground)",
  ],
];

const SUFFIX_FALLBACKS: ReadonlyArray<readonly [string, string]> = [
  ["activefocusborder", "var(--color-border-focus)"],
  ["focusborder", "var(--color-border-focus)"],
  ["activeborder", "var(--accent-blue)"],
  ["inactiveborder", "var(--border)"],
  ["activeforeground", "var(--color-text-foreground)"],
  ["inactiveforeground", "var(--color-text-foreground-tertiary)"],
  ["secondaryforeground", "var(--color-text-foreground-secondary)"],
  ["secondarybackground", "var(--background-secondary)"],
  ["secondaryborder", "var(--border)"],
  ["activebackground", "color-mix(in srgb, var(--accent-blue) 16%, var(--background))"],
  ["inactivebackground", "var(--background-secondary)"],
  ["hoverbackground", "var(--background-secondary)"],
  ["hoverforeground", "var(--color-text-foreground)"],
  ["dropbackground", "color-mix(in srgb, var(--accent-blue) 16%, var(--background))"],
  ["selectionbackground", "color-mix(in srgb, var(--accent-blue) 22%, var(--background))"],
  ["selectionforeground", "var(--color-text-foreground)"],
  ["findmatchbackground", "color-mix(in srgb, var(--status-ready-bg) 75%, var(--background))"],
  ["findmatchforeground", "var(--status-ready-text)"],
  ["findmatchborder", "var(--status-ready-text)"],
  ["errorforeground", "var(--color-text-error)"],
  ["warningforeground", "var(--color-text-warning)"],
  ["infoforeground", "var(--color-text-accent)"],
  ["descriptionforeground", "var(--color-text-foreground-tertiary)"],
  ["placeholderforeground", "var(--color-text-foreground-tertiary)"],
  ["border", "var(--border)"],
  ["foreground", "var(--color-text-foreground)"],
  ["background", "var(--background-secondary)"],
  ["shadow", "color-mix(in srgb, var(--color-text-foreground) 14%, transparent)"],
  ["outline", "var(--color-border-focus)"],
];

function resolveSideBarValue(key: string): string | null {
  if (!key.startsWith("sideBar")) return null;

  if (key.includes("SectionHeader")) {
    if (key.endsWith("background")) return "var(--background-secondary)";
    if (key.endsWith("foreground")) return "var(--sidebar-foreground)";
    if (key.endsWith("border")) return "var(--sidebar-border)";
  }

  if (key.includes("Title")) {
    if (key.endsWith("background")) return "var(--sidebar)";
    if (key.endsWith("foreground")) return "var(--sidebar-foreground)";
  }

  if (key.includes("ActivityBarTop") && key.endsWith("border")) {
    return "var(--sidebar-border)";
  }

  if (key.endsWith("background")) return "var(--sidebar)";
  if (key.endsWith("foreground")) return "var(--sidebar-foreground)";
  if (key.endsWith("border")) return "var(--sidebar-border)";
  return null;
}

function resolveActivityBarValue(key: string): string | null {
  if (!key.startsWith("activityBar")) return null;

  if (key.endsWith("background")) return "var(--background-secondary)";
  if (key.endsWith("inactiveForeground")) return "var(--color-text-foreground-tertiary)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("activeBorder")) return "var(--color-border-heavy)";
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolvePanelValue(key: string): string | null {
  if (!key.startsWith("panel")) return null;

  if (key.endsWith("background")) return "var(--background-secondary)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolveStatusBarValue(key: string): string | null {
  if (!key.startsWith("statusBar")) return null;

  if (key.endsWith("background")) return "var(--background-secondary)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("border")) return "var(--border)";
  if (key.endsWith("focusBorder")) return "var(--color-border-focus)";
  return null;
}

function resolveTabValue(key: string): string | null {
  if (!key.startsWith("tab.")) return null;

  if (key.endsWith("activeBackground")) return "var(--background)";
  if (key.endsWith("inactiveBackground")) return "var(--background-secondary)";
  if (key.endsWith("activeForeground")) return "var(--color-text-foreground)";
  if (key.endsWith("inactiveForeground")) return "var(--color-text-foreground-tertiary)";
  if (key.endsWith("activeBorderTop") || key.endsWith("selectedBorderTop")) {
    return "var(--accent-blue)";
  }
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolveListValue(key: string): string | null {
  if (!key.startsWith("list.")) return null;

  if (key.endsWith("activeSelectionBackground")) return "var(--background-secondary)";
  if (key.endsWith("activeSelectionForeground")) return "var(--color-text-foreground)";
  if (key.endsWith("activeSelectionIconForeground")) return "var(--color-icon-primary)";
  if (key.endsWith("inactiveSelectionBackground")) return "var(--background-secondary)";
  if (key.endsWith("hoverBackground")) return "var(--background-secondary)";
  if (key.endsWith("dropBackground")) {
    return "color-mix(in srgb, var(--accent-blue) 18%, var(--background))";
  }
  if (key.endsWith("highlightForeground")) return "var(--color-text-foreground)";
  if (key.endsWith("errorForeground")) return "var(--color-text-error)";
  if (key.endsWith("warningForeground")) return "var(--color-text-warning)";
  return null;
}

function resolveTerminalValue(key: string): string | null {
  if (!key.startsWith("terminal.")) return null;

  const ansiMap: Readonly<Record<string, string>> = {
    "terminal.ansiBlack": "var(--color-text-foreground-tertiary)",
    "terminal.ansiRed": "var(--color-accent-red)",
    "terminal.ansiGreen": "var(--color-accent-green)",
    "terminal.ansiYellow": "var(--color-accent-yellow)",
    "terminal.ansiBlue": "var(--color-accent-blue)",
    "terminal.ansiMagenta": "var(--color-accent-purple)",
    "terminal.ansiCyan": "var(--color-accent-blue)",
    "terminal.ansiWhite": "var(--color-text-foreground)",
    "terminal.ansiBrightBlack": "var(--color-text-foreground-secondary)",
    "terminal.ansiBrightRed": "var(--color-accent-red)",
    "terminal.ansiBrightGreen": "var(--color-accent-green)",
    "terminal.ansiBrightYellow": "var(--color-accent-yellow)",
    "terminal.ansiBrightBlue": "var(--color-accent-blue)",
    "terminal.ansiBrightMagenta": "var(--color-accent-purple)",
    "terminal.ansiBrightCyan": "var(--color-accent-blue)",
    "terminal.ansiBrightWhite": "var(--color-text-foreground)",
  };

  const ansiColor = ansiMap[key];
  if (ansiColor) return ansiColor;

  if (key.endsWith("background")) return "var(--background)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolveButtonValue(key: string): string | null {
  if (!key.startsWith("button.")) return null;

  if (key === "button.background" || key === "button.hoverBackground") {
    return "var(--accent-blue)";
  }
  if (key === "button.foreground") return "var(--color-text-button-primary)";
  if (key === "button.secondaryBackground" || key === "button.secondaryHoverBackground") {
    return "var(--background-tertiary)";
  }
  if (key === "button.secondaryForeground") return "var(--color-text-button-secondary)";
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolveMenuValue(key: string): string | null {
  if (!key.startsWith("menu.")) return null;

  if (key.endsWith("background")) return "var(--background)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("border")) return "var(--border)";
  if (key.endsWith("selectionBackground")) return "var(--accent-blue)";
  if (key.endsWith("selectionForeground")) return "var(--color-text-button-primary)";
  return null;
}

function resolveEditorValue(key: string): string | null {
  if (!key.startsWith("editor")) return null;

  if (key === "editor.background") return "var(--background)";
  if (key === "editor.foreground") return "var(--color-text-foreground)";
  if (key.includes("LineNumber") && key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (
    (key.includes("GhostText") || key.includes("CodeLens") || key.includes("foldPlaceholder")) &&
    key.endsWith("foreground")
  ) {
    return "var(--color-text-foreground-tertiary)";
  }
  if (key.endsWith("selectionBackground")) {
    return "color-mix(in srgb, var(--accent-blue) 22%, var(--background))";
  }
  if (key.endsWith("selectionForeground")) return "var(--color-text-foreground)";
  if (key.endsWith("background")) return "var(--background-secondary)";
  if (key.endsWith("foreground")) return "var(--color-text-foreground)";
  if (key.endsWith("border")) return "var(--border)";
  return null;
}

function resolveByPrefix(key: string): string | null {
  const resolvers: ReadonlyArray<(token: string) => string | null> = [
    resolveSideBarValue,
    resolveActivityBarValue,
    resolvePanelValue,
    resolveStatusBarValue,
    resolveTabValue,
    resolveListValue,
    resolveTerminalValue,
    resolveButtonValue,
    resolveMenuValue,
    resolveEditorValue,
  ];

  for (const resolve of resolvers) {
    const result = resolve(key);
    if (result) return result;
  }

  return null;
}

function resolveBySuffix(key: string): string {
  const lowerKey = key.toLowerCase();

  for (const [suffix, value] of SUFFIX_FALLBACKS) {
    if (lowerKey.endsWith(suffix)) return value;
  }

  return DEFAULT_FALLBACK_VALUE;
}

function normalizeTokenKey(rawKey: string): string {
  return rawKey.trim();
}

export function parseVscodeTokenKeys(contents: string): string[] {
  const seen = new Set<string>();
  const parsed: string[] = [];

  for (const line of contents.split("\n")) {
    const key = normalizeTokenKey(line);
    if (!key || key.startsWith("#")) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    parsed.push(key);
  }

  return parsed;
}

export function toVscodeCssVariableName(key: string): string {
  return `--vscode-${normalizeTokenKey(key).replace(/\./g, "-")}`;
}

export function resolveVscodeTokenValue(key: string): string {
  const normalizedKey = normalizeTokenKey(key);
  if (!normalizedKey) return DEFAULT_FALLBACK_VALUE;

  const exact = EXACT_MAPPINGS[normalizedKey];
  if (exact) return exact;

  const prefixed = resolveByPrefix(normalizedKey);
  if (prefixed) return prefixed;

  return resolveBySuffix(normalizedKey);
}

export function buildVscodeTokenCss(keys: readonly string[]): string {
  const normalizedKeys = parseVscodeTokenKeys(keys.join("\n"));

  const declarations = normalizedKeys.map(
    (key) => `  ${toVscodeCssVariableName(key)}: ${resolveVscodeTokenValue(key)};`,
  );

  const legacyAliasDeclarations = LEGACY_ALIASES.map(
    ([alias, value]) => `  ${alias}: ${value};`,
  );

  return [
    "/* AUTO-GENERATED FILE. DO NOT EDIT. */",
    "/* Generated by: bun run scripts/generate-vscode-theme-vars.ts */",
    ":root {",
    ...declarations,
    ...legacyAliasDeclarations,
    "}",
    "",
  ].join("\n");
}
