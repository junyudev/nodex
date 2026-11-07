import type { MarkdownBlock } from "../../../shared/nodex-markdown";
import type {
  DocumentRecoveryScope,
  RecoveryPreview as Preview,
} from "../../../shared/block-documents/document-recovery";
import { CanvasFilePreview } from "@/components/canvas/canvas-file-preview";
import { ReadonlyMarkdownBlockNotePreview } from "@/components/board/editor/readonly-nfm-blocknote-preview";

/** Identifies which draft a preview reads its files through. */
export interface RecoveryPreviewContext {
  readonly scope: DocumentRecoveryScope;
  readonly documentId: string;
  readonly draftId: string;
  readonly storeEpoch: string | null;
}

type PreviewFiles = Preview["files"];

/** Renders Page content from one captured version, or Blocks already read from a comparison. */
export function RecoveryDocumentPreview({
  content,
  files,
  context: { scope, documentId, draftId, storeEpoch },
}: {
  readonly content: string | readonly MarkdownBlock[];
  readonly files: PreviewFiles;
  readonly context: RecoveryPreviewContext;
}) {
  return (
    <ReadonlyMarkdownBlockNotePreview
      fileAuthority={
        storeEpoch
          ? {
              libraryId: scope.libraryId,
              storeEpoch,
              contentRoutingContext: scope.routingContext,
              bindings: files,
            }
          : null
      }
      content={content}
      projectId={scope.routingContext.kind === "project" ? scope.routingContext.projectId : ""}
      pageId={documentId}
      historyId={draftId}
    />
  );
}

export function RecoveryCanvasPreview({
  value,
  context: { scope, documentId, storeEpoch },
}: {
  readonly value: Extract<Preview, { kind: "canvas" }>;
  readonly context: RecoveryPreviewContext;
}) {
  return (
    <CanvasFilePreview
      scene={value.scene}
      label="Canvas preview"
      authority={
        storeEpoch
          ? {
              libraryId: scope.libraryId,
              storeEpoch,
              contentRoutingContext: scope.routingContext,
              documentId,
              bindings: value.files,
            }
          : null
      }
    />
  );
}
