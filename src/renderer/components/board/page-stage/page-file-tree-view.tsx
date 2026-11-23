import { isEventWithinCurrentTarget } from "@/lib/react-event-ownership";
import { useIntl } from "@/lib/i18n";
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
  ChevronDownIcon,
  DownloadIcon,
  MoreActionsIcon,
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
type BranchRow = Exclude<Row, FileRow>;
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
  /** Folds and unfolds the body-only Files listed apart from the attachments. */
  readonly onToggleBodyGroup: () => void;
}

/** One icon and its gap: each level's icon sits under the name of the level above it. */
const INDENT_PX = 24;
/** A row's hover surface hangs this far outside the Page's content edge. */
const ROW_HANG_PX = 6;
/** The trailing column every File's size is set in. */
const SIZE_COLUMN_PX = 56;

/** A guide runs beneath the middle of the 16px icon it belongs to. */
export const PAGE_FILE_TREE_GUIDE_OFFSET_PX = 7.75;

const isBranch = (row: Row): row is BranchRow => row.kind !== "file";

const parentIndex = (rows: readonly Row[], index: number): number => {
  const depth = rows[index]?.depth ?? 0;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const row = rows[candidate]!;
    if (isBranch(row) && row.depth === depth - 1) return candidate;
  }
  return -1;
};

/**
 * The Page's Files as the outline beneath its Files Property. The Property's label is the root:
 * a top-level row's icon sits under the label's text, as each deeper row's icon sits under its
 * parent's name, and a guide ties every level to the row that owns it. Rows span the Properties'
 * width, so names, origins and sizes keep their own room. Folders fold; Files open beside the
 * Page, and images over it. Arrow keys move through rows, Right and Left unfold and fold, Enter
 * opens.
 */
export function PageFileTreeView({
  id,
  rows,
  freshFileIds,
  renderSource,
  onToggleFolder,
  onToggleBodyGroup,
  ...actions
}: PageFileTreeViewProps) {
  const intl = useIntl();

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const tabStopKey = rows.some((row) => row.key === focusedKey)
    ? focusedKey
    : (rows[0]?.key ?? null);

  const focusRow = (key: string | undefined): void => {
    if (!key) return;
    setFocusedKey(key);
    rowRefs.current.get(key)?.focus();
  };
  const toggle = (row: BranchRow): void =>
    row.kind === "folder" ? onToggleFolder(row.path) : onToggleBodyGroup();

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || !isEventWithinCurrentTarget(event)) return;
    const index = rows.findIndex((row) => row.key === tabStopKey);
    const row = rows[index];
    if (!row) return;
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          focusRow(rows[index + 1]?.key);
          return true;
        case "ArrowUp":
          focusRow(rows[index - 1]?.key);
          return true;
        case "Home":
          focusRow(rows[0]?.key);
          return true;
        case "End":
          focusRow(rows.at(-1)?.key);
          return true;
        case "ArrowRight":
          if (isBranch(row) && !row.expanded) toggle(row);
          else if (isBranch(row)) focusRow(rows[index + 1]?.key);
          return true;
        case "ArrowLeft":
          if (isBranch(row) && row.expanded) toggle(row);
          else focusRow(rows[parentIndex(rows, index)]?.key);
          return true;
        case "Enter":
        case " ":
          if (isBranch(row)) toggle(row);
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
    <div
      id={id}
      role="tree"
      aria-label={intl.formatMessage({
        id: "board.pageFileTreeView.pageFiles",
        defaultMessage: "Page files",
      })}
      className="flex min-w-0 flex-col [--page-file-row-surface:color-mix(in_srgb,var(--color-token-foreground)_5%,var(--background))]"
      onKeyDown={handleKeyDown}
    >
      {rows.map((row) => {
        const focus: RowFocusProps = {
          ref: (element) => {
            if (element) rowRefs.current.set(row.key, element);
            else rowRefs.current.delete(row.key);
          },
          tabIndex: row.key === tabStopKey ? 0 : -1,
          onFocus: () => setFocusedKey(row.key),
          style: {
            marginInline: -ROW_HANG_PX,
            paddingLeft: ROW_HANG_PX + (row.depth + 1) * INDENT_PX,
            paddingRight: ROW_HANG_PX,
          },
          guides: <RowGuides depth={row.depth} />,
        };
        if (row.kind === "file") {
          return (
            <FileTreeRow
              key={row.key}
              row={row}
              fresh={freshFileIds.has(row.file.fileId)}
              actions={actions}
              {...focus}
            >
              {row.provenance ? renderSource(row.provenance) : null}
            </FileTreeRow>
          );
        }
        return (
          <BranchTreeRow key={row.key} row={row} onToggle={() => toggle(row)} {...focus}>
            {row.kind === "folder" && row.provenance ? renderSource(row.provenance) : null}
          </BranchTreeRow>
        );
      })}
    </div>
  );
}

