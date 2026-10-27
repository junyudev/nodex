import added from "@/components/shared/icons/file-tree-added.svg?raw";
import deleted from "@/components/shared/icons/file-tree-deleted.svg?raw";
import modified from "@/components/shared/icons/file-tree-modified.svg?raw";

const maskUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

export interface FileTreeThemeOptions {
  /** The surface the tree sits on; dropdown trees match their elevated popover. */
  readonly surface?: "main" | "dropdown";
  /** Synthetic top-level sections, divided by a rule, with status-colored labels. */
  readonly sectioned?: boolean;
  /** `end` pushes row decorations to the trailing edge instead of after the label. */
  readonly decorationAlignment?: "inline" | "end";
}

function hostVariables({
  background,
  fontSize,
  itemPaddingX,
  modifiedColor,
  rowGap,
}: {
  readonly background: string;
  readonly fontSize: string;
  readonly itemPaddingX: string;
  readonly modifiedColor: string;
  readonly rowGap: string;
}): string {
  return `
:host {
  --trees-bg-override: ${background};
  --trees-bg-muted-override: var(--color-background-primary-ghost-hover);
  --trees-border-color-override: var(--color-border);
  --trees-fg-override: var(--color-text);
  --trees-font-family-override: var(--font-sans);
  --trees-font-size-override: ${fontSize};
  --trees-focus-ring-color-override: var(--color-ring);
  --trees-git-added-color-override: var(--color-codex-git-added);
  --trees-git-deleted-color-override: var(--color-codex-git-deleted);
  --trees-git-ignored-color-override: var(--color-codex-git-ignored);
  --trees-git-lane-width-override: 20px;
  --trees-git-modified-color-override: ${modifiedColor};
  --trees-git-renamed-color-override: ${modifiedColor};
  --trees-git-untracked-color-override: var(--color-codex-git-added);
  --trees-item-padding-x-override: ${itemPaddingX};
  --trees-item-margin-x-override: 0px;
  --trees-level-gap-override: 0px;
  --trees-padding-inline-override: 0px;
  --trees-scrollbar-gutter-override: 0px;
  --trees-scrollbar-gutter-measured: 0px;
  --trees-selected-bg-override: var(--color-background-primary-soft-active);
  --trees-selected-fg-override: var(--color-text-emphasis);
  --trees-item-row-gap-override: ${rowGap};
}
[data-file-tree-sticky-overlay-content='true'],
[data-file-tree-sticky-row='true'] { background-color: ${background}; }`;
}

const SHARED_RULES = `
[data-file-tree-virtualized-scroll='true'] { scrollbar-gutter: auto; }
[role='treeitem'], [role='treeitem'] * { cursor: var(--cursor-interaction) !important; }
[data-item-type='file'][data-item-path$='/']:has([data-item-section='content']:empty) { display: none; }
[data-item-git-status='added'] > [data-item-section='git'] > span,
[data-item-git-status='deleted'] > [data-item-section='git'] > span,
[data-item-git-status='modified'] > [data-item-section='git'] > span { font-size: 0; }
[data-item-git-status='added'] > [data-item-section='git'] > span::before,
[data-item-git-status='deleted'] > [data-item-section='git'] > span::before,
[data-item-git-status='modified'] > [data-item-section='git'] > span::before {
  width: 20px;
  height: 20px;
  background-color: currentColor;
  content: '';
  mask: var(--file-tree-git-status-icon) center / contain no-repeat;
}
[data-item-git-status='added'] > [data-item-section='git'] > span::before { --file-tree-git-status-icon: ${maskUrl(added)}; }
[data-item-git-status='deleted'] > [data-item-section='git'] > span::before { --file-tree-git-status-icon: ${maskUrl(deleted)}; }
[data-item-git-status='modified'] > [data-item-section='git'] > span::before { --file-tree-git-status-icon: ${maskUrl(modified)}; }
/* Subpixel one-line overflow must not produce a false truncation marker. */
@container measure (height <= calc(1lh + 1px)) { [data-truncate-marker] { opacity: 0; } }
`;

/** Shadow-root styling for workspace trees; the tree owns layout, interaction, and status aggregation. */
export function fileTreeCss({
  surface = "main",
  sectioned = false,
  decorationAlignment = "inline",
}: FileTreeThemeOptions = {}): string {
  return `${hostVariables({
    background:
      surface === "dropdown" ? "var(--color-surface-elevated-secondary)" : "var(--color-surface)",
    // 13px at the default UI size, following the UI font size preference.
    fontSize: "var(--text-sm)",
    itemPaddingX: "3px",
    modifiedColor: sectioned ? "var(--color-blue)" : "var(--color-codex-git-modified)",
    rowGap: "5px",
  })}
/* Halve indentation while keeping guides aligned with full-size icon centers. */
[data-item-section='spacing']:not(:empty) { margin-right: calc((1px - var(--trees-icon-width)) / 4); }
[data-item-section='spacing-item'] + [data-item-section='spacing-item'] {
  margin-left: calc(var(--trees-item-row-gap) + (var(--trees-icon-width) - 1px) / 4);
}
[data-item-type='file'] > [data-item-section='spacing']:not(:empty) { margin-right: 0; }
[data-item-git-status] > [data-item-section='content'] {
  color: ${sectioned ? "var(--trees-item-git-status-color)" : "inherit"};
}
/* Preserve spaces when a label is split into truncation segments. */
[data-truncate-content='visible'] { white-space: pre; }
${sectioned ? "[role='treeitem'][aria-level='1'][aria-posinset='2'] { border-top: 1px solid var(--color-border); }" : ""}
${decorationAlignment === "end" ? "[data-item-section='decoration'] { flex: 1 0 auto; justify-content: flex-end; }" : ""}
/* Clip at the row edge instead of shortening every folder or filename. */
[data-item-flattened-subitems], [data-truncate-group-container='middle'] { min-width: max-content; }
${SHARED_RULES}`;
}

export const REVIEW_FILE_TREE_CSS = `${hostVariables({
  background: "var(--color-surface)",
  fontSize: "var(--text-sm)",
  itemPaddingX: "6px",
  modifiedColor: "var(--color-codex-git-modified)",
  rowGap: "10px",
})}
[data-item-git-status] > [data-item-section='content'] { color: inherit; }
${SHARED_RULES}
[data-item-type='file'] { color: color-mix(in oklab, var(--codex-base-ink, var(--color-text)) 50%, transparent); }
[data-item-type='file']:hover,
[data-item-type='file'][aria-selected='true'] { color: var(--color-text); }
`;
