import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createReactBlockSpec } from "@blocknote/react";
import {
  PageOutlinerBodySkeleton,
  PageOutlinerDisclosure,
  PageOutlinerFrame,
  PageOutlinerRowSlots,
  usePageOutlinerActivation,
  type PageOutlinerRowChromeProps,
  type PageOutlinerStateDependencies,
} from "@/components/block-documents/page-outliner-surface";
import { PortableRichTitle } from "@/components/block-documents/portable-rich-title";
import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { useSurfaceHistoryFocus } from "@/lib/surface-history/use-surface-history-focus";
import {
  pageOutlinerInlineStateLabel,
  pageOutlinerPlainTitle,
  resolvePageOutlinerTarget,
  type PageOutlinerRelationship,
  type PageOutlinerTarget,
} from "@/lib/page-outliner-target";
import {
  pageBlockConfig,
  pageRefBlockConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";
import { libraryContentAccess } from "../../../../shared/content-access-context";

import {
  moveFromEmbeddedSurfaceToHostNeighbor,
  registerEmbeddedSurfaceBoundaryHandle,
  selectEmbeddedSurfaceShell,
  type EmbeddedSurfaceHostEditor,
  type VerticalArrowDirection,
} from "./embedded-surface-arrow-navigation";
import type { PageOutlinerFocusIntent } from "./active-page-outliner-document";

const ActivePageOutlinerDocument = lazy(() =>
  import("./active-page-outliner-document").then((module) => ({
    default: module.ActivePageOutlinerDocument,
  })),
);

const projectedTitle = (target: PageOutlinerTarget): ReactNode => {
  if (target.status !== "available") return pageOutlinerPlainTitle(target);
  return (
    <PortableRichTitle value={target.page.richTitle} fallback={pageOutlinerPlainTitle(target)} />
  );
};

interface PageOutlinerBlockProps extends PageOutlinerStateDependencies {
  readonly relationship: PageOutlinerRelationship;
  readonly shellBlockId: string;
  readonly targetBlockId: string;
  readonly hostEditor?: EmbeddedSurfaceHostEditor;
}

export function PageOutlinerBlock({
  relationship,
  shellBlockId,
  targetBlockId,
  hostEditor,
  disclosureStore,
  activationBudget,
  visibilityOverride,
}: PageOutlinerBlockProps) {
  const host = useBlockReferenceHostRuntime();
  const contentAccessContext = host?.contentAccessContext ?? libraryContentAccess;
  const reference = usePageTargetReadModel(contentAccessContext, host ? targetBlockId.trim() : "");
  const target = resolvePageOutlinerTarget({
    relationship,
    targetBlockId,
    model: reference.data,
    loading: reference.loading,
    error: reference.error,
    contentAccessContext,
    hostPageId: host?.hostPageId ?? null,
    ancestorPageIds: host?.ancestorPageIds ?? [],
  });
  const expandable =
    host !== null && target.status === "available" && target.inlineMode === "editable";
  const activation = usePageOutlinerActivation({
    disclosureKey: shellBlockId,
    expandable,
    disclosureStore,
    activationBudget,
    visibilityOverride,
  });
  const { engageTitle, sectionRef: activationSectionRef } = activation;
  const nextFocusIntentId = useRef(0);
  const projectedPointerIntent = useRef<{
    readonly clientX: number;
    readonly clientY: number;
  } | null>(null);
  const historyFocusRef = useRef<HTMLElement | null>(null);
  useSurfaceHistoryFocus(historyFocusRef, host?.historyControls ?? null);
  const sectionRef = useCallback(
    (element: HTMLElement | null) => {
      historyFocusRef.current = element;
      activationSectionRef(element);
    },
    [activationSectionRef],
  );
  const [focusIntent, setFocusIntent] = useState<PageOutlinerFocusIntent | null>(null);
  const requestBoundaryFocus = useCallback(
    (direction: VerticalArrowDirection) => {
      if (!expandable) return false;
      nextFocusIntentId.current += 1;
      engageTitle();
      setFocusIntent({
        id: nextFocusIntentId.current,
        kind: "boundary",
        direction,
      });
      return true;
    },
    [engageTitle, expandable],
  );
  const requestPointerFocus = useCallback(
    (clientX: number, clientY: number) => {
      if (!expandable) return false;
      nextFocusIntentId.current += 1;
      engageTitle();
      setFocusIntent({
        id: nextFocusIntentId.current,
        kind: "pointer",
        clientX,
        clientY,
      });
      return true;
    },
    [engageTitle, expandable],
  );

  useEffect(() => {
    if (!hostEditor || !expandable) return;
    return registerEmbeddedSurfaceBoundaryHandle(hostEditor, shellBlockId, {
      focusBoundary: requestBoundaryFocus,
    });
  }, [expandable, hostEditor, requestBoundaryFocus, shellBlockId]);

  useEffect(() => {
    if (expandable) return;
    setFocusIntent(null);
  }, [expandable]);
  const plainTitle = pageOutlinerPlainTitle(target);
  const rowProps: PageOutlinerRowChromeProps = {
    plainTitle,
    stateLabel: pageOutlinerInlineStateLabel(target),
    expanded: activation.expanded,
    expandable,
    onExpandedChange: activation.setExpanded,
    ...(target.status === "available" && host?.openPage
      ? {
          onOpenPage: () =>
            host.openPage?.({
              accessContext: target.contentAccessContext,
              pageId: target.page.pageId,
              titleSnapshot: plainTitle,
            }),
        }
      : {}),
  };
  const handleProjectedPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    projectedPointerIntent.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
  };
  const editableProjectedTitle =
    target.status === "available" && expandable ? (
      <button
        type="button"
        data-page-outliner-title-trigger
        aria-label={`Edit ${plainTitle} title`}
        className="block w-full cursor-text text-left"
        onPointerDown={handleProjectedPointerDown}
        onClick={() => {
          const pointer = projectedPointerIntent.current;
          projectedPointerIntent.current = null;
          if (pointer) {
            requestPointerFocus(pointer.clientX, pointer.clientY);
            return;
          }
          requestBoundaryFocus("up");
        }}
      >
        {projectedTitle(target)}
      </button>
    ) : (
      projectedTitle(target)
    );

  return (
    <PageOutlinerFrame
      targetBlockId={target.targetBlockId}
      {...(target.status === "available" ? { accessKind: target.contentAccessContext.kind } : {})}
      expanded={activation.expanded}
      active={activation.active}
      sectionRef={sectionRef}
      onTouch={activation.touch}
    >
      <PageOutlinerDisclosure {...rowProps}>
        {target.status === "available" && activation.active && host ? (
          <Suspense
            fallback={
              <PageOutlinerRowSlots {...rowProps} title={projectedTitle(target)}>
                <PageOutlinerBodySkeleton />
              </PageOutlinerRowSlots>
            }
          >
            <ActivePageOutlinerDocument
              target={target}
              rowProps={rowProps}
              hostRuntime={host}
              focusIntent={focusIntent}
              onFocusIntentConsumed={(intentId) => {
                setFocusIntent((current) => (current?.id === intentId ? null : current));
              }}
              onTitleFocus={() => {
                activation.engageTitle();
                activation.touch();
              }}
              onTitleBlur={activation.releaseTitle}
              onMoveToHostBoundary={(direction) =>
                hostEditor
                  ? moveFromEmbeddedSurfaceToHostNeighbor(hostEditor, shellBlockId, direction)
                  : false
              }
              onEscapeToHostShell={() => {
                if (!hostEditor) return false;
                activation.releaseTitle();
                return selectEmbeddedSurfaceShell(hostEditor, shellBlockId);
              }}
            />
          </Suspense>
        ) : (
          <PageOutlinerRowSlots {...rowProps} title={editableProjectedTitle}>
            {activation.expanded && activation.visible && expandable ? (
              <PageOutlinerBodySkeleton />
            ) : null}
          </PageOutlinerRowSlots>
        )}
      </PageOutlinerDisclosure>
    </PageOutlinerFrame>
  );
}

export const createPageBlockSpec = createReactBlockSpec(pageBlockConfig, {
  render: ({ block, editor }) => (
    <PageOutlinerBlock
      relationship="child"
      shellBlockId={block.id}
      targetBlockId={block.id}
      hostEditor={editor as unknown as EmbeddedSurfaceHostEditor}
    />
  ),
});

export const createPageRefBlockSpec = createReactBlockSpec(pageRefBlockConfig, {
  render: ({ block, editor }) => (
    <PageOutlinerBlock
      relationship="reference"
      shellBlockId={block.id}
      targetBlockId={block.props.targetBlockId}
      hostEditor={editor as unknown as EmbeddedSurfaceHostEditor}
    />
  ),
});
