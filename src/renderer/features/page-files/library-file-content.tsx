import { lazy, Suspense, useState } from "react";

import {
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import { EmptyState } from "@/components/ui/empty-state";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import {
  WorkspaceFileErrorState,
  WorkspaceFileLoadingState,
  WorkspaceFileTooLargeState,
} from "@/features/workspace-files/workspace-file-preview-states";
import { resolveWorkspaceSourceLanguage } from "@/features/workspace-files/workspace-file-model";
import { formatBytes } from "@/lib/file-metadata-format";
import {
  PAGE_FILE_TEXT_PREVIEW_MAX_BYTES,
  pageFileReadsText,
  type PageFileViewKind,
} from "@/lib/page-file-view-kind";
import { cn } from "@/lib/utils";
import { fileSource } from "../../../shared/file-resources";

const LazyWorkspacePdfPreview = lazy(async () => {
  const { WorkspacePdfPreview } = await import("@/features/workspace-files/workspace-pdf-preview");
  return { default: WorkspacePdfPreview };
});

/** Leaves room for a floating composer resting over a full-width side panel. */
export const COMPOSER_RESERVE =
  "pb-[calc(var(--right-panel-composer-overlay-reserve,0px)+var(--spacing)*4)]";

export interface LibraryFileContentFile {
  readonly fileId: string;
  /** Changes whenever the bytes this view shows change, such as a File version. */
  readonly identity: string;
  readonly name: string;
  readonly kind: PageFileViewKind;
  readonly byteLength: number;
}

/**
 * One Library File as itself, read through the surrounding File read boundary: Markdown renders,
 * media plays, text and code show as source. HTML is shown as source here; only a Page File tab
 * can render it as a page, in its isolated preview.
 */
export function LibraryFileContent({
  file,
  source,
  onOpenExternalLink,
}: {
  readonly file: LibraryFileContentFile;
  readonly source: boolean;
  readonly onOpenExternalLink: (url: string) => void;
}) {
  const { fileId, identity, name, kind, byteLength } = file;
  const runtime = useFilePlacementRuntime();
  const showSource = source || kind === "html";
  const readsText =
    (showSource || kind === "text" || kind === "markdown") && pageFileReadsText(kind);
  const textTooLarge = readsText && byteLength > PAGE_FILE_TEXT_PREVIEW_MAX_BYTES;
  const media =
    !showSource && (kind === "image" || kind === "svg" || kind === "audio" || kind === "video");
  const snapshot = useFileReadSnapshot(runtime, fileSource(fileId), {
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
      <WorkspaceFileTooLargeState
        sizeBytes={byteLength}
        limitBytes={PAGE_FILE_TEXT_PREVIEW_MAX_BYTES}
      />
    );
  }
  if (kind === "pdf") {
    if (!runtime) return <WorkspaceFileLoadingState />;
    if (pdfUrl?.fileId !== fileId) {
      void runtime
        .readImageDataUrl(fileSource(fileId))
        .then((url) => setPdfUrl({ fileId, url }))
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
    return <LibraryFileImage url={snapshot.objectUrl} name={name} byteLength={byteLength} />;
  }
  if (!snapshot.bytes) return <WorkspaceFileLoadingState />;
  const text = new TextDecoder().decode(snapshot.bytes.bytes);
  if (kind === "markdown" && !showSource) {
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
        sourceIdentity={`${fileId}:${identity}`}
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

function LibraryFileImage({
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
