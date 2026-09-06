import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  BlockDocumentSurface,
  type BlockDocumentSurfaceValue,
} from "@/components/block-documents/block-document-surface";
import { BlockDocumentSyncStatus } from "@/components/block-documents/block-document-sync-status";
import {
  PageOutlinerBodySkeleton,
  PageOutlinerRowSlots,
  type PageOutlinerRowChromeProps,
} from "@/components/block-documents/page-outliner-surface";
import { CollaborativePageTitle } from "@/components/block-documents/collaborative-page-title";
import { OwnedBlockDocumentBoundary } from "@/components/block-documents/owned-block-document-boundary";
import { PortableRichTitle } from "@/components/block-documents/portable-rich-title";
import type { BlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { NodexButton } from "@/components/ui/button";
import type { AvailablePageOutlinerTarget } from "@/lib/page-outliner-target";
import {
  focusRichTitleDomAtPoint,
  focusRichTitleDomBoundary,
  isRichTitleDomSelectionAtVerticalBoundary,
} from "@/lib/rich-title-editor-dom";
import { useProjects } from "@/lib/use-projects";
import { resolveReferencedProjectContext } from "@/lib/referenced-project-context";
import { projectIdFromContentAccessContext } from "../../../../shared/content-access-context";
import type { VerticalArrowDirection } from "./embedded-surface-arrow-navigation";
import { NfmEditor, type NfmEditorBoundaryHandle } from "./nfm-editor";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";

export type PageOutlinerFocusIntent =
  | {
      readonly id: number;
      readonly kind: "boundary";
      readonly direction: VerticalArrowDirection;
    }
  | {
      readonly id: number;
      readonly kind: "pointer";
      readonly clientX: number;
      readonly clientY: number;
    };

export interface ActivePageOutlinerDocumentProps {
  readonly target: AvailablePageOutlinerTarget;
  readonly rowProps: PageOutlinerRowChromeProps;
  readonly hostRuntime: BlockReferenceHostRuntime;
  readonly focusIntent: PageOutlinerFocusIntent | null;
  readonly onFocusIntentConsumed: (intentId: number) => void;
  readonly onTitleFocus: () => void;
  readonly onTitleBlur: () => void;
  readonly onMoveToHostBoundary: (direction: VerticalArrowDirection) => boolean;
  readonly onEscapeToHostShell: () => boolean;
}

const stopNestedEditorEvent = (event: SyntheticEvent): void => {
  event.stopPropagation();
};

const nestedEditorEventProps = {
  onBeforeInput: stopNestedEditorEvent,
  onClick: stopNestedEditorEvent,
  onDoubleClick: stopNestedEditorEvent,
  onDragStart: stopNestedEditorEvent,
  onDrop: stopNestedEditorEvent,
  onInput: stopNestedEditorEvent,
  onKeyDown: stopNestedEditorEvent,
  onPaste: stopNestedEditorEvent,
  onPointerDown: stopNestedEditorEvent,
} as const;

function ProjectedRow({
  target,
  rowProps,
  children,
}: {
  readonly target: AvailablePageOutlinerTarget;
  readonly rowProps: PageOutlinerRowChromeProps;
  readonly children: ReactNode;
}) {
  return (
    <PageOutlinerRowSlots
      {...rowProps}
      title={
        <PortableRichTitle
          value={target.page.richTitle}
          fallback={target.page.title.trim() || target.fallbackTitle}
        />
      }
    >
      {children}
    </PageOutlinerRowSlots>
  );
}

function PageOutlinerFailure({
  target,
  rowProps,
  error,
  reloading,
  reload,
}: Pick<ActivePageOutlinerDocumentProps, "target" | "rowProps"> & {
  readonly error: { readonly message: string };
  readonly reloading: boolean;
  readonly reload?: () => Promise<void>;
}) {
  return (
    <ProjectedRow target={target} rowProps={rowProps}>
      <div role="alert" className="flex min-h-8 items-center gap-2 py-1 text-sm">
        <span className="min-w-0 flex-1 truncate text-token-error-foreground">
          {error.message || "Couldn’t open this collaborative content."}
        </span>
        {reload ? (
          <NodexButton
            type="button"
            size="xs"
            variant="secondary"
            disabled={reloading}
            onClick={() => void reload()}
          >
            {reloading ? "Retrying…" : "Retry"}
          </NodexButton>
        ) : null}
      </div>
    </ProjectedRow>
  );
}

function ActivePageOutlinerContent({
  target,
  rowProps,
  hostRuntime,
  targetProject,
  surface,
  focusIntent,
  onFocusIntentConsumed,
  onTitleFocus,
  onTitleBlur,
  onMoveToHostBoundary,
  onEscapeToHostShell,
}: ActivePageOutlinerDocumentProps & {
  readonly targetProject: ReturnType<typeof resolveReferencedProjectContext>;
  readonly surface: BlockDocumentSurfaceValue;
}) {
  const titleRef = useRef<HTMLDivElement | null>(null);
  const bodyNavigationRef = useRef<NfmEditorBoundaryHandle | null>(null);

  useLayoutEffect(() => {
    if (!focusIntent) return;

    if (focusIntent.kind === "boundary" && focusIntent.direction === "up" && rowProps.expanded) {
      if (!bodyNavigationRef.current?.focusBoundary("up")) return;
      onFocusIntentConsumed(focusIntent.id);
      return;
    }

    const title = titleRef.current;
    if (!title) return;
    if (focusIntent.kind === "pointer") {
      focusRichTitleDomAtPoint(title, focusIntent.clientX, focusIntent.clientY);
    } else {
      focusRichTitleDomBoundary(title, focusIntent.direction === "down" ? "start" : "end");
    }
    onFocusIntentConsumed(focusIntent.id);
  }, [focusIntent, onFocusIntentConsumed, rowProps.expanded]);

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    if (event.key === "Escape") {
      if (!onEscapeToHostShell()) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const direction = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    const title = titleRef.current;
    if (!title || !isRichTitleDomSelectionAtVerticalBoundary(title, direction)) {
      return;
    }

    const moved =
      direction === "down" && rowProps.expanded
        ? (bodyNavigationRef.current?.focusBoundary("down") ?? false)
        : onMoveToHostBoundary(direction);
    if (!moved) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <PageOutlinerRowSlots
      {...rowProps}
      metadata={
        <>
          {rowProps.metadata}
          <BlockDocumentSyncStatus runtime={surface.runtime} status={surface.status.provider} />
        </>
      }
      title={
        <div {...nestedEditorEventProps} data-embedded-surface-input="page-title">
          <CollaborativePageTitle
            ref={titleRef}
            title={surface.title}
            historyScope={surface.descriptor}
            className="px-0 py-0 text-[1em] leading-6 font-normal"
            aria-label={`Edit ${target.page.title.trim() || target.fallbackTitle} title`}
            onKeyDown={handleTitleKeyDown}
            onFocus={onTitleFocus}
            onBlur={onTitleBlur}
          />
        </div>
      }
    >
      {rowProps.expanded ? (
        <div
          {...nestedEditorEventProps}
          data-embedded-page-document={target.page.pageId}
          className="w-full min-w-0"
        >
          <NfmEditor
            contentAccessContext={hostRuntime.contentAccessContext}
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
            sourcePageContext={{
              pageId: target.page.pageId,
            }}
            documentOwnerBlockId={target.page.pageId}
            surfaceMutationBarrier={surface.runtime}
            onOpenPage={hostRuntime.openPage}
            onOpenCanvas={hostRuntime.openCanvas}
            isActivePanelTab={hostRuntime.isActiveSurface}
            placeholder={PAGE_DESCRIPTION_PLACEHOLDER}
            className="min-h-0! min-w-0"
            embeddedBoundary={{
              navigationRef: bodyNavigationRef,
              onBoundaryArrow: (direction) => {
                if (direction === "down") {
                  return onMoveToHostBoundary("down");
                }
                const title = titleRef.current;
                if (!title) return false;
                focusRichTitleDomBoundary(title, "end");
                return true;
              },
            }}
          />
        </div>
      ) : null}
    </PageOutlinerRowSlots>
  );
}

/** One target Y.Doc supplies the active title and the disclosed body editor. */
export function ActivePageOutlinerDocument({
  target,
  rowProps,
  hostRuntime,
  focusIntent,
  onFocusIntentConsumed,
  onTitleFocus,
  onTitleBlur,
  onMoveToHostBoundary,
  onEscapeToHostShell,
}: ActivePageOutlinerDocumentProps) {
  const { projects } = useProjects();
  const executionProjectId = projectIdFromContentAccessContext(target.contentAccessContext);
  const targetProject = resolveReferencedProjectContext(executionProjectId ?? "", projects);
  const pending = (
    <ProjectedRow target={target} rowProps={rowProps}>
      <PageOutlinerBodySkeleton />
    </ProjectedRow>
  );

  return (
    <OwnedBlockDocumentBoundary
      accessContext={target.contentAccessContext}
      ownerBlockId={target.page.pageId}
    >
      {(model, controls) => {
        if (model.status === "loading") return pending;
        if (model.status === "error") {
          return (
            <PageOutlinerFailure
              target={target}
              rowProps={rowProps}
              error={model.error}
              reloading={false}
              reload={controls.reload}
            />
          );
        }
        return (
          <BlockDocumentSurface
            descriptor={model.descriptor}
            pageTitleIdentity={{
              libraryId: target.page.libraryId,
              pageId: target.page.pageId,
            }}
            isActive={hostRuntime.isActiveSurface}
            onReload={controls.reload}
            pendingFallback={pending}
            renderFailureFallback={({ error, reloading, reload }) => (
              <PageOutlinerFailure
                target={target}
                rowProps={rowProps}
                error={error}
                reloading={reloading}
                reload={reload}
              />
            )}
            localAwarenessState={{
              user: { name: "You", color: "#3b82f6" },
              nodex: { embedded: true },
            }}
          >
            {(surface) => (
              <ActivePageOutlinerContent
                target={target}
                rowProps={rowProps}
                hostRuntime={hostRuntime}
                targetProject={targetProject}
                surface={surface}
                focusIntent={focusIntent}
                onFocusIntentConsumed={onFocusIntentConsumed}
                onTitleFocus={onTitleFocus}
                onTitleBlur={onTitleBlur}
                onMoveToHostBoundary={onMoveToHostBoundary}
                onEscapeToHostShell={onEscapeToHostShell}
              />
            )}
          </BlockDocumentSurface>
        );
      }}
    </OwnedBlockDocumentBoundary>
  );
}
