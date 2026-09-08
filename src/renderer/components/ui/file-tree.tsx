import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeOptions } from "@pierre/trees";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { buildFileTreeExpandedPaths, getFileTreeEventPath } from "@/lib/file-tree-paths";
import { cn } from "@/lib/utils";
import { FILE_TREE_CSS, REVIEW_FILE_TREE_CSS } from "./file-tree-theme";

export interface FileTreeState {
  readonly expandedPaths: readonly string[];
  readonly selectedPath: string | null;
  readonly scrollTop: number;
}

export interface FileTreeProps {
  readonly paths: readonly string[];
  readonly ariaLabel: string;
  readonly appearance: "review" | "workspace";
  readonly expandedPaths: readonly string[];
  readonly selectedPath: string | null;
  readonly flattenEmptyDirectories?: boolean;
  readonly gitStatus?: FileTreeOptions["gitStatus"];
  readonly icons?: FileTreeOptions["icons"];
  readonly renderRowDecoration?: FileTreeOptions["renderRowDecoration"];
  readonly initialScrollTop?: number;
  readonly revealSelectedPath?: boolean;
  readonly revealSelectedPathScrollOffset?: "top" | "center" | "nearest";
  readonly resetKey?: string;
  readonly className?: string;
  readonly onSelectionChange?: (paths: readonly string[]) => void;
  readonly onStateChange?: (state: FileTreeState) => void;
  readonly onClick?: (event: MouseEvent<HTMLElement>) => void;
  readonly onDoubleClick?: (event: MouseEvent<HTMLElement>) => void;
  readonly onPointerOver?: (event: PointerEvent<HTMLElement>) => void;
}

const DEFAULT_ICONS = { set: "complete", colored: true } as const;
const equalPaths = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((path, index) => path === right[index]);

/** One long-lived tree model owns focus, selection, sticky folders, and virtualization. */
function FileTreeContent({
  paths,
  ariaLabel,
  appearance,
  expandedPaths,
  selectedPath,
  flattenEmptyDirectories = false,
  gitStatus,
  icons = DEFAULT_ICONS,
  renderRowDecoration,
  initialScrollTop = 0,
  revealSelectedPath = false,
  revealSelectedPathScrollOffset = "nearest",
  resetKey,
  className,
  onSelectionChange,
  onStateChange,
  onClick,
  onDoubleClick,
  onPointerOver,
}: FileTreeProps) {
  const callbacks = useRef({ onSelectionChange, onStateChange, renderRowDecoration });
  callbacks.current = { onSelectionChange, onStateChange, renderRowDecoration };
  const syncingSelection = useRef(false);
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: expandedPaths,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories,
    gitStatus,
    icons,
    itemHeight: appearance === "review" ? 29 : 28,
    search: false,
    stickyFolders: true,
    unsafeCSS: appearance === "review" ? REVIEW_FILE_TREE_CSS : FILE_TREE_CSS,
    onSelectionChange: (selection) => {
      if (!syncingSelection.current) callbacks.current.onSelectionChange?.(selection);
    },
    renderRowDecoration: (context) => callbacks.current.renderRowDecoration?.(context) ?? null,
  });
  const directoryPaths = useMemo(
    () => [
      ...new Set([
        ...buildFileTreeExpandedPaths(paths),
        ...paths.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)),
      ]),
    ],
    [paths],
  );
  const previousReset = useRef<{
    paths: readonly string[];
    expandedPaths: readonly string[];
    resetKey?: string;
  } | null>(null);

  useEffect(() => {
    const previous = previousReset.current;
    if (
      previous &&
      previous.resetKey === resetKey &&
      equalPaths(previous.paths, paths) &&
      equalPaths(previous.expandedPaths, expandedPaths)
    )
      return;
    previousReset.current = { paths, expandedPaths, resetKey };
    syncingSelection.current = true;
    try {
      model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
    } finally {
      syncingSelection.current = false;
    }
  }, [expandedPaths, model, paths, resetKey]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  useEffect(() => {
    const selected = model.getSelectedPaths();
    if (equalPaths(selected, selectedPath ? [selectedPath] : [])) return;
    syncingSelection.current = true;
    try {
      for (const path of selected) model.getItem(path)?.deselect();
      if (selectedPath) model.getItem(selectedPath)?.select();
    } finally {
      syncingSelection.current = false;
    }
  }, [model, paths, selectedPath]);

  const lastReveal = useRef<{ selectedPath: string; resetKey?: string } | null>(null);
  useEffect(() => {
    if (!revealSelectedPath || !selectedPath || !model.getItem(selectedPath)) return;
    if (
      lastReveal.current?.selectedPath === selectedPath &&
      lastReveal.current.resetKey === resetKey
    )
      return;
    lastReveal.current = { selectedPath, resetKey };
    model.scrollToPath(selectedPath, { offset: revealSelectedPathScrollOffset });
  }, [model, paths, resetKey, revealSelectedPath, revealSelectedPathScrollOffset, selectedPath]);

  const scrollTop = useRef(initialScrollTop);
  useEffect(() => {
    const publish = () => {
      if (syncingSelection.current) return;
      const expanded = directoryPaths.filter((path) => {
        const item = model.getItem(path);
        return item && "isExpanded" in item && item.isExpanded();
      });
      if (previousReset.current)
        previousReset.current = { ...previousReset.current, expandedPaths: expanded };
      callbacks.current.onStateChange?.({
        expandedPaths: expanded,
        selectedPath: model.getSelectedPaths()[0] ?? null,
        scrollTop: scrollTop.current,
      });
    };
    let frame: number | null = null;
    let element: HTMLElement | null = null;
    const onScroll = () => {
      scrollTop.current = element?.scrollTop ?? 0;
      publish();
    };
    const connect = (attempt: number) => {
      element =
        model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll='true']") ??
        null;
      if (!element) {
        if (attempt < 60) frame = requestAnimationFrame(() => connect(attempt + 1));
        return;
      }
      element.addEventListener("scroll", onScroll, { passive: true });
    };
    const unsubscribe = model.subscribe(publish);
    connect(0);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
      element?.removeEventListener("scroll", onScroll);
    };
  }, [directoryPaths, model]);

  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current) return;
    if (initialScrollTop <= 0 || (revealSelectedPath && selectedPath)) return;
    let frame: number | null = null;
    const restore = (attempt: number) => {
      const element = model
        .getFileTreeContainer()
        ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll='true']");
      if (element) {
        element.scrollTop = initialScrollTop;
        restoredScroll.current = true;
        return;
      }
      if (attempt < 60) frame = requestAnimationFrame(() => restore(attempt + 1));
    };
    restore(0);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [initialScrollTop, model, revealSelectedPath, selectedPath]);

  return (
    <PierreFileTree
      model={model}
      aria-label={ariaLabel}
      className={cn(
        "block h-full min-h-0 w-full bg-token-main-surface-primary text-default",
        className,
      )}
      data-tab-preview-pin-exempt="true"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerOver={onPointerOver}
    />
  );
}

export { getFileTreeEventPath };

class FileTreeRenderBoundary extends Component<
  { readonly children: ReactNode; readonly resetKey: string },
  { failed: boolean; resetKey: string }
> {
  state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: Readonly<{ resetKey: string }>,
    state: { resetKey: string },
  ) {
    if (state.resetKey !== props.resetKey) return { failed: false, resetKey: props.resetKey };
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
    <FileTreeRenderBoundary resetKey={props.paths.join("\0")}>
      <FileTreeContent {...props} />
    </FileTreeRenderBoundary>
  );
}
