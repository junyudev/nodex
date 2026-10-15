import { lazy, Suspense, useEffect } from "react";

import { CanvasDocumentState } from "@/components/board/canvas-document-state";
import { makeCanvasSceneSurfaceKey } from "@/lib/canvas-scene-surface-runtime";
import { makeCanvasViewportPreferenceScope } from "@/lib/canvas-presentation-preference";
import { canvasDocumentSessionRegistry } from "@/lib/canvas-document-session";
import { useLibraryCanvasTarget } from "@/lib/use-library-navigation";
import type { WorkbenchSurfaceDescriptor } from "../../../shared/workbench-scene";

const CanvasDocumentSurface = lazy(async () => {
  const module = await import("@/components/canvas/canvas-document-surface");
  return { default: module.CanvasDocumentSurface };
});

type CanvasStageSurface = Extract<WorkbenchSurfaceDescriptor, { readonly kind: "canvas_stage" }>;

export function WorkbenchCanvasStagePanel({
  surface,
  windowSessionId,
  presentationOwnerId,
  isActivePanelTab,
  onClose,
  onTitleChange,
  onOpenPage,
}: {
  readonly surface: CanvasStageSurface;
  readonly windowSessionId: string;
  readonly presentationOwnerId: string;
  readonly isActivePanelTab: boolean;
  readonly onClose: () => void;
  readonly onTitleChange: (title: string) => void;
  readonly onOpenPage?: (input: {
    readonly pageId: string;
    readonly titleSnapshot?: string;
  }) => void;
}) {
  const target = useLibraryCanvasTarget(surface.config.canvasBlockId, isActivePanelTab);
  const summary = target.data?.value.status === "available" ? target.data.value.summary : null;

  useEffect(() => {
    if (!summary?.title || summary.title === surface.titleSnapshot) return;
    onTitleChange(summary.title);
  }, [onTitleChange, summary?.title, surface.titleSnapshot]);

  const targetStatus = target.data?.value.status;
  const targetLibraryId = target.data?.libraryId;
  useEffect(() => {
    if (targetStatus !== "deleted" || !targetLibraryId) return;
    void canvasDocumentSessionRegistry
      .retireOwner(
        {
          libraryId: targetLibraryId,
          routingContext: surface.config.routingContext,
        },
        surface.config.canvasBlockId,
      )
      .catch(() => undefined);
  }, [surface.config, targetLibraryId, targetStatus]);

  if (target.isPending) {
    return <CanvasDocumentState status="loading" label="Opening Canvas…" />;
  }
  if (target.isError) {
    return (
      <CanvasDocumentState
        status="error"
        message={
          target.error instanceof Error ? target.error.message : "Canvas could not be opened"
        }
        onRetry={() => void target.refetch()}
      />
    );
  }
  if (!summary) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-token-main-surface-primary px-6 text-center">
        <p className="text-sm text-token-text-secondary">
          {targetStatus === "deleted"
            ? "This Canvas has been deleted."
            : "This Canvas is no longer available."}
        </p>
        <button
          type="button"
          className="text-sm text-token-text-primary underline underline-offset-4"
          onClick={onClose}
        >
          Close tab
        </button>
      </div>
    );
  }

  return (
    <Suspense fallback={<CanvasDocumentState status="loading" label="Opening Canvas…" />}>
      <CanvasDocumentSurface
        routingContext={surface.config.routingContext}
        canvasBlockId={surface.config.canvasBlockId}
        surfaceKey={makeCanvasSceneSurfaceKey(windowSessionId, presentationOwnerId, surface.id)}
        viewportPreferenceScope={makeCanvasViewportPreferenceScope({
          variant: "stage",
          windowSessionId,
          projectSessionId: presentationOwnerId,
        })}
        variant="stage"
        active={isActivePanelTab}
        onOpenPage={
          onOpenPage
            ? ({ pageId, titleSnapshot }) => {
                onOpenPage({ pageId, titleSnapshot });
              }
            : undefined
        }
      />
    </Suspense>
  );
}
