import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type {
  FileTree as PierreFileTreeModel,
  FileTreeOptions,
  FileTreeScrollOffset,
  FileTreeSortComparator,
} from "@pierre/trees";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  applyFileTreeExpansion,
  buildFileTreeInput,
  diffFileTreePaths,
  getFileTreeEventPath,
  type FileTreeFolderHandle,
} from "@/lib/file-tree-paths";
import { runSyncWithCleanup } from "@/lib/run-with-cleanup";
import { cn } from "@/lib/utils";
import { withFileTreeElement } from "./file-tree-dom";
import { FileTreeLoadingRows } from "./file-tree-loading-rows";
import { fileTreeCss, REVIEW_FILE_TREE_CSS, type FileTreeThemeOptions } from "./file-tree-theme";

export interface FileTreeProps extends FileTreeThemeOptions {
  /** Files, and folders as `folder/`; containing folders are implied. */
  readonly paths: readonly string[];
  readonly ariaLabel: string;
  readonly appearance: "review" | "workspace";
  /**
   * Folders whose own disclosure is open, without a trailing slash. A collapsed folder keeps its
   * descendants' expansion for the next time it opens. The mounted tree owns expansion: it reports
   * changes through `onExpandedPathsChange`, and applies only changes to this list and the state
   * of folders that newly appear.
   */
  readonly expandedPaths: readonly string[];
  /** Expanded folders whose entries are still loading; each shows a placeholder row. */
  readonly loadingDirectoryPaths?: readonly string[];
  /** The row to select, applied when it changes or first appears; the user may select others. */
  readonly selectedPath: string | null;
  readonly flattenEmptyDirectories?: boolean;
  /** Orders siblings; Pierre's directory-first, name order applies when omitted. */
  readonly sort?: FileTreeSortComparator;
  readonly gitStatus?: FileTreeOptions["gitStatus"];
  readonly icons?: FileTreeOptions["icons"];
  readonly renderRowDecoration?: FileTreeOptions["renderRowDecoration"];
  readonly initialScrollTop?: number;
  readonly revealSelectedPath?: boolean;
  readonly revealSelectedPathScrollOffset?: FileTreeScrollOffset;
  /** A new value rebuilds the rows, for example for a new search. */
  readonly resetKey?: string;
  readonly className?: string;
  readonly onSelectionChange?: (paths: readonly string[]) => void;
  readonly onExpandedPathsChange?: (paths: readonly string[]) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly onClick?: (event: MouseEvent<HTMLElement>) => void;
  readonly onDoubleClick?: (event: MouseEvent<HTMLElement>) => void;
  readonly onPointerOver?: (event: PointerEvent<HTMLElement>) => void;
}

type Model = PierreFileTreeModel;

const DEFAULT_ICONS = { set: "complete", colored: true } as const;

const stripTrailingSlash = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);
const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((path, index) => path === right[index]);
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((path) => right.has(path));

function folderHandle(model: Model, path: string): FileTreeFolderHandle | null {
  const item = model.getItem(path);
  return item && "isExpanded" in item ? item : null;
}

const SCROLL_ELEMENT = "[data-file-tree-virtualized-scroll='true']";

interface AppliedInput {
  readonly treePaths: readonly string[];
  readonly expanded: ReadonlySet<string>;
  readonly resetKey: string | undefined;
}

/**
 * Brings the model to the next input. Rows change through a batch, so every remaining folder
 * keeps its expansion, focus, and selection; only a new reset key rebuilds them. Expansion then
 * changes only for folders whose requested state changed or that just appeared.
 */
function reconcileFileTree(
  model: Model,
  previous: AppliedInput | null,
  next: AppliedInput,
  reconciling: { current: boolean },
) {
  reconciling.current = true;
  runSyncWithCleanup(
    () => {
      let added: readonly string[] = next.treePaths;
      let before: ReadonlySet<string> = new Set();
      if (previous && previous.resetKey !== next.resetKey) {
        rebuild(model, next);
      } else if (previous) {
        const change = applyPathChanges(model, previous.treePaths, next);
        added = change.added;
        if (!change.rebuilt) before = previous.expanded;
      }
      const addedFolders = added.filter((path) => path.endsWith("/")).map(stripTrailingSlash);
      applyFileTreeExpansion((path) => folderHandle(model, path), {
        expand: [
          ...addedFolders.filter((path) => next.expanded.has(path)),
          ...[...next.expanded].filter((path) => !before.has(path)),
        ],
        collapse: [
          ...addedFolders.filter((path) => !next.expanded.has(path)),
          ...[...before].filter((path) => !next.expanded.has(path)),
        ],
      });
    },
    () => {
      reconciling.current = false;
    },
  );
}

