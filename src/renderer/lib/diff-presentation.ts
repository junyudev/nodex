import type { FileDiffProps, ThemeTypes, ThemesType } from "@pierre/diffs/react";
import type { CSSProperties } from "react";

type DiffThemeType = Exclude<ThemeTypes, "system">;
type SharedDiffOptions = NonNullable<FileDiffProps<undefined>["options"]>;
type DiffHostStyle = Record<string, string>;

const NODEX_DIFF_THEME: ThemesType = {
  dark: "pierre-dark",
  light: "pierre-light",
};

const NODEX_DIFF_HOST_STYLE_BASE: DiffHostStyle = {
  "--nodex-diffs-surface": "color-mix(in srgb, var(--background-secondary) 95%, var(--foreground))",
  "--nodex-diffs-context-number": "color-mix(in lab, var(--nodex-diffs-surface) 98.5%, var(--diffs-mixer))",
  "--nodex-diffs-addition-number":
    "color-mix(in srgb, var(--nodex-diffs-surface) 91%, var(--diffs-addition-color-override))",
  "--nodex-diffs-deletion-number":
    "color-mix(in srgb, var(--nodex-diffs-surface) 91%, var(--diffs-deletion-color-override))",
  "--nodex-diffs-number-foreground": "var(--foreground-tertiary)",
  "--nodex-diffs-header-foreground": "var(--foreground-secondary)",
  "--diffs-font-size": "var(--vscode-editor-font-size, 14px)",
  "--diffs-line-height":
    "calc(var(--diffs-font-size, var(--vscode-editor-font-size, 14px)) * 1.8)",
  "--diffs-gap-inline": "6px",
  "--diffs-gap-block": "0",
  "--diffs-min-number-column-width": "4ch",
  "--diffs-fg-number-override": "var(--nodex-diffs-number-foreground)",
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

export const NODEX_DIFF_HOST_CLASS = "nodex-inline-diff";

export const NODEX_DIFF_UNSAFE_CSS = `
[data-separator-first] {
  padding-block-start: 8px;
}

[data-separator-content]:first-child {
  margin-left: 34px;
}

[data-diffs-header],
[data-diffs] {
  --diffs-bg: transparent;
  --diffs-bg-context: transparent;
  --diffs-bg-buffer: transparent;
  --diffs-bg-hover: transparent;
  --diffs-bg-buffer-override: transparent;
  --diffs-bg-separator-override: transparent;
  --nodex-diffs-expandable-section: color-mix(
    in srgb,
    var(--nodex-diffs-context-number, var(--nodex-diffs-surface)) 50%,
    transparent
  );
  --nodex-diffs-expandable-foreground: var(
    --nodex-diffs-header-foreground,
    var(--diffs-fg-number)
  );
  background-color: transparent;
}

[data-diffs][data-background] [data-column-number] {
  background-color: var(--nodex-diffs-surface, var(--background-secondary));
}

[data-diffs][data-background]
  [data-line-type="context-expanded"]
  [data-column-number] {
  background-color: var(
    --nodex-diffs-context-number,
    var(--nodex-diffs-surface, var(--background-secondary))
  );
}

[data-diffs][data-background]
  [data-line-type="change-addition"]
  [data-column-number] {
  background-color: var(
    --nodex-diffs-addition-number,
    var(--nodex-diffs-surface, var(--background-secondary))
  );
}

[data-diffs][data-background]
  [data-line-type="change-deletion"]
  [data-column-number] {
  background-color: var(
    --nodex-diffs-deletion-number,
    var(--nodex-diffs-surface, var(--background-secondary))
  );
}

[data-diffs][data-background]
  [data-separator="line-info"]
  [data-separator-wrapper],
[data-diffs][data-background]
  [data-separator="line-info"]
  [data-expand-button],
[data-diffs][data-background]
  [data-separator="line-info"]
  [data-separator-content] {
  background-color: var(--nodex-diffs-expandable-section);
}

[data-diffs] [data-separator="line-info"] [data-separator-wrapper] {
  color: var(--nodex-diffs-expandable-foreground);
}

[data-diffs] [data-separator="line-info"] [data-expand-button] {
  width: 44px;
}

[data-diffs][data-overflow="scroll"][data-type="file"]
  [data-separator="line-info"]
  [data-separator-wrapper],
[data-diffs][data-overflow="scroll"][data-type="split"]
  [data-deletions]
  [data-separator="line-info"]
  [data-separator-wrapper] {
  position: sticky;
  left: var(--diffs-gap-inline, var(--diffs-gap-fallback));
  z-index: 1;
}

[data-diffs][data-overflow="scroll"][data-type="split"]
  [data-additions]
  [data-separator="line-info"]
  [data-separator-wrapper] {
  position: sticky;
  left: 0;
  z-index: 1;
}

[data-separator="line-info"][data-separator-last] {
  margin-bottom: 8px;
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

export function getNodexDiffHostStyle(themeType: DiffThemeType): CSSProperties {
  return {
    ...NODEX_DIFF_HOST_STYLE_BASE,
    ...NODEX_DIFF_HOST_STYLE_BY_THEME[themeType],
  } as CSSProperties;
}

export function getNodexDiffOptions(
  themeType: DiffThemeType,
  disableFileHeader: boolean,
): SharedDiffOptions {
  return {
    theme: NODEX_DIFF_THEME,
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    overflow: "scroll",
    hunkSeparators: "simple",
    unsafeCSS: NODEX_DIFF_UNSAFE_CSS,
    disableFileHeader,
  };
}
