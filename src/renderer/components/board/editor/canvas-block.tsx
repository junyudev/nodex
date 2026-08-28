import { CanvasIcon, EditIcon, OpenInIcon } from "@/components/shared/icons";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { NodexTooltip } from "@/components/ui/tooltip";

import { CanvasDocumentState } from "@/components/board/canvas-document-state";
import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { makeCanvasSceneSurfaceKey } from "@/lib/canvas-scene-surface-runtime";
import { canvasDocumentSessionRegistry } from "@/lib/canvas-document-session";
import { makeCanvasViewportPreferenceScope } from "@/lib/canvas-presentation-preference";
import {
  ReferenceSurfaceActivationBudget,
  ReferenceSurfaceActivationPriority,
  useReferenceSurfaceActivation,
} from "@/lib/reference-surface-state";
import { useElementVisibility } from "@/lib/use-element-visibility";
import { useCanvasInlineFrameHeight } from "@/lib/use-canvas-inline-frame-height";
import { useLibraryCanvasTarget } from "@/lib/use-library-navigation";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { canvasBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { toast } from "@/components/ui/toast";
import {
  selectEmbeddedSurfaceShell,
  type EmbeddedSurfaceHostEditor,
} from "./embedded-surface-arrow-navigation";

const CanvasDocumentSurface = lazy(async () => {
  const module = await import("@/components/canvas/canvas-document-surface");
  return { default: module.CanvasDocumentSurface };
});

export const canvasInlineSurfaceActivationBudget = new ReferenceSurfaceActivationBudget(2);

export interface CanvasBlockFrameProps {
  readonly canvasBlockId: string;
  readonly title: string;
  readonly active: boolean;
  readonly expanded?: boolean;
  readonly loading?: boolean;
  readonly heightPreferenceStoreEpoch?: string | null;
  readonly containerRef?: RefCallback<HTMLElement>;
  readonly onActivate?: () => void;
  readonly onDeactivate?: () => void;
  readonly onEscape?: () => boolean;
  readonly onOpen?: () => void;
  readonly onRename?: (title: string) => void | Promise<void>;
  readonly children: ReactNode;
}

export function CanvasBlockFrame({
  canvasBlockId,
  title,
  active,
  expanded = active,
  loading = false,
  heightPreferenceStoreEpoch = null,
  containerRef,
  onActivate,
  onDeactivate,
  onEscape,
  onOpen,
  onRename,
  children,
}: CanvasBlockFrameProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const viewportRef = useCanvasInlineFrameHeight({
    canvasBlockId,
    storeEpoch: heightPreferenceStoreEpoch,
    expanded,
  });

  useEffect(() => {
    if (renaming) return;
    setDraftTitle(title);
  }, [renaming, title]);

  const commitRename = useCallback(() => {
    const nextTitle = draftTitle.trim() || "Untitled Canvas";
    setRenaming(false);
    if (!onRename || nextTitle === title) return;
    void onRename(nextTitle);
  }, [draftTitle, onRename, title]);

  return (
    <section
      ref={containerRef}
      contentEditable={false}
      {...embeddedEditorSelectionContextAttributes}
      data-canvas-block={canvasBlockId}
      data-canvas-block-active={active ? "true" : "false"}
      className="group/canvas my-2 w-full min-w-0 overflow-hidden rounded-lg border border-token-border-default bg-token-main-surface-primary focus-within:border-token-border-xstrong focus-within:ring-1 focus-within:ring-token-border-xstrong"
      onFocusCapture={onActivate}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onDeactivate?.();
      }}
      onPointerDownCapture={onActivate}
      onPointerUpCapture={(event) => {
        if (event.currentTarget.contains(document.activeElement)) return;
        onDeactivate?.();
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !onEscape?.()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-token-border-default px-2.5">
        <CanvasIcon className="icon-2xs shrink-0 text-token-description-foreground" />
        {renaming ? (
          <input
            autoFocus
            aria-label="Canvas name"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-token-text-primary outline-none"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraftTitle(title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-token-text-primary">
            {title}
          </span>
        )}
        {loading ? (
          <span className="text-xs text-token-description-foreground">Loading…</span>
        ) : null}
        {onRename ? (
          <NodexTooltip tooltipContent="Rename Canvas" side="top">
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-token-description-foreground opacity-0 hover:bg-token-foreground/8 hover:text-token-text-primary focus-visible:opacity-100 group-hover/canvas:opacity-100"
              aria-label={`Rename ${title}`}
              onClick={() => setRenaming(true)}
            >
              <EditIcon className="size-3.5" aria-hidden="true" />
            </button>
          </NodexTooltip>
        ) : null}
        {onOpen ? (
          <NodexTooltip tooltipContent="Open Canvas in tab" side="top">
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-token-description-foreground opacity-0 hover:bg-token-foreground/8 hover:text-token-text-primary focus-visible:opacity-100 group-hover/canvas:opacity-100"
              aria-label={`Open ${title}`}
              onClick={onOpen}
            >
              <OpenInIcon className="size-3.5" aria-hidden="true" />
            </button>
          </NodexTooltip>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        data-canvas-inline-frame=""
        className={
          expanded
            ? "max-h-[1600px] min-h-56 w-full min-w-0 resize-y overflow-hidden"
            : "h-24 w-full min-w-0 overflow-hidden"
        }
      >
        {children}
      </div>
    </section>
  );
}

export function CanvasBlock({
  canvasBlockId,
  hostEditor,
}: {
  readonly canvasBlockId: string;
  readonly hostEditor?: EmbeddedSurfaceHostEditor;
}) {
  const host = useBlockReferenceHostRuntime();
  const visibility = useElementVisibility();
  const [engaged, setEngaged] = useState(false);
  const instanceId = useId();
  const activationKey = [
    "canvas-inline",
    host?.documentSurfaceId ?? "detached",
    canvasBlockId,
    instanceId,
  ].join(":");
  const target = useLibraryCanvasTarget(canvasBlockId, host !== null);
  const summary = target.data?.value.status === "available" ? target.data.value.summary : null;
  const canAutoAdmit = Boolean(host?.isActiveSurface && summary && visibility.visible);
  const eligible = Boolean(host?.isActiveSurface && summary && (visibility.visible || engaged));
  const active = useReferenceSurfaceActivation(
    activationKey,
    eligible,
    canvasInlineSurfaceActivationBudget,
    engaged
      ? ReferenceSurfaceActivationPriority.editing
      : ReferenceSurfaceActivationPriority.visibility,
    {
      visibility: (visibility.intersecting ?? visibility.visible) ? "visible" : "prewarm",
      viewportCenterDistance: visibility.viewportCenterDistance ?? Number.POSITIVE_INFINITY,
      documentOrder: visibility.documentOrder ?? Number.POSITIVE_INFINITY,
    },
  );
  const touch = useCallback(() => {
    canvasInlineSurfaceActivationBudget.touch(activationKey);
  }, [activationKey]);
  const activate = useCallback(() => {
    if (!host?.isActiveSurface || !summary) return;
    setEngaged(true);
    touch();
  }, [host?.isActiveSurface, summary, touch]);
  const deactivate = useCallback(() => setEngaged(false), []);
  const open = useCallback(() => {
    if (!host?.openCanvas || !summary) return;
    void host.openCanvas({
      accessContext: host.contentAccessContext,
      canvasBlockId,
      titleSnapshot: summary.title,
    });
  }, [canvasBlockId, host, summary]);
  const title = summary?.title.trim() || "Canvas";
  const rename = useCallback(
    async (nextTitle: string) => {
      if (!host?.renameCanvas || !summary) return;
      try {
        await host.renameCanvas({
          canvasBlockId,
          displayName: nextTitle,
        });
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Could not rename Canvas");
      }
    },
    [canvasBlockId, host, summary],
  );
  const selectHostShell = useCallback(() => {
    if (!hostEditor) return false;
    return selectEmbeddedSurfaceShell(hostEditor, canvasBlockId);
  }, [canvasBlockId, hostEditor]);
  const disengageAndSelectHostShell = useCallback(() => {
    setEngaged(false);
    return selectHostShell();
  }, [selectHostShell]);
  const targetStatus = target.data?.value.status;
  const targetLibraryId = target.data?.libraryId;
  useEffect(() => {
    if (targetStatus !== "deleted" || !targetLibraryId || !host) return;
    void canvasDocumentSessionRegistry
      .retireOwner(
        {
          libraryId: targetLibraryId,
          accessContext: host.contentAccessContext,
        },
        canvasBlockId,
      )
      .catch(() => undefined);
  }, [canvasBlockId, host, targetLibraryId, targetStatus]);
  const surfaceKey = host
    ? makeCanvasSceneSurfaceKey(
        "inline",
        host.documentSurfaceId ?? "detached",
        `${host.hostPageId ?? "detached"}:${canvasBlockId}`,
      )
    : null;

  return (
    <CanvasBlockFrame
      canvasBlockId={canvasBlockId}
      title={title}
      active={active}
      expanded={active}
      loading={target.isPending}
      heightPreferenceStoreEpoch={target.data?.storeEpoch ?? null}
      containerRef={visibility.ref}
      onActivate={activate}
      onDeactivate={deactivate}
      onEscape={disengageAndSelectHostShell}
      onOpen={host?.openCanvas && summary ? open : undefined}
      onRename={host?.renameCanvas && summary ? rename : undefined}
    >
      {target.isError ? (
        <CanvasDocumentState
          status="error"
          message={
            target.error instanceof Error ? target.error.message : "Canvas could not be opened"
          }
          onRetry={() => void target.refetch()}
        />
      ) : targetStatus === "deleted" || targetStatus === "missing" ? (
        <div className="flex h-full items-center justify-center px-4 text-sm text-token-text-secondary">
          {targetStatus === "deleted"
            ? "This Canvas has been deleted."
            : "This Canvas is no longer available."}
        </div>
      ) : active && host && surfaceKey && summary ? (
        <Suspense fallback={<CanvasDocumentState status="loading" label="Opening Canvas…" />}>
          <CanvasDocumentSurface
            accessContext={host.contentAccessContext}
            canvasBlockId={canvasBlockId}
            surfaceKey={surfaceKey}
            viewportPreferenceScope={makeCanvasViewportPreferenceScope({
              variant: "inline",
              canvasBlockId,
            })}
            variant="inline"
            active={host.isActiveSurface}
          />
        </Suspense>
      ) : (
        <div
          data-canvas-admission={canAutoAdmit ? "queued" : "dormant"}
          className="flex h-full w-full items-center justify-center bg-token-foreground/2 px-4 text-sm text-token-text-secondary"
        >
          {target.isPending
            ? "Opening Canvas…"
            : summary
              ? canAutoAdmit
                ? "Canvas is ready when an editor slot becomes available."
                : "Canvas is outside the active viewport."
              : "Canvas unavailable"}
        </div>
      )}
    </CanvasBlockFrame>
  );
}

export const createCanvasBlockSpec = createReactBlockSpec(canvasBlockConfig, {
  render: ({ block, editor }) => (
    <CanvasBlock
      canvasBlockId={block.id}
      hostEditor={editor as unknown as EmbeddedSurfaceHostEditor}
    />
  ),
  meta: {
    isolating: true,
    selectable: true,
  },
});
