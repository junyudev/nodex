import { SidePanelFilesIcon } from "@/components/shared/icons";
import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import { EmptyState } from "@/components/ui/empty-state";
import {
  formatWorkspaceFileSize,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  type WorkspaceFileUnsupportedType,
} from "./workspace-file-model";

const UNSUPPORTED_TITLES: Record<WorkspaceFileUnsupportedType, string> = {
  archive: "Archive previews aren't supported yet",
  audio: "Audio previews aren't supported yet",
  binary: "Binary file previews aren't supported yet",
  image: "This image format can't be previewed yet",
  video: "Video previews aren't supported yet",
  "excel-spreadsheet": "Excel spreadsheet previews aren't supported yet",
  "keynote-deck": "Keynote deck previews aren't supported yet",
  "numbers-spreadsheet": "Numbers spreadsheet previews aren't supported yet",
  "opendocument-presentation": "OpenDocument presentation previews aren't supported yet",
  "opendocument-spreadsheet": "OpenDocument spreadsheet previews aren't supported yet",
  "opendocument-text": "OpenDocument text previews aren't supported yet",
  "pages-document": "Pages document previews aren't supported yet",
  "powerpoint-deck": "PowerPoint deck previews aren't supported yet",
  "rich-text-document": "Rich Text document previews aren't supported yet",
  "word-document": "Word document previews aren't supported yet",
};

export function WorkspaceFileOpenFileState() {
  return (
    <EmptyState
      className="h-full min-h-0 p-6"
      icon={<SidePanelFilesIcon />}
      title={<h2>Open file</h2>}
      description="Select a file from the workspace tree"
    />
  );
}

/** A Files tab with neither a file nor a workspace folder to browse. */
export function WorkspaceFileUnavailableState() {
  return (
    <EmptyState
      className="h-full min-h-0 p-6"
      icon={<SidePanelFilesIcon />}
      title="No file or workspace folder is available."
    />
  );
}

export function WorkspaceFileUnsupportedState({ type }: { type: WorkspaceFileUnsupportedType }) {
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      width="wide"
      icon={<FileBlankIcon />}
      title={UNSUPPORTED_TITLES[type]}
      description="Open this file in another app to view it"
    />
  );
}

export function WorkspaceFileTooLargeState({
  sizeBytes,
  limitBytes = WORKSPACE_FILE_PREVIEW_MAX_BYTES,
}: {
  sizeBytes: number;
  limitBytes?: number;
}) {
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      icon={<FileBlankIcon aria-hidden="true" />}
      title="File is too large to preview"
      description={`${formatWorkspaceFileSize(sizeBytes)} exceeds the ${formatWorkspaceFileSize(limitBytes)} preview limit`}
    />
  );
}

export function WorkspaceFileLoadingState() {
  return (
    <div className="flex h-full items-center justify-center px-4 text-sm text-(--color-codex-description)">
      Loading file…
    </div>
  );
}

export function WorkspaceFileErrorState({ message }: { message?: string | null }) {
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      icon={<FileBlankIcon />}
      title="Unable to load file"
      description={message ?? undefined}
    />
  );
}