const ROW_CLASS_NAME =
  "group/page-file-row relative flex h-7 min-w-0 cursor-interaction items-center gap-2 rounded-md text-sm text-token-text-primary outline-none select-none hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset";

/** Who attached the row, kept to the trailing half so the name is never the part that gives way. */
const ORIGIN_CLASS_NAME =
  "ml-auto flex max-w-[50%] min-w-0 shrink items-center justify-end text-xs text-(--foreground-tertiary)";

interface RowFocusProps {
  readonly ref: (element: HTMLDivElement | null) => void;
  readonly tabIndex: number;
  readonly onFocus: () => void;
  readonly style: {
    readonly marginInline: number;
    readonly paddingLeft: number;
    readonly paddingRight: number;
  };
  readonly guides: ReactNode;
}

/**
 * The guide of each folder above the row, drawn through the row beneath that folder's icon.
 * Rows touch, so the segments read as one line per open folder. The Property's own guide is
 * drawn once by the tree's host, past the last row to whatever follows the tree.
 */
function RowGuides({ depth }: { readonly depth: number }) {
  return Array.from({ length: depth }, (_, index) => (
    <span
      key={index}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 border-l-[0.5px] border-token-border"
      style={{ left: ROW_HANG_PX + (index + 1) * INDENT_PX + PAGE_FILE_TREE_GUIDE_OFFSET_PX }}
    />
  ));
}

/** A folder, or the group of body-only Files: a line that folds the lines beneath it. */
function BranchTreeRow({
  row,
  onToggle,
  children,
  guides,
  ...focus
}: RowFocusProps & {
  readonly row: BranchRow;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const chevron = (
    <ChevronDownIcon
      className={cn("icon-2xs transition-transform", !row.expanded && "-rotate-90")}
    />
  );
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
      {guides}
      <span className="relative flex size-4 shrink-0 items-center justify-center text-(--foreground-tertiary)">
        {row.kind === "folder" ? (
          <>
            <span className="flex group-hover/page-file-row:invisible [&_svg]:size-4">
              {row.expanded ? <ProjectFolderOpenIcon /> : <ProjectFolderIcon />}
            </span>
            <span className="invisible absolute flex group-hover/page-file-row:visible">
              {chevron}
            </span>
          </>
        ) : (
          // The group is no folder of the Page's own, so it never wears a folder.
          chevron
        )}
      </span>
      {row.kind === "folder" ? (
        <span className="min-w-0 truncate text-token-text-secondary">{row.name}</span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1.5 text-(--foreground-tertiary)">
          <span className="truncate">{row.name}</span>
          <span className="text-xs tabular-nums opacity-70">{row.fileCount}</span>
        </span>
      )}
      {children ? (
        <>
          <span className={ORIGIN_CLASS_NAME}>{children}</span>
          {/* Keeps a folder's origin in the same column as its Files' origins. */}
          <span aria-hidden="true" className="shrink-0" style={{ width: SIZE_COLUMN_PX }} />
        </>
      ) : null}
    </div>
  );
}

/** A name that gives way in its middle, so the extension that says what the File is stays. */
function FileName({ name }: { readonly name: string }) {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && name.length - dot <= 8;
  return (
    <span className="flex min-w-0 whitespace-pre">
      <span className="truncate">{hasExtension ? name.slice(0, dot) : name}</span>
      {hasExtension ? <span className="shrink-0">{name.slice(dot)}</span> : null}
    </span>
  );
}

const ROW_ACTION_CLASS_NAME =
  "flex size-5 shrink-0 items-center justify-center rounded-sm text-(--foreground-tertiary) hover:bg-token-foreground/8 hover:text-(--foreground-secondary)";

