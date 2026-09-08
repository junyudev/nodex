import added from "@/components/shared/icons/file-tree-added.svg?raw";
import deleted from "@/components/shared/icons/file-tree-deleted.svg?raw";
import modified from "@/components/shared/icons/file-tree-modified.svg?raw";

const maskUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/** Shared shadow-root styling; the tree owns layout, interaction, and status aggregation. */
export const FILE_TREE_CSS = `
:host {
  --trees-bg-override: var(--color-background-surface);
  --trees-bg-muted-override: var(--color-background-primary-ghost-hover);
  --trees-border-color-override: var(--color-border);
  --trees-fg-override: var(--color-text);
  --trees-font-size-override: 13px;
  --trees-focus-ring-color-override: var(--color-ring);
  --trees-git-added-color-override: var(--color-decoration-added);
  --trees-git-deleted-color-override: var(--color-decoration-deleted);
  --trees-git-ignored-color-override: var(--color-decoration-modified);
  --trees-git-lane-width-override: 20px;
  --trees-git-modified-color-override: var(--color-decoration-modified);
  --trees-git-renamed-color-override: var(--color-decoration-modified);
  --trees-git-untracked-color-override: var(--color-decoration-added);
  --trees-item-padding-x-override: 6px;
  --trees-item-margin-x-override: 0px;
  --trees-level-gap-override: 0px;
  --trees-padding-inline-override: 0px;
  --trees-scrollbar-gutter-override: 0px;
  --trees-scrollbar-gutter-measured: 0px;
  --trees-selected-bg-override: var(--color-background-primary-soft-active);
  --trees-selected-fg-override: var(--color-text-emphasis);
  --trees-item-row-gap-override: 10px;
}
[data-file-tree-sticky-overlay-content='true'],
[data-file-tree-sticky-row='true'] { background-color: var(--color-background-surface); }
[data-file-tree-virtualized-scroll='true'] { scrollbar-gutter: auto; }
[role='treeitem'], [role='treeitem'] * { cursor: var(--cursor-interaction) !important; }
[data-item-type='file'][data-item-path$='/']:has([data-item-section='content']:empty) { display: none; }
[data-item-git-status] > [data-item-section='content'] { color: inherit; }
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

export const REVIEW_FILE_TREE_CSS = `${FILE_TREE_CSS}
[data-item-type='file'] { color: color-mix(in oklab, var(--codex-base-ink, var(--color-text)) 50%, transparent); }
[data-item-type='file']:hover,
[data-item-type='file'][aria-selected='true'] { color: var(--color-text); }
`;
