import { useIntl } from "@/lib/i18n";
import { useId, useState, type CSSProperties } from "react";

import { ActivitySpinnerIcon, FileIcon, PlusIcon } from "@/components/shared/icons";
import { PropertyEmptyValue } from "@/components/database/property-empty-value";
import { DATABASE_PAGE_PROPERTY_BORDERLESS_VALUE_CLASS_NAME } from "@/components/database/property-value-chip";
import { toast } from "@/components/ui/toast";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { PageFileImagePreview } from "@/features/page-files/page-file-image-preview";
import { pageFilePreviewsInPlace, resolvePageFileViewKind } from "@/lib/page-file-view-kind";
import type { LibraryPageFileItem } from "../../../../shared/library-files";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { fileSource } from "../../../../shared/file-resources";
import { importPreparedPageEntries, removePageEntry } from "@/lib/library-file-commands";
import { prepareDroppedFiles } from "@/lib/api";
import {
  materializeAuthorizedFile,
  revealFileExport,
  saveAuthorizedFile,
} from "@/lib/library-file-resources";
import { writeTextToClipboard } from "@/lib/clipboard";
import { appScope, scopedAtom, scopedAtomFamily, useScopedAtom } from "@/lib/maitai";
import { buildPageFileTree, type PageFileTreeProvenance } from "@/lib/page-file-tree";
import { toPageFileTreeFile } from "@/lib/page-file-provenance";
import { useSystemFileDrop } from "@/lib/use-system-file-drop";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import type { PageFilesReadModel } from "@/lib/use-page-files";
import { cn } from "@/lib/utils";
import type { PageStageController } from "./use-page-stage-controller";
import { pageStagePropertyAddControl } from "./property-value-styles";
import { PageStagePropertyRow } from "./property-row";
import { PageFileSourceLabel, usePageFileSources } from "./page-file-source";
import { PAGE_FILE_TREE_GUIDE_OFFSET_PX, PageFileTreeView } from "./page-file-tree-view";
import {
  emptyPageFileInventory,
  pageFileLabel,
  pageFilesMutationMessage,
  usePageFilesDialog,
} from "./page-files-dialog";

interface PageFilesRowProps {
  readonly controller: PageStageController;
  readonly baseFiles: PageFilesReadModel;
  readonly hidden?: boolean;
}

interface PageFilesDisclosure {
  /** The person's own choice; until they make one, the tree is open while it has news to show. */
  readonly expanded: boolean | null;
  /** Shows every row instead of the first screenful. */
  readonly showAll: boolean;
  readonly collapsedFolders: readonly string[];
  /** Whether the body-only Files listed apart from the attachments are unfolded. */
  readonly bodyGroupExpanded: boolean;
}

const DEFAULT_DISCLOSURE: PageFilesDisclosure = {
  expanded: null,
  showAll: false,
  collapsedFolders: [],
  bodyGroupExpanded: false,
};

/** How each Page's Files tree was left in this window: folded, folders closed, fully shown. */
const pageFilesDisclosureFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "page-files-disclosure",
  key: (pageId: string) => pageId,
  create: () =>
    scopedAtom<PageFilesDisclosure>(appScope, DEFAULT_DISCLOSURE, {
      debugLabel: "disclosure",
    }),
});

/** Rows shown before `Show all`, so a long tree never pushes the Page body far down. */
const PAGE_FILE_TREE_ROW_LIMIT = 10;

/** File IDs that appeared after this Page's Files first loaded, until each is opened. */
function useFreshPageFileIds(pageId: string, fileIds: readonly string[] | null) {
  const [state, setState] = useState<{
    readonly pageId: string;
    readonly baseline: ReadonlySet<string> | null;
    readonly opened: ReadonlySet<string>;
  }>({ pageId, baseline: null, opened: new Set() });
  const current =
    state.pageId === pageId ? state : { pageId, baseline: null, opened: new Set<string>() };
  if (fileIds && current.baseline === null) {
    setState({ ...current, baseline: new Set(fileIds) });
  } else if (current !== state) {
    setState(current);
  }
  const fresh = new Set(
    current.baseline && fileIds
      ? fileIds.filter((id) => !current.baseline!.has(id) && !current.opened.has(id))
      : [],
  );
  const markOpened = (fileId: string): void =>
    setState((previous) => ({ ...previous, opened: new Set([...previous.opened, fileId]) }));
  return { fresh, markOpened };
}

/** An image is looked at where it is; a tab is for a File the person means to keep open. */
const isImageFile = (item: LibraryPageFileItem): boolean =>
  pageFilePreviewsInPlace(
    resolvePageFileViewKind({ name: pageFileLabel(item), mimeType: item.file.mime_type }),
  );

const fileTitle = (item: LibraryPageFileItem): string =>
  item.logical_path?.split("/").at(-1) ?? item.file.default_name;

