import { registerCustomTheme } from "@pierre/diffs";
import type { CodeViewProps, FileDiffProps, ThemeTypes, ThemesType } from "@pierre/diffs/react";
import type { CSSProperties } from "react";
import { CODE_BLOCK_SYNTAX_THEME, CODE_BLOCK_SYNTAX_THEME_NAME } from "./code-block-syntax-theme";

type DiffThemeType = Exclude<ThemeTypes, "system">;
type SharedDiffOptions = NonNullable<FileDiffProps<undefined>["options"]>;
type SharedSourceOptions = NonNullable<CodeViewProps["options"]>;
type SharedCodeOptions = Pick<
  SharedSourceOptions,
  "disableFileHeader" | "overflow" | "theme" | "themeType" | "unsafeCSS"
>;
type DiffHostStyle = Record<string, string>;

const CODE_ROW_LINE_HEIGHT = 1.8;

const NODEX_DIFF_THEME: ThemesType = {
  dark: "pierre-dark",
  light: "pierre-light",
};

export const NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT = 20;
export const NODEX_DIFF_HOST_CLASS = "nodex-inline-diff";
export const NODEX_SOURCE_HOST_CLASS = "nodex-source-file";

const NODEX_DIFF_ROOT_SELECTOR = ":is([data-diff], [data-file], [data-diffs])";
const NODEX_DIFF_HEADER_AND_ROOT_SELECTOR = `[data-diffs-header],
${NODEX_DIFF_ROOT_SELECTOR}`;

const NODEX_DIFF_HOST_STYLE_BASE: DiffHostStyle = {
  "--codex-diffs-surface":
    "var(--codex-diffs-surface-override, var(--color-token-main-surface-primary))",
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "var(--font-code-size, 12px)",
  "--diffs-line-height": `calc(var(--diffs-font-size, 12px) * ${CODE_ROW_LINE_HEIGHT})`,
  "--diffs-gap-inline": "6px",
  "--diffs-gap-block": "0",
  "--diffs-min-number-column-width": "4ch",
};

const NODEX_DIFF_HOST_STYLE_BY_THEME: Record<DiffThemeType, DiffHostStyle> = {
  dark: {
    "--diffs-addition-color-override": "#40c977",
    "--diffs-deletion-color-override": "#fa423e",
    "--diffs-modified-color-override": "#ff8549",
  },
  light: {
    "--diffs-addition-color-override": "#00a240",
    "--diffs-deletion-color-override": "#ba2623",
    "--diffs-modified-color-override": "#923b0f",
  },
};

