import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { BoardPageKey } from "@/components/board/board-page-key";
import { PagePresenceRail } from "@/components/board/page-presence-rail";
import { NodexTooltip } from "@/components/ui/tooltip";
import { DataSourcePropertyValueEditor } from "@/components/database/data-source-property-value-editor";
import type {
  DataSourcePropertyEditorBinding,
  DataSourcePropertyOptionRegistryState,
} from "@/components/database/data-source-property-editor-binding";
import type { DataSourcePagePropertyMenuSource } from "@/components/database/data-source-page-property-menu-source";
import { PropertyEditorFeedback } from "@/components/database/property-editor-feedback";
import { readDatabasePropertyOptions } from "@/lib/database-view-authoring";
import {
  databaseViewConditionalColorBackground,
  type DatabaseViewRenderModel,
  type DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import {
  readDataSourceRelationTargetDescriptor,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import type { RelationTargetWindow } from "@/lib/data-source-relation-value";
import { cn } from "@/lib/utils";
import { canMoveDatabaseViewPage } from "@/lib/database-view-row-mutations";
import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabaseViewField,
} from "../../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import type { DatabaseViewPageMenuSession } from "../database-view-page-context-menu";
import type { DatabaseViewPageActionPort } from "../database-view-page-actions";
import type { DatabaseViewPageOpenHandler } from "../database-view-page-open";
import type { BoardCardDragData } from "@/components/board/pragmatic-drag-data";
import { useDatabaseViewPageDragSource } from "../database-view-page-drag";
import { PageChatActivityControl } from "../page-chat-activity-control";
import type { PageChatActivitySummary } from "@/lib/types";
import {
  formatDatabaseBoardMetadataTimestamp,
  projectDatabaseBoardCardFooter,
} from "./database-board-model";

const DATABASE_BOARD_CARD_INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role=button]",
  "[role=checkbox]",
  "[role=combobox]",
  "[role=listbox]",
  "[role=menu]",
  "[role=menuitem]",
  "[role=option]",
  "[contenteditable=true]",
  "[data-database-view-property-id]",
].join(",");

export interface DatabaseBoardCardProps {
  readonly model: DatabaseViewRenderModel;
  readonly row: DatabaseViewRenderRow;
  readonly trailingFields: readonly DatabaseViewField[];
  readonly groupPropertyId: string | null;
  readonly subgroupPropertyId: string | null;
  readonly showPageKey: boolean;
  readonly showDescription: boolean;
  readonly pendingMutationKeys: ReadonlyMap<string, number>;
  readonly mutationErrors: ReadonlyMap<string, string>;
  readonly onOpenPage: DatabaseViewPageOpenHandler;
  readonly pageActionPort?: DatabaseViewPageActionPort;
  readonly pageChatActivity?: PageChatActivitySummary;
  readonly onRemovePageChatRelation?: (sessionId: string) => Promise<void> | void;
  readonly onSetValue: (pageId: string, propertyId: string, value: DatabaseJsonValue) => void;
  readonly onSetStructuralValue: (
    pageId: string,
    propertyId: string,
    value: DatabaseJsonValue,
  ) => void;
  readonly onPatchRelation: (
    pageId: string,
    propertyId: string,
    delta: { readonly addPageIds: readonly string[]; readonly removeEdgeIds: readonly string[] },
  ) => void;
  readonly onReplaceOneRelation: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    targetPageId: string | null,
  ) => void;
  readonly onPatchOptions: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    delta: {
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    },
  ) => void;
  readonly onCreateOption: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    option: { readonly optionId: string; readonly name: string; readonly color?: string },
  ) => Promise<void>;
  readonly onLoadRelationTargets: (
    pageId: string,
    propertyId: string,
    after: string | null,
  ) => Promise<RelationTargetWindow>;
  readonly onSearchRelationCandidates: (
    property: DataSourcePropertyRecordV2,
    query: string,
    after?: string | null,
  ) => ReturnType<typeof searchDataSourceRelationCandidates>;
  readonly onLoadRelationTargetDescriptor: (
    property: DataSourcePropertyRecordV2,
  ) => ReturnType<typeof readDataSourceRelationTargetDescriptor>;
  readonly onRelationValueStale: () => void;
  readonly onRequestOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly onRequestMoreOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly optionRegistryStates: Readonly<Record<string, DataSourcePropertyOptionRegistryState>>;
  readonly optionRegistryHasMore: Readonly<Record<string, boolean>>;
  readonly optionRegistryLoadingMore: Readonly<Record<string, boolean>>;
  readonly onMove: (pageId: string, direction: "up" | "down" | "top" | "bottom") => void;
  readonly highlighted: boolean;
  readonly presented: boolean;
  readonly selected: boolean;
  readonly onHighlight: (pageId: string) => void;
  readonly onToggleSelection: (pageId: string) => void;
  readonly draggable: boolean;
  readonly pragmaticDragData: BoardCardDragData | null;
  readonly dragging: boolean;
  readonly onDragStartPage: (
    row: DatabaseViewRenderRow,
    event: ReactDragEvent<HTMLElement>,
  ) => void;
  readonly onDragEndPage: () => void;
}

