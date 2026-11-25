import { defineMessages, useIntl, type IntlShape } from "@/lib/i18n";
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
  resolvePageOutlinerTarget,
  type PageOutlinerRelationship,
  type PageOutlinerTarget,
} from "@/lib/page-outliner-target";
import {
  pageBlockConfig,
  pageRefBlockConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";
import { libraryContentRoute } from "../../../../shared/content-routing-context";
import { usePageStatusGlyph } from "../use-page-status-glyph";

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

const outlinerTitleMessages = defineMessages({
  available: { id: "lib.pageOutlinerTarget.untitled", defaultMessage: "Untitled" },
  loading: { id: "lib.pageOutlinerTarget.loading", defaultMessage: "Loading Page…" },
  error: { id: "lib.pageOutlinerTarget.unavailable", defaultMessage: "Page unavailable" },
  missing: { id: "lib.pageOutlinerTarget.unavailable", defaultMessage: "Page unavailable" },
  deleted: { id: "lib.pageOutlinerTarget.deleted", defaultMessage: "Deleted Page" },
  invalid_target: {
    id: "lib.pageOutlinerTarget.invalidMention",
    defaultMessage: "Invalid Page mention",
  },
  invalid_reference: {
    id: "lib.pageOutlinerTarget.invalidMention",
    defaultMessage: "Invalid Page mention",
  },
});

const outlinerStateMessages = defineMessages({
  loading: { id: "editor.pageOutlinerBlock.loading", defaultMessage: "Loading" },
  error: { id: "editor.pageOutlinerBlock.unavailable", defaultMessage: "Unavailable" },
  missing: { id: "editor.pageOutlinerBlock.missing", defaultMessage: "Missing" },
  deleted: { id: "editor.pageOutlinerBlock.deleted", defaultMessage: "Deleted" },
  invalid_reference: {
    id: "lib.pageOutlinerTarget.invalidReference",
    defaultMessage: "Invalid reference",
  },
  invalid_target: { id: "lib.pageOutlinerTarget.invalidTarget", defaultMessage: "Invalid target" },
  archived: { id: "editor.pageOutlinerBlock.archived", defaultMessage: "Archived" },
  self: { id: "editor.pageOutlinerBlock.self", defaultMessage: "Self" },
  cycle: { id: "editor.pageOutlinerBlock.cycle", defaultMessage: "Cycle" },
});

const formatOutlinerState = (intl: IntlShape, target: PageOutlinerTarget): string | null => {
  const state = target.status === "available" ? target.inlineMode : target.status;
  return state === "editable" ? null : intl.formatMessage(outlinerStateMessages[state]);
};

const projectedTitle = (target: PageOutlinerTarget, plainTitle: string): ReactNode => {
  if (target.status !== "available") return plainTitle;
  return <PortableRichTitle value={target.page.richTitle} fallback={plainTitle} />;
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
  const intl = useIntl();
  const host = useBlockReferenceHostRuntime();
  const contentRoutingContext = host?.contentRoutingContext ?? libraryContentRoute;
  const reference = usePageTargetReadModel(contentRoutingContext, host ? targetBlockId.trim() : "");
  const target = resolvePageOutlinerTarget({
    relationship,
    targetBlockId,
    model: reference.data,
    loading: reference.loading,
    error: reference.error,
    contentRoutingContext,
    hostPageId: host?.hostPageId ?? null,
    ancestorPageIds: host?.ancestorPageIds ?? [],
  });
  const expandable =
    host !== null && target.status === "available" && target.inlineMode === "editable";
  // A Subpage is a Page you open; an embed exists to show its Page's body here.
  const activation = usePageOutlinerActivation({
    disclosureKey: shellBlockId,
    expandable,
    defaultExpanded: relationship === "reference",
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

  if (!expandable && focusIntent !== null) setFocusIntent(null);
  const plainTitle =
    (target.status === "available" && target.page.title.trim()) ||
    intl.formatMessage(outlinerTitleMessages[target.status]);
  // Only an embedded Page can be a Database Page with a Status; a Subpage never is.
  const statusGlyph = usePageStatusGlyph(
    target.status === "available" ? target.contentRoutingContext : contentRoutingContext,
    relationship === "reference" && target.status === "available" ? target.page : null,
  );
  const rowProps: PageOutlinerRowChromeProps = {
    plainTitle,
    icon: statusGlyph,
    stateLabel: formatOutlinerState(intl, target),
    expanded: activation.expanded,
    expandable,
    onExpandedChange: activation.setExpanded,
    ...(target.status === "available" && host?.openPage
      ? {
          onOpenPage: () =>
            host.openPage?.({
              routingContext: target.contentRoutingContext,
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
        // With a link over the title, the link is the row's tab stop; renaming
        // stays reachable by arrowing into the title.
        tabIndex={host?.openPage ? -1 : undefined}
        aria-label={intl.formatMessage(
          { id: "editor.pageOutlinerBlock.editTitle", defaultMessage: "Edit {title} title" },
          { title: plainTitle },
        )}
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
        {projectedTitle(target, plainTitle)}
      </button>
    ) : (
      projectedTitle(target, plainTitle)
    );

  return (
    <PageOutlinerFrame
      targetBlockId={target.targetBlockId}
      {...(target.status === "available" ? { accessKind: target.contentRoutingContext.kind } : {})}
      expanded={activation.expanded}
      active={activation.active}
      sectionRef={sectionRef}
      onTouch={activation.touch}
    >
      <PageOutlinerDisclosure {...rowProps}>
        {target.status === "available" && activation.active && host ? (
          <Suspense
            fallback={
              <PageOutlinerRowSlots {...rowProps} title={projectedTitle(target, plainTitle)}>
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