export const NODEX_DIFF_UNSAFE_CSS = `
${NODEX_DIFF_HEADER_AND_ROOT_SELECTOR} {
  --codex-diffs-surface: var(
    --codex-diffs-surface-override,
    var(--color-token-main-surface-primary)
  );
  --codex-diffs-context-surface: color-mix(
    in srgb,
    var(--codex-diffs-surface) 94%,
    var(--color-token-main-surface-primary)
  );
  --codex-diffs-separator-surface: color-mix(
    in srgb,
    var(--codex-diffs-surface) 94%,
    var(--color-token-text-link-foreground)
  );
  --codex-diffs-hover-surface: color-mix(
    in srgb,
    var(--codex-diffs-surface) 92%,
    var(--color-token-main-surface-primary)
  );
  --codex-diffs-header-surface: var(--codex-diffs-surface);
  --codex-diffs-context-number: color-mix(
    in lab,
    var(--codex-diffs-surface) 98.5%,
    var(--diffs-mixer)
  );
  --codex-diffs-addition-number: light-dark(
    color-mix(in lab, var(--diffs-light-bg, #fff) 91%, var(--diffs-addition-base)),
    color-mix(in lab, var(--diffs-dark-bg, #000) 85%, var(--diffs-addition-base))
  );
  --codex-diffs-deletion-number: light-dark(
    color-mix(in lab, var(--diffs-light-bg, #fff) 91%, var(--diffs-deletion-base)),
    color-mix(in lab, var(--diffs-dark-bg, #000) 85%, var(--diffs-deletion-base))
  );
  --codex-diffs-addition-hover: light-dark(
    color-mix(in lab, var(--diffs-light-bg, #fff) 80%, var(--diffs-addition-base)),
    color-mix(in lab, var(--diffs-dark-bg, #000) 70%, var(--diffs-addition-base))
  );
  --codex-diffs-deletion-hover: light-dark(
    color-mix(in lab, var(--diffs-light-bg, #fff) 80%, var(--diffs-deletion-base)),
    color-mix(in lab, var(--diffs-dark-bg, #000) 75%, var(--diffs-deletion-base))
  );
  /* Keep unhighlighted lines readable while syntax tokens are pending. */
  --diffs-dark: var(--color-token-editor-foreground);
  --diffs-light: var(--color-token-editor-foreground);
  --diffs-bg: var(--codex-diffs-surface) !important;
  --diffs-bg-context-override: var(--codex-diffs-context-surface);
  --diffs-bg-separator-override: var(--codex-diffs-separator-surface);
  --diffs-bg-hover-override: var(--codex-diffs-hover-surface);
  background-color: var(--codex-diffs-surface) !important;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-utility-button] {
  background-color: var(--color-token-foreground);
  color: var(--color-token-side-bar-background);
  border: none;
  border-radius: 4px;
  margin-right: 0;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-utility-button]:hover {
  background-color: color-mix(
    in srgb,
    var(--color-token-foreground) 88%,
    var(--color-token-side-bar-background)
  );
}

${NODEX_DIFF_ROOT_SELECTOR} [data-selected-line][data-line-annotation] {
  background-color: var(--diffs-bg);
}

${NODEX_DIFF_ROOT_SELECTOR} [data-code] {
  scrollbar-gutter: auto;
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-addition']:is([data-line], [data-no-newline]) {
  --diffs-computed-diff-line-bg: var(--diffs-bg-addition);
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-addition']:is([data-column-number], [data-gutter-buffer]) {
  --diffs-computed-diff-line-bg: var(--codex-diffs-addition-number);
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-deletion']:is([data-line], [data-no-newline]) {
  --diffs-computed-diff-line-bg: var(--diffs-bg-deletion);
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-deletion']:is([data-column-number], [data-gutter-buffer]) {
  --diffs-computed-diff-line-bg: var(--codex-diffs-deletion-number);
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-addition'][data-hovered]:not([data-selected-line]) {
  --diffs-computed-hovered-line-bg: var(--codex-diffs-addition-hover);
}

${NODEX_DIFF_ROOT_SELECTOR}
  [data-line-type='change-deletion'][data-hovered]:not([data-selected-line]) {
  --diffs-computed-hovered-line-bg: var(--codex-diffs-deletion-hover);
}

/* Cover fractional-pixel seams between consecutive solid addition markers. */
${NODEX_DIFF_ROOT_SELECTOR} [data-line-type="change-addition"][data-column-number]
  + [data-line-type="change-addition"][data-column-number]::before {
  contain: none;
  top: -1px;
  height: calc(100% + 1px);
}

mark.codex-thread-find-match {
  background-color: var(--content-search-match-background);
  color: var(--color-token-foreground);
  border-radius: var(--radius-2xs);
  padding: 0;
  margin: 0;
  border: 0;
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  word-spacing: inherit;
  vertical-align: baseline;
}

mark.codex-thread-find-active {
  background-color: var(--content-search-active-match-background);
}

:host(.${NODEX_DIFF_HOST_CLASS}) [data-separator]:empty {
  background-color: transparent;
}

:host(.${NODEX_DIFF_HOST_CLASS}) [data-separator]:empty::after {
  content: "";
  grid-column: 2 / 3;
  align-self: center;
  margin-inline: 1ch;
  border-top: 1px solid color-mix(in srgb, var(--diffs-fg) 18%, transparent);
}

`;

const NODEX_REVIEW_DIFF_UNSAFE_CSS = `
${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-expand-button],
${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-separator-content] {
  background-color: color-mix(
    in srgb,
    var(--color-token-list-active-selection-background) 56%,
    var(--diffs-bg)
  );
}

${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-expand-button] {
  border-inline-end: 1px solid var(--diffs-bg);
  border-start-start-radius: 8px;
  border-end-start-radius: 8px;
  width: auto;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-up] {
  border-end-start-radius: 0;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-down] {
  border-start-start-radius: 0;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-separator-content] {
  border-start-end-radius: 8px;
  border-end-end-radius: 8px;
}

${NODEX_DIFF_ROOT_SELECTOR} [data-separator="line-info"] [data-separator-wrapper] {
  grid-template-columns: var(--diffs-column-number-width) auto;
  padding-inline: 2px;
}
`;

export function getNodexDiffHostStyle(themeType: DiffThemeType): CSSProperties {
  return {
    ...NODEX_DIFF_HOST_STYLE_BASE,
    ...NODEX_DIFF_HOST_STYLE_BY_THEME[themeType],
  } as CSSProperties;
}