function rebuild(model: Model, next: AppliedInput) {
  model.resetPaths(next.treePaths, { initialExpandedPaths: [...next.expanded] });
}

/** Applies the row diff, or rebuilds the rows when the model rejects it. */
function applyPathChanges(model: Model, previous: readonly string[], next: AppliedInput) {
  const operations = diffFileTreePaths(previous, next.treePaths);
  try {
    if (operations.length > 0) model.batch(operations);
  } catch {
    rebuild(model, next);
    return { added: next.treePaths, rebuilt: true };
  }
  const added = operations.flatMap((operation) =>
    operation.type === "add" ? [operation.path] : [],
  );
  return { added, rebuilt: false };
}

/** Requested folders the tree does not hold keep their state; held folders report their own. */
function readExpandedPaths(
  model: Model,
  folders: readonly string[],
  requested: ReadonlySet<string>,
) {
  const held = new Set(folders);
  const expanded = [...requested].filter((path) => !held.has(path));
  for (const folder of folders)
    if (folderHandle(model, folder)?.isExpanded()) expanded.push(folder);
  return expanded.sort();
}

/** Selects only `path`, without reporting the change as the user's selection. */
function selectOnly(model: Model, path: string | null, syncing: { current: boolean }) {
  const selected = model.getSelectedPaths();
  if (path ? sameList(selected, [path]) : selected.length === 0) return;
  syncing.current = true;
  runSyncWithCleanup(
    () => {
      for (const selectedPath of selected) model.getItem(selectedPath)?.deselect();
      if (path) model.getItem(path)?.select();
    },
    () => {
      syncing.current = false;
    },
  );
}

