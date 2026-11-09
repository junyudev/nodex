import { lazy, Suspense, useState, type ReactNode } from "react";

import { DownloadIcon, PageIcon, RefreshIcon } from "@/components/shared/icons";
import { ChevronRightLgIcon, EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import {
  FileReadBoundary,
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { EmptyState } from "@/components/ui/empty-state";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import {
  ViewerButton,
  ViewerCapsule,
  ViewerHeader,
  ViewerIconButton,
} from "@/components/ui/viewer-header";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import {
  WorkspaceFileErrorState,
  WorkspaceFileLoadingState,
  WorkspaceFileTooLargeState,
} from "@/features/workspace-files/workspace-file-preview-states";
import { resolveWorkspaceSourceLanguage } from "@/features/workspace-files/workspace-file-model";
import { writeTextToClipboard } from "@/lib/clipboard";
import { formatBytes } from "@/lib/file-metadata-format";
import { saveAuthorizedFile } from "@/lib/library-file-resources";
import {
  PAGE_FILE_TEXT_PREVIEW_MAX_BYTES,
  pageFileHasSourceView,
  pageFileReadsText,
  resolvePageFileViewKind,
  type PageFileViewKind,
} from "@/lib/page-file-view-kind";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { fileSource } from "../../../shared/file-resources";
import type { LibraryPageFileItem } from "../../../shared/library-files";
import { PageFileHtmlView } from "./page-file-html-view";

const LazyWorkspacePdfPreview = lazy(async () => {
  const { WorkspacePdfPreview } = await import("@/features/workspace-files/workspace-pdf-preview");
  return { default: WorkspacePdfPreview };
});

/** Leaves room for a floating composer resting over a full-width side panel. */
const COMPOSER_RESERVE =
  "pb-[calc(var(--right-panel-composer-overlay-reserve,0px)+var(--spacing)*4)]";

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
            <PageFileContent
              key={`${item.file.file_id}:${item.file.head_version}`}
              item={item}
              name={name}
              kind={kind}
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

function PageFileContent({
  item,
  name,
  kind,
  source,
  onOpenExternalLink,
}: {
  readonly item: LibraryPageFileItem;
  readonly name: string;
  readonly kind: PageFileViewKind;
  readonly source: boolean;
  readonly onOpenExternalLink: (url: string) => void;
}) {
  const runtime = useFilePlacementRuntime();
  const size = item.file.byte_length;
  const readsText = (source || kind === "text" || kind === "markdown") && pageFileReadsText(kind);
  const textTooLarge = readsText && size > PAGE_FILE_TEXT_PREVIEW_MAX_BYTES;
  const media =
    !source && (kind === "image" || kind === "svg" || kind === "audio" || kind === "video");
  const snapshot = useFileReadSnapshot(runtime, fileSource(item.file.file_id), {
    content: readsText && !textTooLarge,
    objectUrl: media,
  });
  const [pdfUrl, setPdfUrl] = useState<{ readonly fileId: string; readonly url: string } | null>(
    null,
  );

  if (kind === "unsupported") {
    return (
      <EmptyState
        className="h-full min-h-0 px-4"
        icon={<FileBlankIcon />}
        title="This format can’t be previewed"
        description="Save it to open it in another app."
      />
    );
  }
  if (textTooLarge) {
    return (
      <WorkspaceFileTooLargeState sizeBytes={size} limitBytes={PAGE_FILE_TEXT_PREVIEW_MAX_BYTES} />
    );
  }
  if (kind === "pdf") {
    if (!runtime) return <WorkspaceFileLoadingState />;
    if (pdfUrl?.fileId !== item.file.file_id) {
      void runtime
        .readImageDataUrl(fileSource(item.file.file_id))
        .then((url) => setPdfUrl({ fileId: item.file.file_id, url }))
        .catch(() => setPdfUrl(null));
      return <WorkspaceFileLoadingState />;
    }
    return (
      <Suspense fallback={<WorkspaceFileLoadingState />}>
        <LazyWorkspacePdfPreview
          fileDataUrl={pdfUrl.url}
          title={name}
          onOpenExternalLink={onOpenExternalLink}
        />
      </Suspense>
    );
  }
  if (snapshot.contentError || snapshot.metadataError) {
    return <WorkspaceFileErrorState message="This File is no longer available." />;
  }
  if (media) {
    if (!snapshot.objectUrl) return <WorkspaceFileLoadingState />;
    if (kind === "audio" || kind === "video") {
      return (
        <div className={cn("flex h-full items-center justify-center p-6", COMPOSER_RESERVE)}>
          {kind === "audio" ? (
            <audio controls src={snapshot.objectUrl} className="w-full max-w-xl" />
          ) : (
            <video controls src={snapshot.objectUrl} className="max-h-full max-w-full rounded-lg" />
          )}
        </div>
      );
    }
    return <PageFileImage url={snapshot.objectUrl} name={name} byteLength={size} />;
  }
  if (!snapshot.bytes) return <WorkspaceFileLoadingState />;
  const text = new TextDecoder().decode(snapshot.bytes.bytes);
  if (kind === "markdown" && !source) {
    return (
      <div className={cn("h-full overflow-auto px-6 pt-4", COMPOSER_RESERVE)}>
        <MarkdownRenderer content={text} className="mx-auto max-w-3xl" />
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 pb-[var(--right-panel-composer-overlay-reserve,0px)]">
      <LazySourceViewer
        value={readableSource(text, name)}
        ariaLabel={`${name} source`}
        filename={name}
        language={resolveWorkspaceSourceLanguage(name)}
        lineNumbers
        sourceIdentity={`${item.file.file_id}:${item.file.head_version}`}
        className="h-full"
      />
    </div>
  );
}

/** Minified JSON reads as one endless line; show it indented. Saving keeps the original bytes. */
function readableSource(text: string, name: string): string {
  if (!/\.(?:json|geojson)$/iu.test(name) || text.includes("\n")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function PageFileImage({
  url,
  name,
  byteLength,
}: {
  readonly url: string;
  readonly name: string;
  readonly byteLength: number;
}) {
  const [dimensions, setDimensions] = useState<string | null>(null);
  return (
    <figure
      className={cn(
        "m-0 flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-6",
        COMPOSER_RESERVE,
      )}
    >
      <img
        src={url}
        alt={name}
        className="min-h-0 max-w-full shrink object-contain"
        onLoad={(event) =>
          setDimensions(
            `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
          )
        }
      />
      <figcaption className="text-xs text-(--color-text-tertiary) tabular-nums">
        {[dimensions, formatBytes(byteLength)].filter(Boolean).join(" · ")}
      </figcaption>
    </figure>
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
