import type { SyntheticEvent } from "react";
import { BlockDocumentSurface } from "@/components/block-documents/block-document-surface";
import { BlockDocumentSyncStatus } from "@/components/block-documents/block-document-sync-status";
import { CollaborativePageTitle } from "@/components/block-documents/collaborative-page-title";
import { OwnedBlockDocumentBoundary } from "@/components/block-documents/owned-block-document-boundary";
import type { BlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import type { DatabasePageSummary } from "@/lib/types";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { useProjects } from "@/lib/use-projects";
import { resolveReferencedProjectContext } from "@/lib/referenced-project-context";
import {
  libraryContentAccess,
  projectIdFromContentAccessContext,
} from "../../../../shared/content-access-context";
import { NfmEditor } from "./nfm-editor";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";

export interface EmbeddedReferencedPageDocumentProps {
  readonly card: DatabasePageSummary;
  readonly isActive: boolean;
  readonly hostRuntime: BlockReferenceHostRuntime | null;
}

const stopNestedEditorEvent = (event: SyntheticEvent): void => {
  event.stopPropagation();
};

/**
 * Opens the referenced Page's own Y.Doc. This component is lazy-loaded so a
 * collapsed reference pays neither the NfmEditor bundle cost nor a provider.
 */
export function EmbeddedReferencedPageDocument({
  card,
  isActive,
  hostRuntime,
}: EmbeddedReferencedPageDocumentProps) {
  const contentAccessContext = hostRuntime?.contentAccessContext ?? libraryContentAccess;
  const executionProjectId = projectIdFromContentAccessContext(contentAccessContext);
  const { projects } = useProjects();
  const targetProject = resolveReferencedProjectContext(executionProjectId ?? "", projects);
  const targetLibraryId =
    projects.find((project) => project.id === executionProjectId)?.libraryId ??
    projects[0]?.libraryId;
  return (
    <OwnedBlockDocumentBoundary accessContext={contentAccessContext} ownerBlockId={card.id}>
      {(model, controls) => {
        if (model.status === "loading") {
          return (
            <div className="py-2 text-sm text-token-description-foreground">
              Opening collaborative document…
            </div>
          );
        }
        if (model.status === "error") {
          return (
            <div role="alert" className="py-2 text-sm text-token-error-foreground">
              {model.error.message}
            </div>
          );
        }
        return (
          <BlockDocumentSurface
            descriptor={model.descriptor}
            pageTitleIdentity={
              targetLibraryId ? { libraryId: targetLibraryId, pageId: card.id } : undefined
            }
            isActive={isActive}
            onReload={controls.reload}
            localAwarenessState={{
              user: { name: "You", color: "#3b82f6" },
              nodex: { embedded: true },
            }}
          >
            {(surface) => (
              <div
                data-embedded-page-document={card.id}
                {...embeddedEditorSelectionContextAttributes}
                className="min-w-0 py-1"
                onBeforeInput={stopNestedEditorEvent}
                onClick={stopNestedEditorEvent}
                onDoubleClick={stopNestedEditorEvent}
                onDragStart={stopNestedEditorEvent}
                onDrop={stopNestedEditorEvent}
                onInput={stopNestedEditorEvent}
                onKeyDown={stopNestedEditorEvent}
                onPaste={stopNestedEditorEvent}
                onPointerDown={stopNestedEditorEvent}
              >
                <div className="flex min-w-0 items-start gap-2 pr-1">
                  <CollaborativePageTitle
                    title={surface.title}
                    historyScope={surface.descriptor}
                    className="min-w-0 flex-1 py-0 text-base/snug font-semibold"
                    aria-label={`Edit ${card.title.trim() || "Untitled"} title`}
                  />
                  <BlockDocumentSyncStatus
                    runtime={surface.runtime}
                    status={surface.status.provider}
                  />
                </div>
                <NfmEditor
                  contentAccessContext={contentAccessContext}
                  projectName={targetProject.projectName}
                  projectWorkspacePath={targetProject.projectWorkspacePath}
                  source={{
                    kind: "collaborative-document",
                    documentId: surface.documentId,
                    storeEpoch: surface.descriptor.storeEpoch,
                    generation: surface.descriptor.generation,
                    clientSessionId: surface.clientSessionId,
                    fragment: surface.body,
                    user: { name: "You", color: "#3b82f6" },
                    provider: { awareness: surface.awareness },
                  }}
                  sourcePageContext={{ pageId: card.id }}
                  surfaceMutationBarrier={surface.runtime}
                  onOpenPage={hostRuntime?.openPage}
                  onOpenCanvas={hostRuntime?.openCanvas}
                  isActivePanelTab={isActive}
                  placeholder={PAGE_DESCRIPTION_PLACEHOLDER}
                  className="min-w-0"
                />
              </div>
            )}
          </BlockDocumentSurface>
        );
      }}
    </OwnedBlockDocumentBoundary>
  );
}