/** One long-lived tree model owns focus, selection, expansion, sticky folders, and virtualization. */
function FileTreeContent({
  paths,
  ariaLabel,
  appearance,
  expandedPaths,
  loadingDirectoryPaths,
  selectedPath,
  flattenEmptyDirectories = false,
  sort,
  surface,
  sectioned,
  decorationAlignment,
  gitStatus,
  icons = DEFAULT_ICONS,
  renderRowDecoration,
  initialScrollTop = 0,
  revealSelectedPath = false,
  revealSelectedPathScrollOffset = "nearest",
  resetKey,
  className,
  onSelectionChange,
  onExpandedPathsChange,
  onScrollTopChange,
  onClick,
  onDoubleClick,
  onPointerOver,
}: FileTreeProps) {
  const { treePaths, folders, loadingRows } = buildFileTreeInput(paths, loadingDirectoryPaths);
  const callbacks = useRef({
    onSelectionChange,
    onExpandedPathsChange,
    onScrollTopChange,
    renderRowDecoration,
    loadingRows,
  });
  useLayoutEffect(() => {
    callbacks.current = {
      onSelectionChange,
      onExpandedPathsChange,
      onScrollTopChange,
      renderRowDecoration,
      loadingRows,
    };
  }, [
    loadingRows,
    onExpandedPathsChange,
    onScrollTopChange,
    onSelectionChange,
    renderRowDecoration,
  ]);
  const syncingSelection = useRef(false);
  const reconciling = useRef(false);
  const { model } = useFileTree({
    paths: treePaths,
    initialExpandedPaths: expandedPaths,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories,
    ...(sort ? { sort } : {}),
    gitStatus,
    icons,
    itemHeight: appearance === "review" ? 29 : 28,
    search: false,
    stickyFolders: true,
    unsafeCSS:
      appearance === "review"
        ? REVIEW_FILE_TREE_CSS
        : fileTreeCss({ surface, sectioned, decorationAlignment }),
    onSelectionChange: (selection) => {
      if (syncingSelection.current) return;
      const rows = selection.filter((path) => !callbacks.current.loadingRows.has(path));
      if (selection.length === 0 || rows.length > 0) callbacks.current.onSelectionChange?.(rows);
    },
    renderRowDecoration: (context) => callbacks.current.renderRowDecoration?.(context) ?? null,
  });

  const applied = useRef<AppliedInput | null>(null);
  const reported = useRef<readonly string[]>([]);
  useEffect(() => {
    const expanded = new Set(expandedPaths);
    const previous = applied.current;
    if (
      previous &&
      previous.resetKey === resetKey &&
      previous.treePaths === treePaths &&
      sameSet(previous.expanded, expanded)
    )
      return;
    const next = { treePaths, expanded, resetKey };
    reconcileFileTree(model, previous, next, reconciling);
    applied.current = next;
    reported.current = readExpandedPaths(model, folders, expanded);
  }, [expandedPaths, folders, treePaths, model, resetKey]);

  useEffect(
    () =>
      model.subscribe(() => {
        if (reconciling.current || !applied.current) return;
        const expanded = readExpandedPaths(model, folders, applied.current.expanded);
        if (sameList(expanded, reported.current)) return;
        reported.current = expanded;
        callbacks.current.onExpandedPathsChange?.(expanded);
      }),
    [folders, model],
  );

  useEffect(
    () =>
      withFileTreeElement(model, SCROLL_ELEMENT, (element) => {
        const report = () => callbacks.current.onScrollTopChange?.(element.scrollTop);
        element.addEventListener("scroll", report, { passive: true });
        return () => element.removeEventListener("scroll", report);
      }),
    [model],
  );

  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current || initialScrollTop <= 0) return;
    return withFileTreeElement(model, SCROLL_ELEMENT, (element) => {
      element.scrollTop = initialScrollTop;
      restoredScroll.current = true;
    });
  }, [initialScrollTop, model]);

  const appliedSelection = useRef<{
    path: string | null;
    resetKey: string | undefined;
    found: boolean;
  } | null>(null);
  const revealed = useRef<{ path: string; offset: FileTreeScrollOffset } | null>(null);
  const found =
    selectedPath !== null &&
    !loadingRows.has(selectedPath) &&
    (treePaths.includes(selectedPath) || treePaths.includes(`${selectedPath}/`));
  useEffect(() => {
    const last = appliedSelection.current;
    if (!last || last.path !== selectedPath || last.resetKey !== resetKey || (found && !last.found))
      selectOnly(model, found ? selectedPath : null, syncingSelection);
    // A rebuilt tree, or a selected row that left it, is revealed again once it is back.
    if (!last || last.resetKey !== resetKey || (last.found && !found)) revealed.current = null;
    appliedSelection.current = { path: selectedPath, resetKey, found };
    if (!revealSelectedPath || !selectedPath || !found) return;
    if (
      revealed.current?.path === selectedPath &&
      revealed.current.offset === revealSelectedPathScrollOffset
    )
      return;
    model.scrollToPath(selectedPath, { offset: revealSelectedPathScrollOffset });
    revealed.current = { path: selectedPath, offset: revealSelectedPathScrollOffset };
  }, [found, model, resetKey, revealSelectedPath, revealSelectedPathScrollOffset, selectedPath]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  return (
    <FileTreeLoadingRows rows={loadingRows}>
      <PierreFileTree
        model={model}
        aria-label={ariaLabel}
        className={cn(
          "block h-full min-h-0 w-full text-(--color-text)",
          surface === "dropdown"
            ? "bg-surface-elevated-secondary"
            : "bg-token-main-surface-primary",
          className,
        )}
        data-tab-preview-pin-exempt="true"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onPointerOver={onPointerOver}
      />
    </FileTreeLoadingRows>
  );
}

export { getFileTreeEventPath };

class FileTreeRenderBoundary extends Component<
  { readonly children: ReactNode; readonly paths: readonly string[] },
  { failed: boolean; paths: readonly string[] }
> {
  state = { failed: false, paths: this.props.paths };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: Readonly<{ paths: readonly string[] }>,
    state: { paths: readonly string[] },
  ) {
    // New rows get a fresh attempt after a failure.
    if (state.paths !== props.paths) return { failed: false, paths: props.paths };
    return null;
  }
  render() {
    if (this.state.failed)
      return (
        <div role="status" className="px-2 py-2 text-sm text-tertiary">
          File tree couldn't render
        </div>
      );
    return this.props.children;
  }
}

export function FileTree(props: FileTreeProps) {
  return (
    <FileTreeRenderBoundary paths={props.paths}>
      {/* Tree options are fixed at construction, so a theme change builds a new tree. */}
      <FileTreeContent
        key={`${props.appearance}:${props.surface}:${props.sectioned}:${props.decorationAlignment}`}
        {...props}
      />
    </FileTreeRenderBoundary>
  );
}