/** The tree's last row: its text continues the top-level names, its surface a row's surface. */
const TREE_FOOTER_BUTTON_CLASS_NAME =
  "-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] cursor-interaction items-center rounded-md pr-1.5 pl-13.5 text-xs text-(--foreground-tertiary) hover:bg-token-foreground/5 hover:text-(--foreground-secondary) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border disabled:opacity-60";

/**
 * The Page's Files as a Property with an outline beneath it. Its row says how many Files there
 * are and, when one origin attached them all, who; its label is the root that folds and unfolds
 * the tree, whose rows are indented one icon step beneath it across the Properties' width.
 */
export function PageFilesRow({ baseFiles, controller, hidden = false }: PageFilesRowProps) {
  const intl = useIntl();

  const metadata = useLibraryMetadata();
  const pageId = controller.page?.id ?? "";
  const routingContext = controller.contentRoutingContext;
  const inventory = baseFiles.inventory ?? emptyPageFileInventory(pageId);
  const [disclosure, setDisclosure] = useScopedAtom(pageFilesDisclosureFamily(pageId));
  const treeId = useId();
  const files = inventory.files.map(toPageFileTreeFile);
  const tree = buildPageFileTree(files, {
    collapsedFolders: new Set(disclosure.collapsedFolders),
    bodyGroupExpanded: disclosure.bodyGroupExpanded,
  });
  const sourceOf = usePageFileSources(
    files.flatMap((file) => (file.sourceKey ? [file.sourceKey] : [])),
  );
  const { fresh, markOpened } = useFreshPageFileIds(
    pageId,
    baseFiles.inventory ? inventory.files.map((item) => item.file.file_id) : null,
  );

  const [attachmentsSeenOn, setAttachmentsSeenOn] = useState<string | null>(null);
  const openFiles = usePageFilesDialog(controller, baseFiles);
  const [imagePreview, setImagePreview] = useState<{
    readonly pageId: string;
    readonly fileId: string;
  } | null>(null);

  const authority = metadata.data
    ? {
        contentRoutingContext: routingContext,
        storeEpoch: metadata.data.storeEpoch,
        libraryId: metadata.data.libraryId,
      }
    : null;

  const fileDrop = useSystemFileDrop({
    enabled: authority !== null && baseFiles.inventory !== null,
    onDrop: (dropped) => {
      if (!authority) return;
      const operationId = createUuidV7();
      void prepareDroppedFiles(routingContext, operationId, dropped)
        .then((prepared) =>
          importPreparedPageEntries(authority, pageId, inventory.revision, operationId, prepared),
        )
        .then(() =>
          toast.success(
            dropped.length === 1
              ? intl.formatMessage({
                  id: "board.pageFilesRow.fileAdded",
                  defaultMessage: "File added",
                })
              : intl.formatMessage({
                  id: "board.pageFilesRow.filesAdded",
                  defaultMessage: "Files added",
                }),
          ),
        )
        .catch((error: unknown) => toast.danger(pageFilesMutationMessage(error)))
        .finally(() => void baseFiles.refresh());
    },
  });

  if (!controller.page) return null;

  const saveFile = (item: LibraryPageFileItem): void => {
    if (!authority) return;
    void saveAuthorizedFile(
      { ...authority, readSource: { kind: "page", page_id: pageId } },
      fileSource(item.file.file_id),
      fileTitle(item),
    ).catch((error: unknown) =>
      toast.danger(
        error instanceof Error
          ? error.message
          : intl.formatMessage({
              id: "board.pageFilesRow.saveFailed",
              defaultMessage: "Couldn’t save File",
            }),
      ),
    );
  };

  const revealFile = (item: LibraryPageFileItem): void => {
    if (!authority) return;
    void revealFileExport(() =>
      materializeAuthorizedFile(
        { ...authority, readSource: { kind: "page", page_id: pageId } },
        fileSource(item.file.file_id),
        fileTitle(item),
      ),
    );
  };

  const openFile = (item: LibraryPageFileItem, openMode: "preview" | "durable"): void => {
    markOpened(item.file.file_id);
    if (openMode === "preview" && authority && isImageFile(item)) {
      setImagePreview({ pageId, fileId: item.file.file_id });
      return;
    }
    setImagePreview(null);
    if (!controller.openPageFile) {
      openFiles(item.file.file_id);
      return;
    }
    void controller.openPageFile({
      pageId,
      fileId: item.file.file_id,
      logicalPath: item.logical_path ?? null,
      title: fileTitle(item),
      openMode,
    });
  };

  const renderSource = (provenance: PageFileTreeProvenance, className?: string) => {
    const presentation = sourceOf(provenance.sourceKey);
    return presentation ? (
      <PageFileSourceLabel
        provenance={provenance}
        presentation={presentation}
        onOpenChat={
          controller.onOpenRelatedChat
            ? (sessionId) => void controller.handleOpenRelatedChat(sessionId)
            : undefined
        }
        className={className}
      />
    ) : null;
  };

  // The preview steps through the Page's images in the order the tree lists them.
  const images = tree.rows.flatMap((row) =>
    row.kind === "file" && isImageFile(row.file.value) ? [row.file.value] : [],
  );
  const previewedIndex =
    imagePreview?.pageId === pageId
      ? images.findIndex((item) => item.file.file_id === imagePreview.fileId)
      : -1;
  const previewed = images[previewedIndex];
  const previewNeighbor = (step: 1 | -1): (() => void) | undefined => {
    const neighbor = images[previewedIndex + step];
    return neighbor
      ? () => {
          markOpened(neighbor.file.file_id);
          setImagePreview({ pageId, fileId: neighbor.file.file_id });
        }
      : undefined;
  };

  const hasFiles = inventory.total > 0;
  // Attachments are news the body does not show, so they open the tree; Files already in the
  // body can stay folded. Once open it stays open while the Page is mounted, so removing the
  // last attachment never folds the tree under the person's hands.
  const hasAttachments = inventory.unplaced_total > 0;
  if (hasAttachments && attachmentsSeenOn !== pageId) setAttachmentsSeenOn(pageId);
  const expanded =
    hasFiles && (disclosure.expanded ?? (hasAttachments || attachmentsSeenOn === pageId));
  const visibleRows = disclosure.showAll ? tree.rows : tree.rows.slice(0, PAGE_FILE_TREE_ROW_LIMIT);
  const hiddenRows = tree.rows.length - visibleRows.length;
  const summary = intl.formatMessage(
    {
      id: "board.pageFilesRow.fileCount",
      defaultMessage: "{count, plural, one {# file} other {# files}}",
    },
    { count: inventory.total },
  );
  const provenance = tree.provenance;
  const origin = provenance ? (
    <span className="flex min-w-0 items-center gap-1 text-(--foreground-tertiary)">
      {intl.formatMessage(
        {
          id: "board.pageFilesRow.source",
          defaultMessage: "<prefix>from</prefix><source></source>",
        },
        {
          prefix: (chunks) => <span className="shrink-0">{chunks}</span>,
          source: () => renderSource(provenance, "min-w-0"),
        },
      )}
    </span>
  ) : null;
  const toggle = (): void => setDisclosure((current) => ({ ...current, expanded: !expanded }));

  return (
    <div
      hidden={hidden}
      data-page-files-property="true"
      // The drop surface hangs outside the content edge like every other surface in the list.
      className={cn(
        "group/page-files -mx-1.5 rounded-md px-1.5",
        fileDrop.active && "bg-token-foreground/4 ring-1 ring-token-focus-border",
      )}
      {...fileDrop.handlers}
    >
      {fileDrop.active ? (
        <span role="status" className="sr-only">
          {intl.formatMessage({
            id: "board.pageFilesRow.dropFiles",
            defaultMessage: "Drop Files to add them to this Page",
          })}
        </span>
      ) : null}
      <PageStagePropertyRow
        icon={<FileIcon />}
        label={intl.formatMessage({ id: "board.pageFilesRow.files", defaultMessage: "Files" })}
        disclosure={
          hasFiles
            ? {
                expanded,
                controls: treeId,
                onToggle: toggle,
              }
            : undefined
        }
      >
        {baseFiles.error && !baseFiles.inventory ? (
          <button
            type="button"
            className="min-h-7 text-xs text-(--red-text)"
            onClick={() => void baseFiles.refresh()}
          >
            {intl.formatMessage({
              id: "board.pageFilesRow.retryLoad",
              defaultMessage: "Couldn’t load Files · Retry",
            })}
          </button>
        ) : null}
        {baseFiles.loading && !baseFiles.inventory ? (
          <div
            role="status"
            aria-label={intl.formatMessage({
              id: "board.pageFilesRow.loadingFiles",
              defaultMessage: "Loading Page Files",
            })}
            className="flex h-7 items-center text-(--foreground-tertiary)"
          >
            <ActivitySpinnerIcon className="size-3.5" />
          </div>
        ) : null}
        {!baseFiles.loading && !baseFiles.error && !hasFiles ? (
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center text-left text-sm",
              DATABASE_PAGE_PROPERTY_BORDERLESS_VALUE_CLASS_NAME,
            )}
            onClick={() => openFiles()}
            aria-label={intl.formatMessage({
              id: "board.pageFilesRow.addFiles",
              defaultMessage: "Add Page Files",
            })}
            aria-busy={baseFiles.loading}
          >
            <PropertyEmptyValue className="truncate" />
          </button>
        ) : null}
        {hasFiles ? (
          <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2 text-sm">
            <button
              type="button"
              className={cn(
                "flex shrink-0 cursor-interaction items-center gap-1.5 text-token-text-primary",
                DATABASE_PAGE_PROPERTY_BORDERLESS_VALUE_CLASS_NAME,
              )}
              onClick={toggle}
            >
              {summary}
              {!expanded && fresh.size > 0 ? (
                <span
                  aria-label={intl.formatMessage({
                    id: "board.pageFilesRow.newFiles",
                    defaultMessage: "New files",
                  })}
                  className="size-1.5 rounded-full bg-info-solid"
                />
              ) : null}
            </button>
            {origin}
            <button
              type="button"
              aria-label={intl.formatMessage({
                id: "board.pageFilesRow.addFiles",
                defaultMessage: "Add Page Files",
              })}
              aria-busy={baseFiles.loading}
              className={pageStagePropertyAddControl}
              onClick={() => openFiles()}
            >
              <PlusIcon className="icon-2xs" />
            </button>
          </div>
        ) : null}
      </PageStagePropertyRow>
      {expanded ? (
        // Capped at the standard content width, so on a full-width Page a File's origin and size
        // stay within reach of its name. The guide beneath the Property's icon runs the tree's
        // whole height, tying it to its label.
        <div
          className="relative mb-1 max-w-3xl before:pointer-events-none before:absolute before:top-0 before:bottom-0.5 before:left-(--page-files-guide) before:border-l-[0.5px] before:border-token-border"
          style={{ "--page-files-guide": `${PAGE_FILE_TREE_GUIDE_OFFSET_PX}px` } as CSSProperties}
        >
          <PageFileTreeView
            id={treeId}
            rows={visibleRows}
            freshFileIds={fresh}
            renderSource={(provenance) => renderSource(provenance)}
            onToggleFolder={(path) =>
              setDisclosure((current) => ({
                ...current,
                collapsedFolders: current.collapsedFolders.includes(path)
                  ? current.collapsedFolders.filter((folder) => folder !== path)
                  : [...current.collapsedFolders, path],
              }))
            }
            onToggleBodyGroup={() =>
              setDisclosure((current) => ({
                ...current,
                bodyGroupExpanded: !current.bodyGroupExpanded,
              }))
            }
            onOpen={openFile}
            opensInPlace={(item) => authority !== null && isImageFile(item)}
            onSave={saveFile}
            onCopyPath={(item) => void writeTextToClipboard(pageFileLabel(item))}
            onReveal={revealFile}
            onManage={(item) => openFiles(item.file.file_id)}
            onRemovePath={
              authority
                ? (item) =>
                    void removePageEntry(authority, pageId, inventory.revision, item.file.file_id)
                      .then(async () => {
                        await baseFiles.refresh();
                        toast.success(
                          item.body_count > 0
                            ? intl.formatMessage({
                                id: "board.pageFilesRow.pathRemoved",
                                defaultMessage:
                                  "Page path removed; the File stays in the Page content",
                              })
                            : intl.formatMessage({
                                id: "board.pageFilesRow.removedFromPage",
                                defaultMessage:
                                  "Removed from the Page; the File stays in the Library",
                              }),
                        );
                      })
                      .catch((error: unknown) => toast.danger(pageFilesMutationMessage(error)))
                : undefined
            }
          />
          {hiddenRows > 0 || baseFiles.hasMore ? (
            <button
              type="button"
              className={TREE_FOOTER_BUTTON_CLASS_NAME}
              disabled={baseFiles.loadingMore}
              onClick={() => {
                setDisclosure((current) => ({ ...current, showAll: true }));
                if (hiddenRows === 0) void baseFiles.loadMore();
              }}
            >
              {baseFiles.loadingMore
                ? intl.formatMessage({
                    id: "board.pageFilesRow.loading",
                    defaultMessage: "Loading…",
                  })
                : hiddenRows > 0
                  ? intl.formatMessage(
                      {
                        id: "board.pageFilesRow.showMoreCount",
                        defaultMessage: "Show {count} more",
                      },
                      { count: hiddenRows },
                    )
                  : intl.formatMessage(
                      {
                        id: "board.pageFilesRow.showMoreTotal",
                        defaultMessage: "Show more of {count} files",
                      },
                      { count: inventory.total },
                    )}
            </button>
          ) : null}
        </div>
      ) : null}
      {previewed && authority ? (
        <FileReadBoundary
          authority={{ ...authority, readSource: { kind: "page", page_id: pageId } }}
        >
          <PageFileImagePreview
            fileId={previewed.file.file_id}
            name={fileTitle(previewed)}
            onClose={() => setImagePreview(null)}
            onPrevious={previewNeighbor(-1)}
            onNext={previewNeighbor(1)}
            onOpenInTab={controller.openPageFile ? () => openFile(previewed, "durable") : undefined}
          />
        </FileReadBoundary>
      ) : null}
    </div>
  );
}