const createDatabaseBoardPropertyEditorBinding = (
  props: DatabaseBoardCardProps,
  authority: DatabaseViewRenderModel["query"]["rows"][number],
  property: DataSourcePropertyRecordV2,
): DataSourcePropertyEditorBinding => {
  const current = authority.values[property.propertyId];
  const structural =
    property.propertyId === props.groupPropertyId ||
    property.propertyId === props.subgroupPropertyId;
  return {
    property,
    value: current?.value,
    revision: current?.revision ?? 0,
    disabled: props.model.readOnlyReason !== null,
    pending:
      props.pendingMutationKeys.has(`value:${props.row.pageId}:${property.propertyId}`) ||
      props.pendingMutationKeys.has(`property:${property.propertyId}`),
    error: props.mutationErrors.get(`value:${props.row.pageId}:${property.propertyId}`),
    options: props.optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property),
    optionRegistryState: props.optionRegistryStates[property.propertyId] ?? "ready",
    optionRegistryHasMore: props.optionRegistryHasMore[property.propertyId] ?? false,
    optionRegistryLoadingMore: props.optionRegistryLoadingMore[property.propertyId] ?? false,
    onRequestOptions: () => props.onRequestOptions(property),
    onRequestMoreOptions: () => props.onRequestMoreOptions(property),
    relationCandidates:
      property.valueType === "relation"
        ? props.model.query.rows.map((candidate) => ({
            pageId: candidate.page.pageId,
            title: candidate.page.title,
          }))
        : undefined,
    relationSourcePageId: props.row.pageId,
    onChange: (value) =>
      structural
        ? props.onSetStructuralValue(props.row.pageId, property.propertyId, value)
        : props.onSetValue(props.row.pageId, property.propertyId, value),
    onCreateOption: (option) => props.onCreateOption(props.row.pageId, property, option),
    onPatchOptions: (delta) => {
      if (!structural) {
        props.onPatchOptions(props.row.pageId, property, delta);
        return;
      }
      const selectedIds = Array.isArray(current?.value)
        ? current.value.filter((entry): entry is string => typeof entry === "string")
        : [];
      const next = new Set(selectedIds);
      for (const optionId of delta.removeOptionIds) next.delete(optionId);
      for (const optionId of delta.addOptionIds) next.add(optionId);
      props.onSetStructuralValue(props.row.pageId, property.propertyId, [...next]);
    },
    onPatchRelation: (delta) => props.onPatchRelation(props.row.pageId, property.propertyId, delta),
    onReplaceOneRelation: (targetPageId) =>
      props.onReplaceOneRelation(props.row.pageId, property, targetPageId),
    onLoadRelationTargets: (after) =>
      props.onLoadRelationTargets(props.row.pageId, property.propertyId, after),
    onSearchRelationCandidates: (query, after) =>
      props.onSearchRelationCandidates(property, query, after),
    onLoadRelationTargetDescriptor: () => props.onLoadRelationTargetDescriptor(property),
    onOpenRelationPage: (pageId, title) => props.onOpenPage(pageId, title, "preview"),
    onRelationValueStale: props.onRelationValueStale,
  };
};

