import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { SidePanelFilesIcon } from "@/components/shared/icons";
import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import { EmptyState } from "@/components/ui/empty-state";
import {
  formatWorkspaceFileSize,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  type WorkspaceFileUnsupportedType,
} from "./workspace-file-model";

const UNSUPPORTED_TITLES: Record<WorkspaceFileUnsupportedType, MessageDescriptor> = {
  archive: defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.archive",
    defaultMessage: "Archive previews aren't supported yet",
  }),
  audio: defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.audio",
    defaultMessage: "Audio previews aren't supported yet",
  }),
  binary: defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.binary",
    defaultMessage: "Binary file previews aren't supported yet",
  }),
  image: defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.image",
    defaultMessage: "This image format can't be previewed yet",
  }),
  video: defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.video",
    defaultMessage: "Video previews aren't supported yet",
  }),
  "excel-spreadsheet": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.excel",
    defaultMessage: "Excel spreadsheet previews aren't supported yet",
  }),
  "keynote-deck": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.keynote",
    defaultMessage: "Keynote deck previews aren't supported yet",
  }),
  "numbers-spreadsheet": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.numbers",
    defaultMessage: "Numbers spreadsheet previews aren't supported yet",
  }),
  "opendocument-presentation": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.openDocumentPresentation",
    defaultMessage: "OpenDocument presentation previews aren't supported yet",
  }),
  "opendocument-spreadsheet": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.openDocumentSpreadsheet",
    defaultMessage: "OpenDocument spreadsheet previews aren't supported yet",
  }),
  "opendocument-text": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.openDocumentText",
    defaultMessage: "OpenDocument text previews aren't supported yet",
  }),
  "pages-document": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.pages",
    defaultMessage: "Pages document previews aren't supported yet",
  }),
  "powerpoint-deck": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.powerPoint",
    defaultMessage: "PowerPoint deck previews aren't supported yet",
  }),
  "rich-text-document": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.richText",
    defaultMessage: "Rich Text document previews aren't supported yet",
  }),
  "word-document": defineMessage({
    id: "workspaceFiles.workspaceFilePreviewStates.word",
    defaultMessage: "Word document previews aren't supported yet",
  }),
};

export function WorkspaceFileOpenFileState() {
  const intl = useIntl();
  return (
    <EmptyState
      className="h-full min-h-0 p-6"
      icon={<SidePanelFilesIcon />}
      title={
        <h2>
          {intl.formatMessage({
            id: "workspaceFiles.workspaceFilePreviewStates.open",
            defaultMessage: "Open file",
          })}
        </h2>
      }
      description={intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.selectFile",
        defaultMessage: "Select a file from the workspace tree",
      })}
    />
  );
}

/** A Files tab with neither a file nor a workspace folder to browse. */
export function WorkspaceFileUnavailableState() {
  const intl = useIntl();
  return (
    <EmptyState
      className="h-full min-h-0 p-6"
      icon={<SidePanelFilesIcon />}
      title={intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.noWorkspace",
        defaultMessage: "No file or workspace folder is available.",
      })}
    />
  );
}

export function WorkspaceFileUnsupportedState({ type }: { type: WorkspaceFileUnsupportedType }) {
  const intl = useIntl();
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      width="wide"
      icon={<FileBlankIcon />}
      title={intl.formatMessage(UNSUPPORTED_TITLES[type])}
      description={intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.openElsewhere",
        defaultMessage: "Open this file in another app to view it",
      })}
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
  const intl = useIntl();
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      icon={<FileBlankIcon aria-hidden="true" />}
      title={intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.tooLarge",
        defaultMessage: "File is too large to preview",
      })}
      description={intl.formatMessage(
        {
          id: "workspaceFiles.workspaceFilePreviewStates.previewLimit",
          defaultMessage: "{size} exceeds the {limit} preview limit",
        },
        {
          size: formatWorkspaceFileSize(sizeBytes, intl),
          limit: formatWorkspaceFileSize(limitBytes, intl),
        },
      )}
    />
  );
}

export function WorkspaceFileLoadingState() {
  const intl = useIntl();
  return (
    <div className="flex h-full items-center justify-center px-4 text-sm text-(--color-codex-description)">
      {intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.loading",
        defaultMessage: "Loading file…",
      })}
    </div>
  );
}

export function WorkspaceFileErrorState({ message }: { message?: string | null }) {
  const intl = useIntl();
  return (
    <EmptyState
      className="h-full min-h-0 px-4"
      icon={<FileBlankIcon />}
      title={intl.formatMessage({
        id: "workspaceFiles.workspaceFilePreviewStates.loadFailed",
        defaultMessage: "Unable to load file",
      })}
      description={message ?? undefined}
    />
  );
}
