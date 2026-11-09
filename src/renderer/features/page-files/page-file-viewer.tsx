import { useState, type ReactNode } from "react";

import { DownloadIcon, PageIcon, RefreshIcon } from "@/components/shared/icons";
import { ChevronRightLgIcon, EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { EmptyState } from "@/components/ui/empty-state";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import {
  ViewerButton,
  ViewerCapsule,
  ViewerHeader,
  ViewerIconButton,
} from "@/components/ui/viewer-header";
import { writeTextToClipboard } from "@/lib/clipboard";
import { saveAuthorizedFile } from "@/lib/library-file-resources";
import { pageFileHasSourceView, resolvePageFileViewKind } from "@/lib/page-file-view-kind";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { useTheme } from "@/lib/use-theme";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { fileSource } from "../../../shared/file-resources";
import type { LibraryPageFileItem } from "../../../shared/library-files";
import { LibraryFileContent } from "./library-file-content";
import { PageFileHtmlView } from "./page-file-html-view";

export interface PageFileViewerProps {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly pageTitle: string;
  readonly item: LibraryPageFileItem;
  readonly onOpenPage: () => void;
  readonly onManage: () => void;
  readonly onOpenInLibrary: () => void;
  readonly onOpenExternalLink: (url: string) => void;
  /** The person did something that keeps this tab: a preview tab becomes a durable one. */
  readonly onKeep: () => void;
}

/** One Page File in its own tab: its path back to the Page, then the File as itself. */
export function PageFileViewer({
  routingContext,
  pageId,
  pageTitle,
  item,
  onOpenPage,
  onManage,
  onOpenInLibrary,
  onOpenExternalLink,
  onKeep,
}: PageFileViewerProps) {
  const metadata = useLibraryMetadata();
  const { resolved: colorScheme } = useTheme();
  const name = item.logical_path?.split("/").at(-1) ?? item.file.default_name;
  const kind = resolvePageFileViewKind({ name, mimeType: item.file.mime_type });
  const [showSource, setShowSource] = useState(false);
  const [reloads, setReloads] = useState(0);
  const authority = metadata.data
    ? {
        contentRoutingContext: routingContext,
        storeEpoch: metadata.data.storeEpoch,
        libraryId: metadata.data.libraryId,
        readSource: { kind: "page" as const, page_id: pageId },
      }
    : null;
  const sourceView = pageFileHasSourceView(kind) && showSource;
  const htmlPreview = kind === "html" && !sourceView;

  const save = async (): Promise<void> => {
    if (!authority) return;
    try {
      await saveAuthorizedFile(authority, fileSource(item.file.file_id), name);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-page-file-viewer={kind}>
      <ViewerHeader
        className="@container/file-header w-full"
        density="compact"
        label="Page File"
        leading={[
          {
            id: "file-path",
            allowShrink: true,
            grow: true,
            collapseSteps: (item.logical_path?.split("/").slice(0, -1) ?? []).map((_, index) => ({
              priority: index,
              selector: `[data-file-ancestor="${index}"]`,
            })),
            content: (
              <ViewerCapsule className="flex min-w-0 items-center">
                <PageFileBreadcrumb
                  pageTitle={pageTitle}
                  logicalPath={item.logical_path ?? null}
                  name={name}
                  onOpenPage={onOpenPage}
                />
              </ViewerCapsule>
            ),
          },
          {
            id: "file-actions",
            content: (
              <div className="flex items-center gap-1.5">
                {pageFileHasSourceView(kind) ? (
                  <ViewerButton
                    onClick={() => {
                      setShowSource((current) => !current);
                      onKeep();
                    }}
                  >
                    {showSource ? "View preview" : "View source"}
                  </ViewerButton>
                ) : null}
                {htmlPreview ? (
                  <ViewerIconButton
                    label="Reload"
                    tooltipDelayOpen
                    onClick={() => setReloads((count) => count + 1)}
                  >
                    <RefreshIcon className="icon-sm" />
                  </ViewerIconButton>
                ) : null}
                <ViewerIconButton
                  label="Save…"
                  tooltipDelayOpen
                  disabled={!authority}
                  onClick={() => void save()}
                >
                  <DownloadIcon className="icon-sm" />
                </ViewerIconButton>
                <NodexDropdownMenu
                  align="end"
                  contentWidth="menu"
                  triggerTooltipContent="More"
                  triggerButton={
                    <ViewerButton aria-label="More" uniform>
                      <EllipsisIcon />
                    </ViewerButton>
                  }
                >
                  {item.logical_path ? (
                    <NodexDropdownItem
                      onSelect={() => void writeTextToClipboard(item.logical_path ?? "")}
                    >
                      Copy path
                    </NodexDropdownItem>
                  ) : null}
                  <NodexDropdownItem onSelect={onManage}>Manage in Page files…</NodexDropdownItem>
                  <NodexDropdownItem onSelect={onOpenInLibrary}>Open in Library…</NodexDropdownItem>
                </NodexDropdownMenu>
              </div>
            ),
          },
        ]}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {htmlPreview ? (
          <PageFileHtmlView
            routingContext={routingContext}
            pageId={pageId}
            fileId={item.file.file_id}
            logicalPath={item.logical_path ?? null}
            colorScheme={colorScheme}
            reloadKey={`${item.file.head_version}:${reloads}`}
            className="pb-[var(--right-panel-composer-overlay-reserve,0px)]"
          />
        ) : (
          <FileReadBoundary authority={authority}>
            <LibraryFileContent
              key={`${item.file.file_id}:${item.file.head_version}`}
              file={{
                fileId: item.file.file_id,
                identity: String(item.file.head_version),
                name,
                kind,
                byteLength: item.file.byte_length,
              }}
              source={sourceView}
              onOpenExternalLink={onOpenExternalLink}
            />
          </FileReadBoundary>
        )}
      </div>
    </div>
  );
}

function PageFileBreadcrumb({
  pageTitle,
  logicalPath,
  name,
  onOpenPage,
}: {
  readonly pageTitle: string;
  readonly logicalPath: string | null;
  readonly name: string;
  readonly onOpenPage: () => void;
}) {
  const folders = logicalPath?.split("/").slice(0, -1) ?? [];
  const separator = <ChevronRightLgIcon className="shrink-0 text-tertiary" />;
  return (
    <nav
      aria-label="File path"
      className="flex h-full min-w-0 items-center overflow-hidden ps-1 pe-1"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1 text-sm semantic-text-secondary">
        <li className="flex min-w-0 shrink items-center gap-1">
          <button
            type="button"
            className="no-drag flex min-w-0 cursor-interaction items-center gap-1 rounded-full px-1 py-0.5 hover:bg-(--color-background-primary-ghost-hover) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-token-focus-border"
            onClick={onOpenPage}
          >
            <PageIcon className="icon-sm shrink-0" />
            <span className="max-w-48 min-w-0 truncate">{pageTitle}</span>
          </button>
          {separator}
        </li>
        {folders.map((folder, index) => (
          <li
            key={`${index}:${folder}`}
            data-file-ancestor={index}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap"
          >
            {folder}
            {separator}
          </li>
        ))}
        <li className="flex min-w-0 items-center">
          <span className="min-w-0 truncate pe-1 font-medium text-(--color-text)">{name}</span>
        </li>
      </ol>
    </nav>
  );
}

/** A Page File tab whose File left the Page: removed, or replaced outside its path. */
export function PageFileUnavailable({
  pageTitle,
  onOpenPage,
}: {
  readonly pageTitle: string;
  readonly onOpenPage: () => void;
}): ReactNode {
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      icon={<FileBlankIcon />}
      title="This File is no longer in the Page"
      description={`It was removed from ${pageTitle}.`}
      actions={
        <ViewerButton onClick={onOpenPage}>
          <PageIcon className="icon-sm" />
          Open Page
        </ViewerButton>
      }
    />
  );
}
