import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  ChevronDownIcon,
  ProjectFolderIcon,
  ProjectFolderOpenIcon,
} from "@/components/shared/icons";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import { formatBytes } from "@/lib/file-metadata-format";
import type { PageFileTreeProvenance, PageFileTreeRow } from "@/lib/page-file-tree";
import { cn } from "@/lib/utils";
import type { LibraryPageFileItem } from "../../../../shared/library-files";

type Row = PageFileTreeRow<LibraryPageFileItem>;
type FileRow = Extract<Row, { readonly kind: "file" }>;
type OpenMode = "preview" | "durable";

export interface PageFileTreeFileActions {
  readonly onOpen: (item: LibraryPageFileItem, mode: OpenMode) => void;
  /** Whether a plain open shows the File over the Page, as an image does, instead of in a tab. */
  readonly opensInPlace?: (item: LibraryPageFileItem) => boolean;
  readonly onSave: (item: LibraryPageFileItem) => void;
  readonly onCopyPath: (item: LibraryPageFileItem) => void;
  readonly onManage: (item: LibraryPageFileItem) => void;
  /** Absent while the Page's entries cannot change. */
  readonly onRemovePath?: (item: LibraryPageFileItem) => void;
}

export interface PageFileTreeViewProps extends PageFileTreeFileActions {
  readonly id: string;
  readonly rows: readonly Row[];
  /** Files that arrived while this Page was open and have not been opened since. */
  readonly freshFileIds: ReadonlySet<string>;
  readonly renderSource: (provenance: PageFileTreeProvenance) => ReactNode;
  readonly onToggleFolder: (path: string) => void;
  /** The origin of every File, stated once beneath the tree. */
  readonly caption?: ReactNode;
  readonly footer?: ReactNode;
}

const INDENT_PX = 16;
const ROW_INSET_PX = 4;

const isFocusable = (row: Row): row is Exclude<Row, { readonly kind: "group" }> =>
  row.kind !== "group";

const parentIndex = (rows: readonly Row[], index: number): number => {
  const depth = rows[index]?.depth ?? 0;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const row = rows[candidate]!;
    if (row.kind === "folder" && row.depth === depth - 1) return candidate;
  }
  return -1;
};

/**
 * The Page's Files as a tree spanning the Page width. Folders fold; Files open beside the
 * Page, and images over it. Arrow keys move through rows, Right and Left unfold and fold,
 * Enter opens.
 */
export function PageFileTreeView({
  id,
  rows,
  freshFileIds,
  renderSource,
  onToggleFolder,
  caption,
  footer,
  ...actions
}: PageFileTreeViewProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const focusable = rows.filter(isFocusable);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const tabStopKey = focusable.some((row) => row.key === focusedKey)
    ? focusedKey
    : (focusable[0]?.key ?? null);

  const focusRow = (key: string | undefined): void => {
    if (!key) return;
    setFocusedKey(key);
    rowRefs.current.get(key)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = rows.findIndex((row) => row.key === tabStopKey);
    const row = rows[index];
    if (!row || !isFocusable(row)) return;
    const step = (direction: 1 | -1): string | undefined => {
      for (
        let candidate = index + direction;
        candidate >= 0 && candidate < rows.length;
        candidate += direction
      ) {
        const next = rows[candidate]!;
        if (isFocusable(next)) return next.key;
      }
      return undefined;
    };
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          focusRow(step(1));
          return true;
        case "ArrowUp":
          focusRow(step(-1));
          return true;
        case "Home":
          focusRow(focusable[0]?.key);
          return true;
        case "End":
          focusRow(focusable.at(-1)?.key);
          return true;
        case "ArrowRight":
          if (row.kind === "folder" && !row.expanded) onToggleFolder(row.path);
          else if (row.kind === "folder") focusRow(step(1));
          return true;
        case "ArrowLeft":
          if (row.kind === "folder" && row.expanded) onToggleFolder(row.path);
          else focusRow(rows[parentIndex(rows, index)]?.key);
          return true;
        case "Enter":
        case " ":
          if (row.kind === "folder") onToggleFolder(row.path);
          else
            actions.onOpen(row.file.value, event.metaKey || event.ctrlKey ? "durable" : "preview");
          return true;
        default:
          return false;
      }
    })();
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="mt-0.5 mb-1.5 rounded-lg py-1 ring-[0.5px] ring-token-border ring-inset">
      <div
        id={id}
        role="tree"
        aria-label="Page files"
        className="flex flex-col px-1"
        onKeyDown={handleKeyDown}
      >
        {rows.map((row) => {
          if (row.kind === "group") {
            return (
              <div
                key={row.key}
                role="none"
                className="mt-1 flex h-6 items-center gap-1.5 px-2 text-xs text-(--foreground-tertiary) first:mt-0"
              >
                {row.name}
                <span className="tabular-nums opacity-70">{row.fileCount}</span>
              </div>
            );
          }
          const shared = {
            ref: (element: HTMLDivElement | null) => {
              if (element) rowRefs.current.set(row.key, element);
              else rowRefs.current.delete(row.key);
            },
            tabIndex: row.key === tabStopKey ? 0 : -1,
            onFocus: () => setFocusedKey(row.key),
            style: { paddingLeft: ROW_INSET_PX + row.depth * INDENT_PX },
          };
          return row.kind === "folder" ? (
            <FolderRow
              key={row.key}
              row={row}
              {...shared}
              onToggle={() => onToggleFolder(row.path)}
            >
              {row.provenance ? renderSource(row.provenance) : null}
            </FolderRow>
          ) : (
            <FileTreeRow
              key={row.key}
              row={row}
              fresh={freshFileIds.has(row.file.fileId)}
              actions={actions}
              {...shared}
            >
              {row.provenance ? renderSource(row.provenance) : null}
            </FileTreeRow>
          );
        })}
      </div>
      {footer}
      {caption ? (
        <div className="mx-1 mt-1 flex min-w-0 items-center gap-1 border-t-[0.5px] border-token-border px-2 pt-1.5 pb-0.5 text-xs text-(--foreground-tertiary)">
          {caption}
        </div>
      ) : null}
    </div>
  );
}

