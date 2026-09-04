import { PortableRichTitle } from "@/components/block-documents/portable-rich-title";
import { canonicalizePortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type {
  DocumentRecoveryScope,
  RecoveryPreview as Preview,
} from "../../../shared/block-documents/document-recovery";
import { CanvasFilePreview } from "@/components/canvas/canvas-file-preview";
import { ReadonlyNfmBlockNotePreview } from "@/components/board/editor/readonly-nfm-blocknote-preview";

export function RecoveryPreview({
  value,
  scope,
  documentId,
  draftId,
  storeEpoch,
}: {
  value: Preview | null | undefined;
  scope: DocumentRecoveryScope;
  documentId: string;
  draftId: string;
  storeEpoch: string | null;
}) {
  if (!value)
    return (
      <p className="text-sm text-token-description-foreground">
        A complete preview is unavailable. The original draft is still retained.
      </p>
    );
  if (value.kind === "canvas")
    return (
      <CanvasFilePreview
        scene={value.scene}
        label="Retained Canvas scene"
        authority={
          storeEpoch
            ? {
                libraryId: scope.libraryId,
                storeEpoch,
                contentAccessContext: scope.accessContext,
                documentId,
                bindings: value.files,
              }
            : null
        }
      />
    );
  return (
    <article className="min-w-0">
      <h2 className="mb-5 text-xl font-semibold text-token-text-primary">
        <PortableRichTitle
          value={canonicalizePortableRichText(value.rich_title)}
          fallback={value.title || "Untitled document"}
        />
      </h2>
      <ReadonlyNfmBlockNotePreview
        fileAuthority={
          storeEpoch
            ? {
                libraryId: scope.libraryId,
                storeEpoch,
                contentAccessContext: scope.accessContext,
                bindings: value.files,
              }
            : null
        }
        content={value.nfm}
        projectId={scope.accessContext.kind === "project" ? scope.accessContext.projectId : ""}
        pageId={documentId}
        historyId={draftId}
      />
    </article>
  );
}