export const createDatabaseBoardPageMenuSession = (
  props: DatabaseBoardCardProps,
  { groupComplete }: { readonly groupComplete: boolean },
): DatabaseViewPageMenuSession | null => {
  const authority = props.model.query.rows.find(
    (candidate) => candidate.page.pageId === props.row.pageId,
  );
  if (!authority) return null;
  const canMoveUp = canMoveDatabaseViewPage({
    model: props.model,
    pageId: props.row.pageId,
    direction: "up",
    groupComplete,
  });
  const canMoveDown = canMoveDatabaseViewPage({
    model: props.model,
    pageId: props.row.pageId,
    direction: "down",
    groupComplete,
  });
  const activeProperties = props.model.query.properties.filter(
    (property) => property.lifecycle === "active",
  );
  const propertySource: DataSourcePagePropertyMenuSource = {
    descriptors: activeProperties.map((property) => ({
      property,
      disabled: props.model.readOnlyReason !== null,
      pending:
        props.pendingMutationKeys.has(`value:${props.row.pageId}:${property.propertyId}`) ||
        props.pendingMutationKeys.has(`property:${property.propertyId}`),
    })),
    resolveBinding(propertyId) {
      const property = activeProperties.find((candidate) => candidate.propertyId === propertyId);
      if (!property) throw new Error(`Unknown Board Property: ${propertyId}`);
      return createDatabaseBoardPropertyEditorBinding(props, authority, property);
    },
  };
  return {
    page: {
      libraryId: props.model.libraryId,
      accessContext: props.model.accessContext,
      projectId:
        props.model.accessContext.kind === "project" ? props.model.accessContext.projectId : null,
      pageId: props.row.pageId,
      pageKey: props.row.pageKey,
      titleSnapshot: props.row.title,
    },
    canMoveUp,
    canMoveDown,
    propertySource,
    groupingPropertyId: props.groupPropertyId,
    actionPort: props.pageActionPort,
    deleteDisabled: props.model.readOnlyReason !== null,
    onReorder: (direction) => props.onMove(props.row.pageId, direction),
  };
};

