import { useState } from "react";

import {
  FileReadBoundary,
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { DownloadIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  WorkspaceFileErrorState,
  WorkspaceFileLoadingState,
} from "@/features/workspace-files/workspace-file-preview-states";
import { openExternalUrl } from "@/lib/file-system-operations";
import { formatBytes } from "@/lib/file-metadata-format";
import type { FilePreviewAuthority, FileReadAuthority } from "@/lib/library-file-resources";
import type { ModalCloseProps } from "@/lib/modal-registry";
import {
  describeFileFormat,
  pageFileHasSourceView,
  resolvePageFileViewKind,
} from "@/lib/page-file-view-kind";
import { fileSource } from "../../../shared/file-resources";
import { LibraryFileContent } from "./library-file-content";

const DOUBLE_CLICK_MS = 500;

export interface LibraryFileViewerDialogProps extends ModalCloseProps {
  /** The exact read capability of the surface that showed the File, such as a history revision. */
  readonly authority: FileReadAuthority | FilePreviewAuthority;
  readonly fileId: string;
  /** Shown until the File's own metadata arrives. */
  readonly name: string;
}

/**
 * A File opened from a surface that has no tab beside it, such as a Page's history: the same
 * presentation as a Page File tab, read through the surface's own authority so a historical
 * reference shows the version it captured.
 */
export function LibraryFileViewerDialog({
  authority,
  fileId,
  name,
  onClose,
}: LibraryFileViewerDialogProps) {
  const [openedAt] = useState(() => performance.now());
  return (
    <NodexDialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // A double click opens the viewer with its first click; its second must not close it.
        if (details.reason === "outside" && performance.now() - openedAt < DOUBLE_CLICK_MS) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <NodexDialogContent
        size="large"
        className="flex h-[min(760px,84vh)] flex-col bg-surface backdrop-blur-none"
        closeButtonClassName="top-[1.125rem]"
        data-library-file-viewer="true"
      >
        <FileReadBoundary authority={authority}>
          <LibraryFileViewer fileId={fileId} fallbackName={name} />
        </FileReadBoundary>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function LibraryFileViewer({
  fileId,
  fallbackName,
}: {
  readonly fileId: string;
  readonly fallbackName: string;
}) {
  const runtime = useFilePlacementRuntime();
  const source = fileSource(fileId);
  const { metadata, metadataError } = useFileReadSnapshot(runtime, source, { metadata: true });
  const [showSource, setShowSource] = useState(false);
  const name = metadata?.default_name || fallbackName;
  const mimeType = metadata?.mime_type ?? "";
  const kind = metadata ? resolvePageFileViewKind({ name, mimeType }) : null;
  // HTML renders as a page only in its Page's isolated preview; here it is always source.
  const canToggleSource = kind !== null && kind !== "html" && pageFileHasSourceView(kind);

  const save = async (): Promise<void> => {
    if (!runtime) return;
    try {
      await runtime.save(source, name);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
    }
  };

  return (
    <>
      <header className="flex min-w-0 items-center gap-3 border-b-[0.5px] border-token-border py-3 ps-5 pe-14">
        <ColorfulFileResourceIcon path={name} mimeType={mimeType} className="size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <NodexDialogTitle className="truncate text-base">{name}</NodexDialogTitle>
          <NodexDialogDescription className="truncate text-xs">
            {metadata
              ? `${describeFileFormat({ name, mimeType })} · ${formatBytes(metadata.byte_length)}`
              : " "}
          </NodexDialogDescription>
        </div>
        {canToggleSource ? (
          <NodexButton
            variant="ghostSecondary"
            size="xs"
            onClick={() => setShowSource((current) => !current)}
          >
            {showSource ? "View preview" : "View source"}
          </NodexButton>
        ) : null}
        <NodexIconButton
          icon={DownloadIcon}
          ariaLabel="Save…"
          size="sm"
          disabled={!metadata}
          onClick={() => void save()}
        />
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {metadata && kind ? (
          <LibraryFileContent
            key={`${fileId}:${metadata.version}`}
            file={{
              fileId,
              identity: String(metadata.version),
              name,
              kind,
              byteLength: metadata.byte_length,
            }}
            source={showSource}
            onOpenExternalLink={(url) =>
              void openExternalUrl(url).catch(() => toast.danger("Unable to open external link"))
            }
          />
        ) : metadataError ? (
          <WorkspaceFileErrorState message="This File is no longer available." />
        ) : (
          <WorkspaceFileLoadingState />
        )}
      </div>
    </>
  );
}