function FileTreeRow({
  row,
  fresh,
  actions,
  children,
  guides,
  ...focus
}: RowFocusProps & {
  readonly row: FileRow;
  readonly fresh: boolean;
  readonly actions: PageFileTreeFileActions;
  readonly children: ReactNode;
}) {
  const intl = useIntl();

  const item = row.file.value;
  const path = item.logical_path ?? null;
  const inPlace = actions.opensInPlace?.(item) ?? false;
  /** Opens the row's own menu beneath the button, so the pointer finds what the keyboard can. */
  const openMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(
      new globalThis.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  };
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
          {guides}
          <ColorfulFileResourceIcon
            path={path ?? item.file.default_name}
            mimeType={item.file.mime_type}
            className="size-4 shrink-0"
          />
          <FileName name={row.name} />
          {fresh ? (
            <span
              aria-label={intl.formatMessage({
                id: "board.pageFileTreeView.newFile",
                defaultMessage: "New",
              })}
              className="size-1.5 shrink-0 rounded-full bg-info-solid"
            />
          ) : null}
          {/* Rendered even when empty: its auto margin is what sets the size at the row's end. */}
          <span className={ORIGIN_CLASS_NAME}>{children}</span>
          <span
            className="shrink-0 text-right text-xs text-(--foreground-tertiary) tabular-nums"
            style={{ width: SIZE_COLUMN_PX }}
          >
            {formatBytes(item.file.byte_length)}
          </span>
          {/* Laid over the row beside its size, so a resting row gives the name its whole width. */}
          <span
            className="pointer-events-none absolute inset-y-0 flex items-center gap-0.5 bg-[linear-gradient(to_right,transparent,var(--page-file-row-surface)_1rem)] pl-5 opacity-0 group-hover/page-file-row:pointer-events-auto group-hover/page-file-row:opacity-100"
            style={{ right: ROW_HANG_PX + SIZE_COLUMN_PX }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label={intl.formatMessage(
                { id: "board.pageFileTreeView.saveFile", defaultMessage: "Save {name}" },
                { name: row.name },
              )}
              className={ROW_ACTION_CLASS_NAME}
              onClick={(event) => {
                event.stopPropagation();
                actions.onSave(item);
              }}
            >
              <DownloadIcon className="icon-2xs" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={intl.formatMessage(
                {
                  id: "board.pageFileTreeView.moreFileActions",
                  defaultMessage: "More actions for {name}",
                },
                { name: row.name },
              )}
              className={ROW_ACTION_CLASS_NAME}
              onClick={openMenu}
            >
              <MoreActionsIcon className="icon-2xs" />
            </button>
          </span>
        </div>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          <NodexContextMenuItem onSelect={() => actions.onOpen(item, "preview")}>
            {inPlace
              ? intl.formatMessage({
                  id: "board.pageFileTreeView.preview",
                  defaultMessage: "Preview",
                })
              : intl.formatMessage({ id: "board.pageFileTreeView.open", defaultMessage: "Open" })}
          </NodexContextMenuItem>
          <NodexContextMenuItem onSelect={() => actions.onOpen(item, "durable")}>
            {intl.formatMessage({
              id: "board.pageFileTreeView.openInNewTab",
              defaultMessage: "Open in new tab",
            })}
          </NodexContextMenuItem>
          <NodexContextMenuItem onSelect={() => actions.onSave(item)}>
            {intl.formatMessage({ id: "board.pageFileTreeView.save", defaultMessage: "Save…" })}
          </NodexContextMenuItem>
          {path ? (
            <NodexContextMenuItem onSelect={() => actions.onCopyPath(item)}>
              {intl.formatMessage({
                id: "board.pageFileTreeView.copyPath",
                defaultMessage: "Copy path",
              })}
            </NodexContextMenuItem>
          ) : null}
          <div role="separator" className="my-1 h-px bg-border" />
          <NodexContextMenuItem onSelect={() => actions.onManage(item)}>
            {intl.formatMessage({
              id: "board.pageFileTreeView.managePageFiles",
              defaultMessage: "Manage in Page files…",
            })}
          </NodexContextMenuItem>
          {path && actions.onRemovePath ? (
            <NodexContextMenuItem tone="danger" onSelect={() => actions.onRemovePath?.(item)}>
              {item.body_count > 0
                ? intl.formatMessage({
                    id: "board.pageFileTreeView.removePath",
                    defaultMessage: "Remove path",
                  })
                : intl.formatMessage({
                    id: "board.pageFileTreeView.removeFromPage",
                    defaultMessage: "Remove from Page",
                  })}
            </NodexContextMenuItem>
          ) : null}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}