/** The one Card composition used by every legal Board grouping. */
export function DatabaseBoardCard(props: DatabaseBoardCardProps) {
  const {
    model,
    row,
    trailingFields,
    groupPropertyId,
    subgroupPropertyId,
    showPageKey,
    showDescription,
    mutationErrors,
    onOpenPage,
    highlighted,
    presented,
    selected,
    onHighlight,
    onToggleSelection,
    draggable,
    pragmaticDragData,
    dragging,
    onDragStartPage,
    onDragEndPage,
  } = props;
  const { setElementRef: cardElementRef, previewPortal } = useDatabaseViewPageDragSource(
    draggable ? pragmaticDragData : null,
    { nativePreview: "portal" },
  );
  const title = usePresentedPageTitle(row.pageId, row.title, model.libraryId, {
    generation: row.documentGeneration,
    headSeq: row.documentHeadSeq,
  });
  const authority = model.query.rows.find((candidate) => candidate.page.pageId === row.pageId);
  if (!authority) return null;
  const description = row.preview.trim();
  const footerSlots = projectDatabaseBoardCardFooter({
    authority,
    displayedFields: trailingFields,
    properties: model.query.properties,
    groupPropertyId,
    subgroupPropertyId,
  });
  const propertySlots = footerSlots.filter((slot) => slot.kind === "property");
  const metadataSlots = footerSlots.filter((slot) => slot.kind === "metadata");
  const propertyBinding = (property: DataSourcePropertyRecordV2) =>
    createDatabaseBoardPropertyEditorBinding(props, authority, property);
  const ringShadow = selected
    ? "0 0 0 1.5px color-mix(in srgb, var(--accent-blue) 72%, transparent)"
    : highlighted
      ? "0 0 0 1.5px color-mix(in srgb, var(--accent-blue) 50%, transparent)"
      : "0 0 0 1px color-mix(in srgb, var(--column-accent, var(--foreground-tertiary)) 17%, transparent)";
  const elevationShadow = dragging
    ? "0 8px 16px color-mix(in srgb, var(--foreground) 12%, transparent)"
    : "0 4px 12px color-mix(in srgb, var(--foreground) 5%, transparent), 0 1px 2px color-mix(in srgb, var(--foreground) 4%, transparent)";
  const previewShadow = document.documentElement.classList.contains("dark")
    ? "0 4px 12px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.1), 0 0 0 1px color-mix(in srgb, var(--column-accent, rgba(255,255,255,0.07)) 20%, transparent)"
    : "0 4px 12px rgba(25,25,25,0.027), 0 1px 2px rgba(25,25,25,0.02), 0 0 0 1px color-mix(in srgb, var(--column-accent, rgba(42,28,0,0.07)) 15%, transparent)";
  const cardSurfaceStyle = {
    "--database-board-card-surface": row.conditionalColor
      ? databaseViewConditionalColorBackground(row.conditionalColor)
      : "var(--card)",
  } as CSSProperties;
  const handleCardClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    if (
      typeof Node === "undefined" ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    )
      return;
    if (
      typeof Element !== "undefined" &&
      event.target instanceof Element &&
      event.target.closest(DATABASE_BOARD_CARD_INTERACTIVE_SELECTOR)
    )
      return;
    if (event.shiftKey) {
      event.preventDefault();
      onToggleSelection(row.pageId);
      return;
    }
    onOpenPage(row.pageId, title, "preview");
  };
  const handleCardDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.shiftKey) return;
    if (
      typeof Node === "undefined" ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    )
      return;
    if (
      typeof Element !== "undefined" &&
      event.target instanceof Element &&
      event.target.closest(DATABASE_BOARD_CARD_INTERACTIVE_SELECTOR) &&
      !event.target.closest("[data-database-view-page-open]")
    )
      return;
    onOpenPage(row.pageId, title, "durable");
  };
  const renderCard = (previewRect: DOMRect | null) => (
    <article
      ref={previewRect ? undefined : cardElementRef}
      data-database-view-page-id={row.pageId}
      data-database-view-page-menu-target={previewRect ? undefined : row.pageId}
      data-database-board-card="true"
      data-card-context-menu-trigger={previewRect ? undefined : "true"}
      data-board-uuid-v7={row.pageId}
      data-database-view-page-presented={!previewRect && presented ? "true" : undefined}
      tabIndex={previewRect ? -1 : highlighted ? 0 : -1}
      aria-hidden={previewRect ? true : undefined}
      aria-selected={previewRect ? undefined : selected}
      inert={previewRect ? true : undefined}
      draggable={previewRect ? false : draggable}
      aria-label={!previewRect && draggable ? `Drag ${title}` : undefined}
      onPointerDown={previewRect ? undefined : () => onHighlight(row.pageId)}
      onFocus={previewRect ? undefined : () => onHighlight(row.pageId)}
      onClick={previewRect ? undefined : handleCardClick}
      onDoubleClick={previewRect ? undefined : handleCardDoubleClick}
      onDragStart={!previewRect && draggable ? (event) => onDragStartPage(row, event) : undefined}
      onDragEnd={!previewRect && draggable ? onDragEndPage : undefined}
      className={cn(
        "bn-drag-exclude group/card relative min-h-10 min-w-0 cursor-pointer overflow-hidden rounded-lg bg-[var(--database-board-card-surface)] outline-none select-none",
        "hover:bg-[color-mix(in_srgb,var(--column-accent,var(--foreground-tertiary))_8%,var(--database-board-card-surface))]",
        !previewRect &&
          selected &&
          "bg-[color-mix(in_srgb,var(--accent-blue)_6%,var(--database-board-card-surface))]",
        !previewRect && dragging && "opacity-45",
      )}
      style={
        previewRect
          ? {
              ...cardSurfaceStyle,
              boxShadow: previewShadow,
              minHeight: previewRect.height,
              pointerEvents: "none",
              width: previewRect.width,
            }
          : { ...cardSurfaceStyle, boxShadow: `${elevationShadow}, ${ringShadow}` }
      }
    >
      {!previewRect && presented ? <PagePresenceRail /> : null}
      <BoardPageKey pageKey={row.pageKey} showPageKey={showPageKey} className="mx-2 mb-0.5 pt-2" />
      <div
        className={cn(
          "flex min-h-7 min-w-0 items-start gap-1 px-2 pb-1",
          showPageKey && row.pageKey ? "pt-0" : "pt-2",
        )}
      >
        <button
          type="button"
          data-database-view-page-open="true"
          data-card-context-menu-trigger="true"
          aria-label={`Open Page ${showPageKey && row.pageKey ? `${row.pageKey} ` : ""}${title}`}
          className="min-w-0 flex-1 text-left text-base/normal font-medium wrap-break-word text-(--foreground) outline-none"
          onClick={() => onOpenPage(row.pageId, title, "preview")}
        >
          <span>{title}</span>
        </button>
        {!previewRect &&
        props.pageChatActivity &&
        props.pageActionPort?.openRelatedChat &&
        model.accessContext.kind === "project" ? (
          <PageChatActivityControl
            pageAccessProjectId={model.accessContext.projectId}
            pageId={row.pageId}
            summary={props.pageChatActivity}
            onOpenChat={props.pageActionPort.openRelatedChat}
            onRemoveRelation={props.onRemovePageChatRelation}
            idleVisibilityClassName="group-hover/card:opacity-100 group-focus-within/card:opacity-100"
          />
        ) : null}
      </div>
      {showDescription && description ? (
        <p
          data-board-page-description="true"
          className="line-clamp-2 px-2 pb-1 text-xs/normal wrap-break-word text-(--foreground-secondary)"
        >
          {description}
        </p>
      ) : null}
      {footerSlots.length > 0 ? (
        <div
          className={cn(
            "mx-2 min-w-0 pb-2",
            "[--database-property-chip-border:var(--color-token-border)]",
            "[--database-property-chip-background:var(--card)]",
            "[--database-property-chip-hover-background:color-mix(in_srgb,var(--color-token-foreground)_5%,var(--card))]",
            "[--database-property-chip-hover-border:var(--color-token-border-heavy)]",
            "[--database-property-chip-hover-text:var(--color-token-text-primary)]",
            "[--database-property-chip-surface:var(--card)]",
            "[--database-property-icon-muted:var(--color-token-description-foreground)]",
            "[--database-property-chip-text:var(--color-token-text-secondary)]",
            "[--database-property-chip-focus:var(--color-token-focus-border)]",
          )}
        >
          {propertySlots.length > 0 ? (
            <div
              data-database-board-property-row="true"
              className="flex min-w-0 flex-wrap items-center gap-1"
            >
              {propertySlots.map((slot) => {
                const binding = propertyBinding(slot.property);
                return (
                  <div
                    key={slot.property.propertyId}
                    data-database-view-property-id={slot.property.propertyId}
                    className="min-w-0 max-w-full shrink-0"
                  >
                    <DataSourcePropertyValueEditor
                      {...binding}
                      showLabel={false}
                      presentation="board"
                    />
                    {binding.error ? <PropertyEditorFeedback message={binding.error} /> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {metadataSlots.length > 0 ? (
            <div
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1",
                propertySlots.length > 0 && "mt-1",
              )}
              data-database-board-metadata-row="true"
            >
              {metadataSlots.map((slot) => (
                <NodexTooltip
                  key={`intrinsic:${slot.field}`}
                  tooltipContent={new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(slot.value))}
                >
                  <span
                    data-database-board-metadata={slot.field}
                    className="inline-flex h-6 min-h-6 items-center px-0.5 text-xs/4 [font-weight:450] text-(--color-token-text-secondary)"
                  >
                    {formatDatabaseBoardMetadataTimestamp(slot.field, slot.value)}
                  </span>
                </NodexTooltip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {mutationErrors.get(`page:${row.pageId}`) ? (
        <PropertyEditorFeedback
          message={mutationErrors.get(`page:${row.pageId}`)!}
          className="mt-1"
        />
      ) : null}
    </article>
  );
  const card = renderCard(null);
  const dragPreview = previewPortal
    ? createPortal(
        <div
          data-database-view-page-drag-preview="true"
          style={{
            boxSizing: "border-box",
            height: previewPortal.rect.height,
            width: previewPortal.rect.width,
          }}
        >
          <div className="relative opacity-90">
            {renderCard(previewPortal.rect)}
            {previewPortal.itemCount > 1 ? (
              <div className="absolute -top-1.5 -right-1.5 rounded-full bg-(--foreground) px-1.75 py-0.75 text-sm font-medium text-(--background) shadow-lg">
                {previewPortal.itemCount}
              </div>
            ) : null}
          </div>
        </div>,
        previewPortal.container,
      )
    : null;
  return (
    <>
      {card}
      {dragPreview}
    </>
  );
}