const ROW_CLASS_NAME =
  "group/page-file-row flex h-7 min-w-0 cursor-interaction items-center gap-1.5 rounded-md pr-2 text-sm text-token-text-primary outline-none select-none hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset";

const META_CLASS_NAME =
  "flex min-w-0 shrink items-center justify-end text-xs text-(--foreground-tertiary)";

interface RowFocusProps {
  readonly ref: (element: HTMLDivElement | null) => void;
  readonly tabIndex: number;
  readonly onFocus: () => void;
  readonly style: { readonly paddingLeft: number };
  readonly children: ReactNode;
}

function FolderRow({
  row,
  onToggle,
  children,
  ...focus
}: RowFocusProps & {
  readonly row: Extract<Row, { readonly kind: "folder" }>;
  readonly onToggle: () => void;
}) {
  return (
    <div
      {...focus}
      role="treeitem"
      aria-label={row.name}
      aria-level={row.depth + 1}
      aria-expanded={row.expanded}
      className={ROW_CLASS_NAME}
      onClick={onToggle}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center text-(--foreground-tertiary) [&_svg]:size-4">
        <span className="flex group-hover/page-file-row:invisible">
          {row.expanded ? <ProjectFolderOpenIcon /> : <ProjectFolderIcon />}
        </span>
        <ChevronDownIcon
          className={cn(
            "icon-2xs invisible absolute transition-transform group-hover/page-file-row:visible",
            !row.expanded && "-rotate-90",
          )}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-token-text-secondary">{row.name}</span>
      {children ? <span className={cn(META_CLASS_NAME, "max-w-[55%]")}>{children}</span> : null}
      {/* Keeps a folder's origin in the same column as its Files' origins. */}
      <span aria-hidden="true" className="w-14 shrink-0" />
    </div>
  );
}

function FileTreeRow({
  row,
  fresh,
  actions,
  children,
  ...focus
}: RowFocusProps & {
  readonly row: FileRow;
  readonly fresh: boolean;
  readonly actions: PageFileTreeFileActions;
}) {
  const item = row.file.value;
  const path = item.logical_path ?? null;
  const inPlace = actions.opensInPlace?.(item) ?? false;
  return (
    <NodexContextMenuRoot>
      <NodexContextMenuTrigger>
        <div
          {...focus}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-label={path ?? row.name}
          data-page-file-id={item.file.file_id}
          className={ROW_CLASS_NAME}
          onClick={(event) =>
            actions.onOpen(item, event.metaKey || event.ctrlKey ? "durable" : "preview")
          }
          // A double click keeps a tab; an image has no tab until the person asks for one.
          onDoubleClick={inPlace ? undefined : () => actions.onOpen(item, "durable")}
        >
          <ColorfulFileResourceIcon
            path={path ?? item.file.default_name}
            mimeType={item.file.mime_type}
            className="size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          {fresh ? (
            <span aria-label="New" className="size-1.5 shrink-0 rounded-full bg-info-solid" />
          ) : null}
          {children ? <span className={cn(META_CLASS_NAME, "max-w-[55%]")}>{children}</span> : null}
          <span className="w-14 shrink-0 text-right text-xs text-(--foreground-tertiary) tabular-nums">
            {formatBytes(item.file.byte_length)}
          </span>
        </div>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          <NodexContextMenuItem onSelect={() => actions.onOpen(item, "preview")}>
            {inPlace ? "Preview" : "Open"}
          </NodexContextMenuItem>
          <NodexContextMenuItem onSelect={() => actions.onOpen(item, "durable")}>
            Open in new tab
          </NodexContextMenuItem>
          <NodexContextMenuItem onSelect={() => actions.onSave(item)}>Save…</NodexContextMenuItem>
          {path ? (
            <NodexContextMenuItem onSelect={() => actions.onCopyPath(item)}>
              Copy path
            </NodexContextMenuItem>
          ) : null}
          <div role="separator" className="my-1 h-px bg-border" />
          <NodexContextMenuItem onSelect={() => actions.onManage(item)}>
            Manage in Page files…
          </NodexContextMenuItem>
          {path && actions.onRemovePath ? (
            <NodexContextMenuItem tone="danger" onSelect={() => actions.onRemovePath?.(item)}>
              {item.body_count > 0 ? "Remove path" : "Remove from Page"}
            </NodexContextMenuItem>
          ) : null}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}