export function getNodexSourceLineHeight(codeFontSize: number): number {
  return codeFontSize * CODE_ROW_LINE_HEIGHT;
}

/** Editable rows and their caret overlays share an integer pixel grid. */
export function getNodexSourceEditorLineHeight(codeFontSize: number): number {
  return Math.round(getNodexSourceLineHeight(codeFontSize));
}

export function getNodexSourceEditorHostStyle(
  themeType: DiffThemeType,
  codeFontSize: number,
): CSSProperties {
  return {
    ...getNodexDiffHostStyle(themeType),
    "--diffs-line-height": `${getNodexSourceEditorLineHeight(codeFontSize)}px`,
  } as CSSProperties;
}

export function getNodexDiffOptions(
  themeType: DiffThemeType,
  disableFileHeader: boolean,
  opts?: {
    diffStyle?: SharedDiffOptions["diffStyle"];
    overflow?: SharedDiffOptions["overflow"];
    wrap?: boolean;
    lineDiffType?: SharedDiffOptions["lineDiffType"];
  },
): SharedDiffOptions {
  return {
    ...getNodexCodeOptions(themeType, disableFileHeader, {
      overflow: opts?.overflow,
      wrap: opts?.wrap,
    }),
    diffStyle: opts?.diffStyle ?? "unified",
    diffIndicators: "bars",
    lineDiffType: opts?.lineDiffType ?? "none",
    hunkSeparators: "simple",
  };
}

/** Files and diffs use the source palette; code blocks use the shared code-block palette. */
export type NodexSyntaxTheme = "source" | "code-block";

const codeBlockThemeRegistration = Symbol.for("nodex.codeBlockSyntaxThemeRegistered");

/** Registers the code-block theme with the source viewer's highlighter on first use. */
function codeBlockSyntaxThemes(): ThemesType {
  const registry = globalThis as typeof globalThis & { [codeBlockThemeRegistration]?: true };
  if (!registry[codeBlockThemeRegistration]) {
    registerCustomTheme(CODE_BLOCK_SYNTAX_THEME_NAME, () =>
      Promise.resolve(CODE_BLOCK_SYNTAX_THEME),
    );
    registry[codeBlockThemeRegistration] = true;
  }
  return { light: CODE_BLOCK_SYNTAX_THEME_NAME, dark: CODE_BLOCK_SYNTAX_THEME_NAME };
}

function getNodexCodeOptions(
  themeType: DiffThemeType,
  disableFileHeader: boolean,
  opts?: {
    overflow?: SharedCodeOptions["overflow"];
    wrap?: boolean;
    syntaxTheme?: NodexSyntaxTheme;
  },
): SharedCodeOptions {
  return {
    theme: opts?.syntaxTheme === "code-block" ? codeBlockSyntaxThemes() : NODEX_DIFF_THEME,
    themeType,
    overflow: opts?.overflow ?? (opts?.wrap ? "wrap" : "scroll"),
    unsafeCSS: NODEX_DIFF_UNSAFE_CSS,
    disableFileHeader,
  };
}

export function getNodexSourceOptions(
  themeType: DiffThemeType,
  disableFileHeader: boolean,
  opts?: {
    disableLineNumbers?: boolean;
    overflow?: SharedSourceOptions["overflow"];
    wrap?: boolean;
    syntaxTheme?: NodexSyntaxTheme;
  },
): SharedSourceOptions {
  return {
    ...getNodexCodeOptions(themeType, disableFileHeader, opts),
    disableLineNumbers: opts?.disableLineNumbers,
  };
}

export function getNodexReviewDiffOptions(
  themeType: DiffThemeType,
  disableFileHeader: boolean,
  opts?: {
    diffStyle?: SharedDiffOptions["diffStyle"];
    overflow?: SharedDiffOptions["overflow"];
    wrap?: boolean;
    lineDiffType?: SharedDiffOptions["lineDiffType"];
    collapsed?: SharedDiffOptions["collapsed"];
  },
): SharedDiffOptions {
  const options = getNodexDiffOptions(themeType, disableFileHeader, {
    ...opts,
    lineDiffType: opts?.lineDiffType ?? "word-alt",
  });

  return {
    ...options,
    hunkSeparators: "line-info",
    collapsedContextThreshold: 1,
    expansionLineCount: NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT,
    collapsed: opts?.collapsed,
    unsafeCSS: `${options.unsafeCSS ?? ""}\n${NODEX_REVIEW_DIFF_UNSAFE_CSS}`,
  };
}
