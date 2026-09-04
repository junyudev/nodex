import {
  useDeferredValue,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { SurfaceHistoryStatus } from "@/components/shared/surface-history-status";
import { useSurfaceHistoryFocus } from "@/lib/surface-history/use-surface-history-focus";
import {
  type DatabaseViewLayout,
  type EffectiveDatabaseView,
  type DatabaseJsonValue,
  type DatabasePropertyOption,
  databaseGroupKeyForValue,
} from "../../../shared/database-kernel";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../../shared/database-module-v2";
import { effectiveDatabaseViewFilter } from "../../../shared/database-view-rules";
import type { ColumnPaginationState } from "@/lib/board-store";
import {
  compilePageCollectionSearchQuery,
  matchesPageCollectionSearchQuery,
} from "@/lib/page-search";
import {
  buildDatabaseViewMovePageRunOperations,
  buildDatabaseViewPropertyValueOperations,
  commitDatabaseViewOperations,
  DatabaseViewMutationError,
} from "@/lib/database-view-row-mutations";
import {
  buildDatabaseViewColumns,
  groupScopeKeyForPath,
  withEffectiveDatabaseView,
  type DatabaseViewRenderColumn,
  type DatabaseViewRenderModel,
  type DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import { readDatabasePropertyOptions } from "@/lib/database-view-authoring";
import { collectRequiredPropertyOptionIds } from "@/lib/database-option-registry-requirements";
import { databasePropertyValueSearchText } from "@/lib/database-property-search-text";
import { normalizeSearchText } from "@/lib/search-text";
import { cn } from "@/lib/utils";
import { parseDataSourcePropertyId } from "../../../shared/database-identities";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "@/lib/data-source-property-value-operations";
import { readRelationValuePreview } from "@/lib/data-source-relation-value";
import { usePropertyOptionRegistries } from "../database/use-property-option-registries";
import {
  readDataSourceRelationTargets,
  readDataSourceRelationTargetDescriptor,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import { useContextualKeyboardActionTarget } from "@/lib/use-contextual-keyboard-action-target";
import { markContextualKeyboardActionTargetActive } from "@/lib/contextual-keyboard-actions";
import type { CommandId } from "../../../shared/command-keybindings";
import {
  resolveBoardKeyboardActionPageIds,
  findBoardKeyboardLocation,
  resolveBoardKeyboardNavigation,
  type BoardKeyboardDirection,
} from "../board/board-keyboard-navigation";
import {
  applyOptimisticDatabaseViewBoardDrop,
  buildDatabaseViewBoardDropOperations,
  databaseViewSupportsSortedSlotInference,
  resolveDatabaseViewDropPropertyValues,
  resolveDatabaseViewSortedDropValues,
  type DatabaseViewBoardDropProjection,
} from "@/lib/database-view-drag-operations";
import {
  endLocalBlockDragSession,
  hasDragType,
  NODEX_BLOCK_TRANSFER_DRAG_MIME,
  resolveCrossSurfaceTransferMode,
  resolveLocalBlockDragDropSession,
  resolveLocalBlockDragOverSession,
  shouldHandleNativeCrossSurfaceDrag,
  summarizeBlockPagePromotionPreview,
} from "./block-transfer/cross-surface-drag";
import { readTaskShorthandPagePromotionEnabled } from "@/lib/page-promotion-preference";
import { toast } from "@/components/ui/toast";
import { computeNativeDropIndexFromSurface } from "../board/native-drop-index";
import { DropIndicator } from "../board/drop-indicator";
import { resolveDropIndicatorPlacement } from "../board/drop-indicator-placement";
import { DatabaseList } from "./database-list/database-list";
import {
  DatabaseViewHistoryCommandError,
  databaseViewHistoryScopeKey,
  handleDatabaseViewMutationHistoryKeyDown,
  useDatabaseViewMutationHistory,
  useDatabaseViewHistoryInput,
  type DatabaseViewMutationHistory,
} from "./database-view-mutation-history";
import { commitDatabaseViewBlockDrop } from "./database-view-block-drop-command";
import { projectDatabaseBoardGroup } from "./database-board/database-board-model";
import { DatabaseBoardGroupMarker } from "./database-board/database-board-group-marker";
import {
  createDatabaseBoardPageMenuSession,
  DatabaseBoardCard,
} from "./database-board/database-board-card";
import { DatabaseViewPageContextMenuHost } from "./database-view-page-context-menu-host";
import { buildDatabaseViewPageDragData } from "./database-view-page-drag";
import { ColumnActionPopover } from "../board/column-action-popover";
import {
  databaseBoardColumnLayoutScope,
  getDatabaseBoardColumnLayout,
  readDatabaseBoardColumnLayoutPrefs,
  updateDatabaseBoardColumnLayoutPrefs,
  type DatabaseBoardColumnLayoutPrefs,
} from "@/lib/database-board-column-layout";
import { COLLAPSED_BOARD_COLUMN_WIDTH } from "@/lib/board-column-layout";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { PlusIcon } from "@/components/shared/icons";
import type { DatabaseViewBoardPageDropIntent } from "@/lib/use-board";
import { databaseViewGesturePreferencesOverride } from "../../../shared/database-view-presentation";
import type { DatabaseViewPageActionPort } from "./database-view-page-actions";
import type { DatabaseViewPageOpenHandler } from "./database-view-page-open";
import type { PageChatActivitySummary } from "@/lib/types";
import {
  DatabasePageChatActivityBoundary,
  useDatabasePageChatActivityRuntime,
} from "./database-page-chat-activity-runtime";

const DATABASE_VIEW_PAGE_DRAG_MIME = "application/vnd.nodex.database-view-pages.v1+json";
const DATABASE_BOARD_COLUMN_GUTTER = 12;
const DATABASE_BOARD_COLUMN_WIDTH_TRANSITION = {
  duration: 0.3,
  ease: [0.22, 1, 0.36, 1],
} as const;
const DATABASE_BOARD_COLUMN_CONTENT_TRANSITION = {
  duration: 0.16,
  ease: [0, 0, 0.2, 1],
} as const;
const DATABASE_BOARD_COLUMN_REDUCED_MOTION_TRANSITION = { duration: 0 } as const;

const databaseBoardColumnSurfaceWidth = (layoutWidth: number, collapsed: boolean): number =>
  (collapsed ? COLLAPSED_BOARD_COLUMN_WIDTH : layoutWidth) - DATABASE_BOARD_COLUMN_GUTTER;

const readDraggedPageIds = (dataTransfer: DataTransfer): readonly string[] => {
  const serialized = dataTransfer.getData(DATABASE_VIEW_PAGE_DRAG_MIME);
  if (!serialized) return [];
  try {
    const value = JSON.parse(serialized) as { pageIds?: unknown };
    if (!Array.isArray(value.pageIds)) return [];
    const pageIds = value.pageIds.filter(
      (pageId): pageId is string => typeof pageId === "string" && pageId.length > 0,
    );
    return pageIds.length === value.pageIds.length && new Set(pageIds).size === pageIds.length
      ? pageIds
      : [];
  } catch {
    return [];
  }
};

interface DatabaseViewSurfaceProps {
  readonly model: DatabaseViewRenderModel;
  readonly presentationLayout?: DatabaseViewLayout;
  readonly effectivePresentation?: EffectiveDatabaseView;
  readonly groupPagination?: ReadonlyMap<string, ColumnPaginationState>;
  readonly onLoadMoreGroup?: (scopeKey: string) => Promise<void> | void;
  readonly searchQuery: string;
  readonly showViewLabel?: boolean;
  readonly onOpenPage: DatabaseViewPageOpenHandler;
  readonly pageActionPort?: DatabaseViewPageActionPort;
  readonly onCommitted?: () => void | Promise<void>;
  readonly commitOperations?: typeof commitDatabaseViewOperations;
  readonly onMoveBoardPages?: (
    input: DatabaseViewBoardPageDropIntent,
    request: Parameters<typeof commitDatabaseViewOperations>[0],
  ) => ReturnType<typeof commitDatabaseViewOperations>;
  readonly mutationHistory?: DatabaseViewMutationHistory;
  readonly keyboardSurface?: {
    readonly surfaceId: string;
    readonly presentationId: string;
  };
  readonly presentedPageIds?: ReadonlySet<string>;
  readonly initialSelectedPageIds?: ReadonlySet<string>;
  readonly onSelectedPageIdsChange?: (pageIds: ReadonlySet<string>) => void;
  readonly pageCreateSurfaceId?: string;
  readonly onRequestCreatePage?: (groupKey: string) => void;
}

interface DatabaseViewBoardOptimisticDrop extends DatabaseViewBoardDropProjection {
  readonly sessionId: number;
  readonly storeEpoch: string;
  readonly receiptCommitSeq: number | null;
}

const rowByPageId = (model: DatabaseViewRenderModel, pageId: string): DataSourcePageRowV2 | null =>
  model.query.rows.find((row) => row.page.pageId === pageId) ?? null;

const searchablePropertyValues = (
  model: DatabaseViewRenderModel,
  pageId: string,
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): string => {
  const row = rowByPageId(model, pageId);
  if (!row) return "";
  const propertyById = new Map(
    model.query.properties.map((property) => [String(property.propertyId), property] as const),
  );
  return Object.values(row.values)
    .map((value) => {
      const relation = readRelationValuePreview(value.value);
      if (!relation) {
        return databasePropertyValueSearchText(value.value, {
          optionBacked:
            propertyById.get(value.propertyId)?.valueType === "select" ||
            propertyById.get(value.propertyId)?.valueType === "multi_select",
          options: optionRegistries[value.propertyId],
        });
      }
      return relation.targets
        .flatMap((target) => (target.kind === "visible" ? [target.title] : []))
        .join(" ");
    })
    .join(" ");
};

export const databaseViewMutationErrorMessage = (error: unknown, pageMutation: boolean): string => {
  if (error instanceof DatabaseViewHistoryCommandError && error.status === "recovering")
    return "Confirming your last edit. Earlier history is paused.";
  if (
    error instanceof DatabaseViewMutationError &&
    error.commandError.code === "revision_conflict"
  ) {
    return pageMutation
      ? "Page position changed elsewhere. Review and try again."
      : "Value changed elsewhere. Review and try again.";
  }
  if (
    error instanceof DatabaseViewMutationError &&
    error.commandError.code === "resource_not_found"
  ) {
    return pageMutation
      ? "This page is no longer available."
      : "This property is no longer available.";
  }
  return pageMutation
    ? "Couldn’t move this page. Try again."
    : "Couldn’t save this property. Try again.";
};

export function DatabaseViewSurface(props: DatabaseViewSurfaceProps) {
  return (
    <DatabasePageChatActivityBoundary model={props.model}>
      <DatabaseViewSurfaceContent {...props} />
    </DatabasePageChatActivityBoundary>
  );
}

function DatabaseViewSurfaceContent(props: DatabaseViewSurfaceProps) {
  const { onSelectedPageIdsChange } = props;
  const pageChatRuntime = useDatabasePageChatActivityRuntime();
  const localMutationHistory = useDatabaseViewMutationHistory(
    databaseViewHistoryScopeKey(props.model),
  );
  const mutationHistory = props.mutationHistory ?? localMutationHistory;
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(
    () => new Set(props.initialSelectedPageIds),
  );
  const handleSelectedPageIdsChange = useCallback(
    (next: ReadonlySet<string>): void => {
      setSelectedPageIds((current) => {
        if (current.size === next.size && [...current].every((pageId) => next.has(pageId))) {
          return current;
        }
        return new Set(next);
      });
      onSelectedPageIdsChange?.(next);
    },
    [onSelectedPageIdsChange],
  );
  const effectivePresentation = props.effectivePresentation ?? {
    layout: props.presentationLayout ?? props.model.query.view.layout,
    rules: props.model.query.view.config.rules,
    presentation: props.model.query.view.config.presentation,
  };
  if (effectivePresentation.layout === "list") {
    return (
      <DatabaseList
        model={props.model}
        effectivePresentation={effectivePresentation}
        groupPagination={props.groupPagination}
        onLoadMoreGroup={props.onLoadMoreGroup}
        searchQuery={props.searchQuery}
        onOpenPage={props.onOpenPage}
        pageActionPort={props.pageActionPort}
        onCommitted={props.onCommitted}
        commitOperations={props.commitOperations}
        presentedPageIds={props.presentedPageIds}
        initialSelectedPageIds={selectedPageIds}
        onSelectedPageIdsChange={handleSelectedPageIdsChange}
        pageCreateSurfaceId={props.pageCreateSurfaceId}
        onRequestCreatePage={props.onRequestCreatePage}
        mutationHistory={mutationHistory}
        pageChatActivityByPageId={pageChatRuntime.activityByPageId}
        onRemovePageChatRelation={pageChatRuntime.removeRelation}
      />
    );
  }
  return (
    <BoardDatabaseViewSurface
      {...props}
      mutationHistory={mutationHistory}
      effectivePresentation={effectivePresentation}
      initialSelectedPageIds={selectedPageIds}
      onSelectedPageIdsChange={handleSelectedPageIdsChange}
      pageChatActivityByPageId={pageChatRuntime.activityByPageId}
      onRemovePageChatRelation={pageChatRuntime.removeRelation}
    />
  );
}

function BoardDatabaseViewSurface({
  model,
  effectivePresentation,
  groupPagination,
  onLoadMoreGroup,
  searchQuery,
  onOpenPage,
  pageActionPort,
  onCommitted,
  commitOperations = commitDatabaseViewOperations,
  onMoveBoardPages,
  keyboardSurface,
  presentedPageIds,
  initialSelectedPageIds,
  onSelectedPageIdsChange,
  pageCreateSurfaceId,
  onRequestCreatePage,
  mutationHistory: providedMutationHistory,
  pageChatActivityByPageId,
  onRemovePageChatRelation,
}: Omit<DatabaseViewSurfaceProps, "effectivePresentation"> & {
  readonly effectivePresentation: EffectiveDatabaseView;
  readonly pageChatActivityByPageId: ReadonlyMap<string, PageChatActivitySummary>;
  readonly onRemovePageChatRelation: (pageId: string, sessionId: string) => Promise<void>;
}) {
  const localMutationHistory = useDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model));
  const reducedMotion = useResolvedReducedMotion();
  const columnWidthTransition = reducedMotion
    ? DATABASE_BOARD_COLUMN_REDUCED_MOTION_TRANSITION
    : DATABASE_BOARD_COLUMN_WIDTH_TRANSITION;
  const columnContentTransition = reducedMotion
    ? DATABASE_BOARD_COLUMN_REDUCED_MOTION_TRANSITION
    : DATABASE_BOARD_COLUMN_CONTENT_TRANSITION;
  const mutationHistory = providedMutationHistory ?? localMutationHistory;
  const [pendingMutationKeys, setPendingMutationKeys] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [mutationErrors, setMutationErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [highlightedPageId, setHighlightedPageId] = useState<string | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedPageIds),
  );
  const [draggingPageIds, setDraggingPageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [optimisticDrop, setOptimisticDrop] = useState<DatabaseViewBoardOptimisticDrop | null>(
    null,
  );
  const optimisticDropSessionIdRef = useRef(0);
  const draggingPageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [boardDragInstanceId] = useState(() => Symbol("database-board-drag"));
  const [dropIndicator, setDropIndicator] = useState<{
    readonly scopeKey: string;
    readonly index: number;
    readonly exactSlot: boolean;
    readonly label?: string;
  } | null>(null);
  const keyboardSurfaceFallbackId = useId();
  const surfaceId =
    keyboardSurface?.surfaceId ??
    `database-view:${model.databaseViewId}:${keyboardSurfaceFallbackId}`;
  const presentationId =
    keyboardSurface?.presentationId ?? `database-view-presentation:${keyboardSurfaceFallbackId}`;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const requiredOptionIds = useMemo(
    () =>
      collectRequiredPropertyOptionIds({
        properties: model.query.properties,
        rows: model.query.rows,
        filter: effectiveDatabaseViewFilter(effectivePresentation.rules),
      }),
    [effectivePresentation.rules, model.query.properties, model.query.rows],
  );
  const propertyOptionRegistries = usePropertyOptionRegistries({
    accessContext: model.accessContext,
    properties: model.query.properties,
    requiredOptionIds,
  });
  const {
    options: optionRegistries,
    states: optionRegistryStates,
    hasMore: optionRegistryHasMore,
    loadingMore: optionRegistryLoadingMore,
    requestOptions,
    requestMoreOptions,
  } = propertyOptionRegistries;
  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    onSelectedPageIdsChange?.(selectedPageIds);
  }, [onSelectedPageIdsChange, selectedPageIds]);
  const activeLayout = effectivePresentation.layout;
  const presentation = effectivePresentation.presentation;
  const authorityMutationModel = useMemo(
    () => withEffectiveDatabaseView(model, effectivePresentation),
    [effectivePresentation, model],
  );
  const mutationModel = useMemo(
    () =>
      optimisticDrop
        ? applyOptimisticDatabaseViewBoardDrop(authorityMutationModel, optimisticDrop)
        : authorityMutationModel,
    [authorityMutationModel, optimisticDrop],
  );
  useEffect(() => {
    if (!optimisticDrop) return;
    if (optimisticDrop.storeEpoch !== authorityMutationModel.storeEpoch) {
      setOptimisticDrop(null);
      return;
    }
    if (
      optimisticDrop.receiptCommitSeq === null ||
      authorityMutationModel.commitSeq < optimisticDrop.receiptCommitSeq ||
      applyOptimisticDatabaseViewBoardDrop(authorityMutationModel, optimisticDrop) !==
        authorityMutationModel
    )
      return;
    setOptimisticDrop((current) =>
      current?.sessionId === optimisticDrop.sessionId ? null : current,
    );
  }, [authorityMutationModel, optimisticDrop]);
  const groupPropertyId = presentation.group?.propertyId ?? null;
  const subgroupPropertyId = presentation.subgroup?.propertyId ?? null;
  const compiledSearchQuery = useMemo(
    () => compilePageCollectionSearchQuery(deferredSearchQuery),
    [deferredSearchQuery],
  );
  const trailingBoardFields = presentation.display.fields;
  const showBoardPageKey = presentation.display.fields.some(
    (field) => field.kind === "intrinsic" && field.field === "page_key",
  );
  const showBoardDescription = presentation.display.showDescription !== false;
  const columns = useMemo(
    () =>
      buildDatabaseViewColumns(
        mutationModel.query,
        presentation.group?.propertyId ?? null,
        true,
      ).map((column): DatabaseViewRenderColumn => ({
        ...column,
        rows:
          compiledSearchQuery.normalizedQuery.length === 0
            ? column.rows
            : column.rows.filter((row) =>
                matchesPageCollectionSearchQuery(
                  row.pageKey,
                  normalizeSearchText(
                    `${row.title} ${row.preview} ${row.plainText} ${searchablePropertyValues(mutationModel, row.pageId, optionRegistries)}`,
                  ),
                  compiledSearchQuery,
                ),
              ),
      })),
    [compiledSearchQuery, mutationModel, optionRegistries, presentation],
  );
  const groupProperty =
    model.query.properties.find(
      (property) => property.lifecycle === "active" && property.propertyId === groupPropertyId,
    ) ?? null;
  const subgroupProperty =
    model.query.properties.find(
      (property) => property.lifecycle === "active" && property.propertyId === subgroupPropertyId,
    ) ?? null;
  const groupOptions = groupProperty
    ? (optionRegistries[groupProperty.propertyId] ?? readDatabasePropertyOptions(groupProperty))
    : [];
  const subgroupOptions = subgroupProperty
    ? (optionRegistries[subgroupProperty.propertyId] ??
      readDatabasePropertyOptions(subgroupProperty))
    : [];
  const columnPresentations = new Map(
    columns.map(
      (column) =>
        [
          column.id,
          projectDatabaseBoardGroup({
            property: groupProperty,
            groupKey: column.groupKey,
            label: column.name,
            pathKey: column.scopeKey,
            options: groupOptions,
          }),
        ] as const,
    ),
  );
  const columnLayoutScope = databaseBoardColumnLayoutScope({
    viewId: model.databaseViewId,
    groupPropertyId,
  });
  const [columnLayoutPrefs, setColumnLayoutPrefs] = useState<DatabaseBoardColumnLayoutPrefs>(() =>
    readDatabaseBoardColumnLayoutPrefs(columnLayoutScope),
  );
  useEffect(() => {
    setColumnLayoutPrefs(readDatabaseBoardColumnLayoutPrefs(columnLayoutScope));
  }, [columnLayoutScope]);
  const patchColumnLayout = (
    pathKey: string,
    patch: Parameters<typeof updateDatabaseBoardColumnLayoutPrefs>[3],
  ) => {
    setColumnLayoutPrefs((current) =>
      updateDatabaseBoardColumnLayoutPrefs(columnLayoutScope, current, pathKey, patch),
    );
  };
  const subgroupsByColumn = useMemo(() => {
    const subgroupPropertyId = presentation.subgroup?.propertyId;
    if (!subgroupPropertyId) {
      return new Map(
        columns.map(
          (column) =>
            [
              column.id,
              [
                {
                  key: null,
                  name: null,
                  scopeKey: column.scopeKey,
                  rows: column.rows,
                },
              ],
            ] as const,
        ),
      );
    }
    const property = model.query.properties.find(
      (candidate) =>
        candidate.lifecycle === "active" && candidate.propertyId === subgroupPropertyId,
    );
    if (!property)
      return new Map<
        string,
        readonly {
          readonly key: string | null;
          readonly name: string | null;
          readonly scopeKey: string;
          readonly rows: readonly DatabaseViewRenderRow[];
        }[]
      >();
    const options = readDatabasePropertyOptions(property);
    const optionNames = new Map(options.map((option) => [option.id, option.name]));
    const showEmpty = presentation.display.showEmptyGroups;
    const finiteKeys = showEmpty
      ? property.valueType === "checkbox"
        ? ["false", "true"]
        : property.valueType === "select"
          ? options.map((option) => option.id)
          : []
      : [];
    return new Map(
      columns.map((column) => {
        const keys = [...finiteKeys, ...column.rows.map((row) => row.subgroupKey)].filter(
          (key, index, all) => all.indexOf(key) === index,
        );
        const normalizedKeys = keys.length > 0 ? keys : [null];
        return [
          column.id,
          normalizedKeys.map((key) => ({
            key,
            name:
              key === null
                ? `No ${property.name}`
                : (optionNames.get(key) ??
                  (key === "true" ? "Checked" : key === "false" ? "Unchecked" : key)),
            scopeKey: groupScopeKeyForPath(column.groupKey, key),
            rows: column.rows.filter((row) => row.subgroupKey === key),
          })),
        ] as const;
      }),
    );
  }, [columns, model.query.properties, presentation]);
  const boardSubgroups = useMemo(() => {
    const entries = columns.flatMap((column) => subgroupsByColumn.get(column.id) ?? []);
    const unique = new Map<string, { key: string | null; name: string | null }>();
    for (const entry of entries) {
      const identity = entry.key === null ? "null" : `key:${entry.key}`;
      if (!unique.has(identity)) {
        unique.set(identity, { key: entry.key, name: entry.name });
      }
    }
    return [...unique.values()];
  }, [columns, subgroupsByColumn]);
  const allRows = useMemo(() => columns.flatMap((column) => column.rows), [columns]);
  const keyboardBoard = useMemo(
    () => ({
      columns: columns.map((column) => ({
        id: column.id,
        cards: column.rows.map((row) => ({ id: row.pageId })),
      })),
    }),
    [columns],
  );
  const visiblePageIds = useMemo(() => new Set(allRows.map((row) => row.pageId)), [allRows]);

  useEffect(() => {
    setHighlightedPageId((current) => (current && !visiblePageIds.has(current) ? null : current));
    setSelectedPageIds((current) => {
      const next = new Set([...current].filter((pageId) => visiblePageIds.has(pageId)));
      return next.size === current.size ? current : next;
    });
  }, [visiblePageIds]);
  const failedContinuations = [...(groupPagination?.values() ?? [])].filter(
    (state) => state.error !== null,
  );
  const columnTotalRows = (columnId: string): number =>
    (subgroupsByColumn.get(columnId) ?? []).reduce(
      (total, subgroup) =>
        total + (groupPagination?.get(subgroup.scopeKey)?.totalRows ?? subgroup.rows.length),
      0,
    );
  const groupShowMore = (scopeKey: string) => {
    const state = groupPagination?.get(scopeKey);
    if (!state?.hasMore || !onLoadMoreGroup) return null;
    const remainingRows =
      state.totalRows === null ? null : Math.max(state.totalRows - state.loadedRows, 0);
    const label =
      remainingRows !== null && remainingRows > 0
        ? `Show ${Math.min(remainingRows, 50)} more`
        : "Show more";
    return (
      <button
        type="button"
        disabled={state.loadingMore}
        onClick={() => void onLoadMoreGroup(scopeKey)}
        className="mt-2 flex w-full items-center rounded-md px-2.5 py-1.5 text-xs font-medium text-(--foreground-secondary) hover:bg-(--surface-hover) disabled:opacity-50"
      >
        {state.loadingMore ? "Loading…" : label}
      </button>
    );
  };

  const commit = async (
    operations: Parameters<typeof commitDatabaseViewOperations>[0]["operations"],
    mutationKeys: readonly string[],
    propagateError = false,
    submitForward?: typeof commitDatabaseViewOperations,
  ) => {
    if (operations.length === 0) return null;
    setPendingMutationKeys((current) => {
      const next = new Map(current);
      for (const key of mutationKeys) next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
    setMutationErrors((current) => {
      const next = new Map(current);
      for (const key of mutationKeys) next.delete(key);
      return next;
    });
    try {
      const receipt = await mutationHistory.executeOperations({
        model: mutationModel,
        operations,
        commitOperations,
        submitForward,
      });
      await onCommitted?.();
      return receipt;
    } catch (nextError) {
      console.error("[database-view:mutation]", nextError);
      const pageMutation = mutationKeys.some((key) => key.startsWith("page:"));
      const message = databaseViewMutationErrorMessage(nextError, pageMutation);
      if (!propagateError) {
        setMutationErrors((current) => {
          const next = new Map(current);
          for (const key of mutationKeys) next.set(key, message);
          return next;
        });
      }
      await onCommitted?.();
      if (propagateError) throw nextError;
      return null;
    } finally {
      setPendingMutationKeys((current) => {
        const next = new Map(current);
        for (const key of mutationKeys) {
          const count = next.get(key) ?? 0;
          if (count <= 1) next.delete(key);
          else next.set(key, count - 1);
        }
        return next;
      });
    }
  };

  const setValue = (pageId: string, propertyId: string, value: DatabaseJsonValue) =>
    void commit(
      buildDatabaseViewPropertyValueOperations({
        model: mutationModel,
        pageId,
        propertyId,
        value,
      }),
      [`value:${pageId}:${propertyId}`],
    );
  const setStructuralValue = (pageId: string, propertyId: string, value: DatabaseJsonValue) => {
    const row = model.query.rows.find((candidate) => candidate.page.pageId === pageId);
    if (!row) return;
    const operations = buildDatabaseViewBoardDropOperations({
      model: mutationModel,
      pageIds: [pageId],
      target: {
        groupKey:
          propertyId === groupPropertyId ? databaseGroupKeyForValue(value) : row.effectiveGroupKey,
        subgroupKey:
          propertyId === subgroupPropertyId
            ? databaseGroupKeyForValue(value)
            : row.effectiveSubgroupKey,
      },
    });
    void commit(operations, [`page:${pageId}`, `value:${pageId}:${propertyId}`]);
  };
  const isPageRunGroupComplete = (pageIds: readonly string[]): boolean => {
    const owningColumns = pageIds.map((pageId) =>
      columns.find((column) => column.rows.some((row) => row.pageId === pageId)),
    );
    const first = owningColumns[0];
    if (!first || owningColumns.some((column) => column?.id !== first.id)) {
      return false;
    }
    return groupPagination?.get(first.scopeKey)?.hasMore !== true;
  };
  const move = (
    pageIds: string | readonly string[],
    direction: "up" | "down" | "top" | "bottom",
  ) => {
    const orderedPageIds = typeof pageIds === "string" ? [pageIds] : pageIds;
    const groupComplete = isPageRunGroupComplete(orderedPageIds);
    void commit(
      buildDatabaseViewMovePageRunOperations({
        model: mutationModel,
        pageIds: orderedPageIds,
        direction,
        groupComplete,
      }),
      orderedPageIds.map((pageId) => `page:${pageId}`),
    );
  };
  const highlightPage = (pageId: string, focus = false) => {
    setHighlightedPageId(pageId);
    markContextualKeyboardActionTargetActive(surfaceId);
    if (!focus) return;
    requestAnimationFrame(() => {
      const element = Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>("[data-database-view-page-id]") ?? [],
      ).find((candidate) => candidate.dataset.databaseViewPageId === pageId);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const navigateHighlight = (direction: BoardKeyboardDirection): boolean => {
    const next = resolveBoardKeyboardNavigation(keyboardBoard, highlightedPageId, direction);
    if (!next) return false;
    highlightPage(next.pageId, true);
    return true;
  };
  const activeRow = highlightedPageId
    ? (allRows.find((row) => row.pageId === highlightedPageId) ?? null)
    : null;
  const togglePageSelection = (pageId: string): void => {
    setSelectedPageIds((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };
  const startPageDrag = (row: DatabaseViewRenderRow, event: ReactDragEvent<HTMLElement>): void => {
    const pageIds = selectedPageIds.has(row.pageId)
      ? allRows.flatMap((candidate) =>
          selectedPageIds.has(candidate.pageId) ? [candidate.pageId] : [],
        )
      : [row.pageId];
    event.dataTransfer.setData(DATABASE_VIEW_PAGE_DRAG_MIME, JSON.stringify({ pageIds }));
    event.dataTransfer.effectAllowed = "copyMove";
    const nextDraggingPageIds = new Set(pageIds);
    draggingPageIdsRef.current = nextDraggingPageIds;
    setDraggingPageIds(nextDraggingPageIds);
    highlightPage(row.pageId);
  };
  const endPageDrag = (): void => {
    draggingPageIdsRef.current = new Set();
    setDraggingPageIds(new Set());
    setDropIndicator(null);
  };
  const dropPages = (
    event: ReactDragEvent<HTMLElement>,
    target: {
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
      readonly beforePageId?: string;
    },
  ): void => {
    const pageIds = readDraggedPageIds(event.dataTransfer);
    if (pageIds.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const propertyValues = resolveDatabaseViewDropPropertyValues({
      model: mutationModel,
      pageIds,
      target,
    });
    const operations = buildDatabaseViewBoardDropOperations({
      model: mutationModel,
      pageIds,
      target,
      propertyValues,
    });
    if (operations.length === 0) {
      endPageDrag();
      return;
    }
    const optimistic: DatabaseViewBoardOptimisticDrop = {
      sessionId: ++optimisticDropSessionIdRef.current,
      storeEpoch: mutationModel.storeEpoch,
      pageIds,
      fallbackRows: mutationModel.query.rows.filter((row) => pageIds.includes(row.page.pageId)),
      target,
      propertyValues,
      receiptCommitSeq: null,
    };
    setOptimisticDrop(optimistic);
    endPageDrag();
    void (async () => {
      const receipt = await commit(
        operations,
        pageIds.map((pageId) => `page:${pageId}`),
        false,
        onMoveBoardPages
          ? (request) =>
              onMoveBoardPages(
                {
                  pageIds,
                  presentation: effectivePresentation,
                  target,
                  propertyValues,
                },
                request,
              )
          : undefined,
      );
      setOptimisticDrop((current) => {
        if (current?.sessionId !== optimistic.sessionId) return current;
        return receipt ? { ...current, receiptCommitSeq: receipt.commitSeq } : null;
      });
    })();
  };
  const dropBlocks = async (
    event: ReactDragEvent<HTMLElement>,
    target: {
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
      readonly beforePageId?: string;
    },
  ): Promise<void> => {
    const session = resolveLocalBlockDragDropSession(event.dataTransfer);
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      !presentation.group ||
      presentation.subgroup ||
      target.groupKey === null ||
      target.subgroupKey !== null
    ) {
      toast.info("Block transfer requires a Board grouped by one assigned property.");
      endLocalBlockDragSession({ sessionId: session.sessionId });
      return;
    }
    await commitDatabaseViewBlockDrop({
      historyScopeKey: databaseViewHistoryScopeKey(mutationModel),
      session,
      projectId: model.accessContext.kind === "project" ? model.accessContext.projectId : null,
      storeEpoch: model.storeEpoch,
      dataSourceId: model.dataSourceId,
      placement: {
        kind: "direct",
        viewId: model.databaseViewId,
        preferencesOverride: databaseViewGesturePreferencesOverride(effectivePresentation),
        groupKey: target.groupKey,
        ...(target.beforePageId ? { beforePageId: target.beforePageId } : {}),
        sortedPropertyValues: resolveDatabaseViewSortedDropValues({
          model: mutationModel,
          target,
        }),
      },
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      mutationHistory,
      onCommitted: async () => await onCommitted?.(),
    });
  };
  const dropOnBoardTarget = (
    event: ReactDragEvent<HTMLElement>,
    target: {
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
      readonly beforePageId?: string;
    },
  ): void => {
    if (event.dataTransfer.types.includes(DATABASE_VIEW_PAGE_DRAG_MIME)) {
      dropPages(event, target);
      return;
    }
    void dropBlocks(event, target);
  };
  const handleBoardCellDragOver = (
    event: ReactDragEvent<HTMLElement>,
    scopeKey: string,
    rows: readonly DatabaseViewRenderRow[],
    target: {
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
    },
  ): void => {
    const internal = event.dataTransfer.types.includes(DATABASE_VIEW_PAGE_DRAG_MIME);
    const blocks =
      shouldHandleNativeCrossSurfaceDrag(event.dataTransfer) &&
      hasDragType(event.dataTransfer, NODEX_BLOCK_TRANSFER_DRAG_MIME);
    if (!internal && !blocks) return;
    const blockSession = blocks ? resolveLocalBlockDragOverSession(event.dataTransfer) : null;
    const exactSlot = databaseViewSupportsSortedSlotInference(mutationModel);
    const internalPageIds = internal ? [...draggingPageIdsRef.current] : [];
    if (!exactSlot && internal) {
      const changesStructure = internalPageIds.some((pageId) => {
        const row = model.query.rows.find((candidate) => candidate.page.pageId === pageId);
        return (
          row?.effectiveGroupKey !== target.groupKey ||
          row.effectiveSubgroupKey !== target.subgroupKey
        );
      });
      if (!changesStructure) return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.altKey && blocks ? "copy" : "move";
    const ignoredPageIds = new Set(internalPageIds);
    const index = computeNativeDropIndexFromSurface(event.currentTarget, event.clientY, {
      ignoredPageIds,
    });
    const remainingRows = rows.filter((row) => !ignoredPageIds.has(row.pageId));
    const values = exactSlot
      ? resolveDatabaseViewDropPropertyValues({
          model: mutationModel,
          pageIds: [...ignoredPageIds],
          target: {
            ...target,
            ...(remainingRows[index] ? { beforePageId: remainingRows[index].pageId } : {}),
          },
        })
      : [];
    const propertyLabel = values
      .flatMap(({ propertyId, value }) => {
        const property = model.query.properties.find(
          (candidate) => candidate.lifecycle === "active" && candidate.propertyId === propertyId,
        );
        if (!property) return [];
        const options = optionRegistries[propertyId] ?? readDatabasePropertyOptions(property);
        const formatted =
          value === null
            ? "Empty"
            : typeof value === "string"
              ? (options.find((option) => option.id === value)?.name ?? value)
              : Array.isArray(value)
                ? value
                    .map((entry) =>
                      typeof entry === "string"
                        ? (options.find((option) => option.id === entry)?.name ?? entry)
                        : String(entry),
                    )
                    .join(", ")
                : String(value);
        return [`${property.name}: ${formatted}`];
      })
      .join(" · ");
    const promotionLabel = blockSession
      ? summarizeBlockPagePromotionPreview({
          mode: resolveCrossSurfaceTransferMode(event),
          rootCount: blockSession.payload.rootBlockIds.length,
          hints: blockSession.taskShorthandPreviewHints ?? [],
          literal: !readTaskShorthandPagePromotionEnabled() || event.shiftKey,
        })
      : "";
    const label = [promotionLabel, propertyLabel].filter(Boolean).join(" · ");
    setDropIndicator((current) =>
      current?.scopeKey === scopeKey &&
      current.index === index &&
      current.exactSlot === exactSlot &&
      current.label === (label || undefined)
        ? current
        : { scopeKey, index, exactSlot, ...(label ? { label } : {}) },
    );
  };
  const handleBoardCellDragLeave = (event: ReactDragEvent<HTMLElement>, scopeKey: string): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setDropIndicator((current) => (current?.scopeKey === scopeKey ? null : current));
  };
  const handleBoardCellDrop = (
    event: ReactDragEvent<HTMLElement>,
    rows: readonly DatabaseViewRenderRow[],
    target: {
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
    },
  ): void => {
    const internalPageIds = readDraggedPageIds(event.dataTransfer);
    const ignoredPageIds = new Set(internalPageIds);
    const index = computeNativeDropIndexFromSurface(event.currentTarget, event.clientY, {
      ignoredPageIds,
    });
    const remainingRows = rows.filter((row) => !ignoredPageIds.has(row.pageId));
    dropOnBoardTarget(event, {
      ...target,
      ...(databaseViewSupportsSortedSlotInference(mutationModel) && remainingRows[index]
        ? { beforePageId: remainingRows[index].pageId }
        : {}),
    });
    setDropIndicator(null);
  };
  const actionPageIds = resolveBoardKeyboardActionPageIds(
    keyboardBoard,
    highlightedPageId,
    selectedPageIds,
  );
  const moveDirectionForCommand = (
    commandId: CommandId,
  ): "up" | "down" | "top" | "bottom" | null => {
    if (commandId === "boardMoveUp") return "up";
    if (commandId === "boardMoveDown") return "down";
    if (commandId === "boardMoveTop") return "top";
    if (commandId === "boardMoveBottom") return "bottom";
    return null;
  };
  const buildHorizontalMoveOperations = (commandId: "boardMoveLeft" | "boardMoveRight") => {
    if (mutationModel.readOnlyReason) return null;
    const active = findBoardKeyboardLocation(keyboardBoard, highlightedPageId);
    if (!active || actionPageIds.length === 0) return null;
    const offset = commandId === "boardMoveRight" ? 1 : -1;
    const destinationColumn = columns[active.columnIndex + offset];
    const activeRenderRow = allRows.find((row) => row.pageId === active.pageId);
    if (!destinationColumn || !activeRenderRow) return null;
    const sourceColumn = columns[active.columnIndex];
    const sourceSubgroupIndex =
      sourceColumn?.rows
        .filter((row) => row.subgroupKey === activeRenderRow.subgroupKey)
        .findIndex((row) => row.pageId === active.pageId) ?? -1;
    if (sourceSubgroupIndex < 0) return null;
    const selected = new Set(actionPageIds);
    const remainingDestinationPageIds = destinationColumn.rows.flatMap((row) =>
      row.subgroupKey === activeRenderRow.subgroupKey && !selected.has(row.pageId)
        ? [row.pageId]
        : [],
    );
    const newOrder = Math.min(sourceSubgroupIndex, remainingDestinationPageIds.length);
    const beforePageId = remainingDestinationPageIds[newOrder];
    const operations = buildDatabaseViewBoardDropOperations({
      model: mutationModel,
      pageIds: actionPageIds,
      target: {
        groupKey: destinationColumn.groupKey,
        subgroupKey: activeRenderRow.subgroupKey,
        ...(beforePageId ? { beforePageId } : {}),
      },
    });
    return operations.length > 0 ? operations : null;
  };
  const canMoveHighlightedPage = (commandId: CommandId): boolean => {
    if (mutationModel.readOnlyReason) return false;
    if (commandId === "boardMoveLeft" || commandId === "boardMoveRight") {
      return buildHorizontalMoveOperations(commandId) !== null;
    }
    const direction = moveDirectionForCommand(commandId);
    if (!direction || actionPageIds.length === 0) return false;
    try {
      return (
        buildDatabaseViewMovePageRunOperations({
          model: mutationModel,
          pageIds: actionPageIds,
          direction,
          groupComplete: isPageRunGroupComplete(actionPageIds),
        }).length > 0
      );
    } catch {
      return false;
    }
  };

  useContextualKeyboardActionTarget({
    surfaceId,
    presentationId,
    canExecute: (commandId) => {
      if (commandId === "boardFocusNext" || commandId === "boardFocusPrevious")
        return allRows.length > 0;
      if (commandId === "boardFocusLeft" || commandId === "boardFocusRight")
        return activeLayout === "board" && allRows.length > 0;
      if (commandId === "boardClearSelection") {
        return selectedPageIds.size > 0;
      }
      if (commandId === "boardOpen" || commandId === "boardToggleSelection")
        return activeRow !== null;
      if (commandId.startsWith("boardMove")) {
        return canMoveHighlightedPage(commandId);
      }
      return false;
    },
    execute: (commandId) => {
      if (commandId === "boardFocusNext") return navigateHighlight("next");
      if (commandId === "boardFocusPrevious") return navigateHighlight("previous");
      if (commandId === "boardFocusLeft") return navigateHighlight("left");
      if (commandId === "boardFocusRight") return navigateHighlight("right");
      if (commandId === "boardClearSelection") {
        setSelectedPageIds(new Set());
        return true;
      }
      if (commandId === "boardOpen" && activeRow) {
        onOpenPage(activeRow.pageId, activeRow.title, "preview");
        return true;
      }
      if (commandId === "boardToggleSelection" && activeRow) {
        togglePageSelection(activeRow.pageId);
        return true;
      }
      if (commandId === "boardMoveLeft" || commandId === "boardMoveRight") {
        const operations = buildHorizontalMoveOperations(commandId);
        if (!operations) return false;
        void commit(
          operations,
          actionPageIds.map((pageId) => `page:${pageId}`),
        );
        return true;
      }
      const direction = moveDirectionForCommand(commandId);
      if (!direction || !canMoveHighlightedPage(commandId)) return false;
      move(actionPageIds, direction);
      return true;
    },
  });
  const patchRelation = (
    pageId: string,
    propertyId: string,
    delta: { readonly addPageIds: readonly string[]; readonly removeEdgeIds: readonly string[] },
  ) =>
    void commit(
      [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId,
              dataSourceId: model.query.dataSource.dataSourceId,
              propertyId: parseDataSourcePropertyId(propertyId),
              edit: {
                kind: "patch_set",
                delta: { kind: "relation", ...delta },
              },
            },
          ],
        },
      ],
      [`value:${pageId}:${propertyId}`],
    );
  const replaceRelation = (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    targetPageId: string | null,
  ) =>
    void commit(
      buildDataSourceRelationReplacementOperations({
        pageId,
        dataSourceId: model.query.dataSource.dataSourceId,
        property,
        expectedValueRevision:
          rowByPageId(model, pageId)?.values[property.propertyId]?.revision ?? 0,
        targetPageId,
      }),
      [`value:${pageId}:${property.propertyId}`],
    );
  const patchOptions = (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    delta: {
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    },
  ) =>
    void commit(
      buildDataSourceMultiSelectPatchOperations({
        pageId,
        dataSourceId: model.query.dataSource.dataSourceId,
        property,
        ...delta,
      }),
      [`value:${pageId}:${property.propertyId}`],
    );
  const createOption = async (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    option: { readonly optionId: string; readonly name: string; readonly color?: string },
  ): Promise<void> => {
    await commit(
      buildDataSourceCreateOptionAndSelectOperations({
        pageId,
        dataSourceId: model.query.dataSource.dataSourceId,
        property,
        current: rowByPageId(model, pageId)?.values[property.propertyId],
        option: {
          id: option.optionId,
          name: option.name,
          ...(option.color === undefined ? {} : { color: option.color }),
        },
      }),
      [`property:${property.propertyId}`, `value:${pageId}:${property.propertyId}`],
      true,
    );
  };
  const loadRelationTargets = async (pageId: string, propertyId: string, after: string | null) => {
    const property = model.query.properties.find(
      (candidate) => candidate.propertyId === propertyId,
    );
    if (!property) throw new Error(`Property is unavailable: ${propertyId}`);
    return await readDataSourceRelationTargets({
      accessContext: model.accessContext,
      pageId,
      property,
      after,
    });
  };
  const searchRelationCandidates = async (
    property: DataSourcePropertyRecordV2,
    query: string,
    after?: string | null,
  ) => {
    return await searchDataSourceRelationCandidates({
      accessContext: model.accessContext,
      property,
      query,
      after,
    });
  };
  const loadRelationTargetDescriptor = async (property: DataSourcePropertyRecordV2) =>
    await readDataSourceRelationTargetDescriptor({
      accessContext: model.accessContext,
      property,
    });
  const cardProps = (row: DatabaseViewRenderRow) =>
    ({
      model: mutationModel,
      row,
      trailingFields: trailingBoardFields,
      groupPropertyId,
      subgroupPropertyId,
      showPageKey: showBoardPageKey,
      showDescription: showBoardDescription,
      pendingMutationKeys,
      mutationErrors,
      onOpenPage,
      pageActionPort,
      pageChatActivity: pageChatActivityByPageId.get(row.pageId),
      onRemovePageChatRelation: (sessionId: string) =>
        onRemovePageChatRelation(row.pageId, sessionId),
      onSetValue: setValue,
      onSetStructuralValue: setStructuralValue,
      onPatchOptions: patchOptions,
      onPatchRelation: patchRelation,
      onReplaceOneRelation: replaceRelation,
      onCreateOption: createOption,
      onLoadRelationTargets: loadRelationTargets,
      onSearchRelationCandidates: searchRelationCandidates,
      onLoadRelationTargetDescriptor: loadRelationTargetDescriptor,
      onRelationValueStale: () => {
        void onCommitted?.();
      },
      onRequestOptions: requestOptions,
      onRequestMoreOptions: requestMoreOptions,
      optionRegistries,
      optionRegistryStates,
      optionRegistryHasMore,
      optionRegistryLoadingMore,
      onMove: move,
      highlighted: row.pageId === highlightedPageId,
      presented: presentedPageIds?.has(row.pageId) ?? false,
      selected: selectedPageIds.has(row.pageId),
      onHighlight: highlightPage,
      onToggleSelection: togglePageSelection,
      // Keep the same single-flight DnD boundary as List: a second placement
      // cannot start until the first optimistic projection has handed off to
      // receipt-covered authority.
      draggable:
        activeLayout === "board" && model.readOnlyReason === null && optimisticDrop === null,
      pragmaticDragData: buildDatabaseViewPageDragData({
        model: mutationModel,
        row,
        allRows,
        selectedPageIds,
        instanceId: boardDragInstanceId,
      }),
      dragging: draggingPageIds.has(row.pageId),
      onDragStartPage: startPageDrag,
      onDragEndPage: endPageDrag,
    }) as const;
  const historyInput = {
    history: mutationHistory,
    onCommitted,
    onBlocked: (reason: string) => toast.info(reason),
  };
  useDatabaseViewHistoryInput(surfaceRef, historyInput);
  useSurfaceHistoryFocus(surfaceRef, mutationHistory);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      handleDatabaseViewMutationHistoryKeyDown({
        ...historyInput,
        event,
      })
    )
      return;
    if (activeLayout !== "list") return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-database-view-page-id]");
    if (!row || target !== row) return;
    const pageId = row.dataset.databaseViewPageId;
    if (!pageId) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = allRows.findIndex((candidate) => candidate.pageId === pageId);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = allRows[index + offset];
      if (next) highlightPage(next.pageId, true);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? allRows[0] : allRows.at(-1);
      if (next) highlightPage(next.pageId, true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const active = allRows.find((candidate) => candidate.pageId === pageId);
      if (active) onOpenPage(active.pageId, active.title, "preview");
      return;
    }
    if (event.key !== " ") return;
    event.preventDefault();
    togglePageSelection(pageId);
  };

  return (
    <DatabaseViewPageContextMenuHost
      returnFocusRef={surfaceRef}
      resolveSession={(targetKey) => {
        const row = allRows.find((candidate) => candidate.pageId === targetKey);
        return row
          ? createDatabaseBoardPageMenuSession(cardProps(row), {
              groupComplete: isPageRunGroupComplete([row.pageId]),
            })
          : null;
      }}
    >
      <div
        ref={surfaceRef}
        tabIndex={0}
        className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
        data-database-view-id={model.databaseViewId}
        data-embedded-surface-input="true"
        contentEditable={false}
        onFocusCapture={() => markContextualKeyboardActionTargetActive(surfaceId)}
        onPointerDownCapture={() => markContextualKeyboardActionTargetActive(surfaceId)}
        onKeyDown={handleListKeyDown}
      >
        <SurfaceHistoryStatus controls={mutationHistory} />
        {failedContinuations.length > 0 && onLoadMoreGroup ? (
          <div
            role="alert"
            className="mx-3 mt-2 flex min-h-8 items-center gap-2 rounded-md bg-token-error-background/20 px-2.5 text-xs text-token-error-foreground"
          >
            <span className="min-w-0 flex-1 truncate">Couldn’t load more pages</span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-token-text-primary hover:bg-token-foreground/5"
              onClick={() => {
                for (const state of failedContinuations) {
                  void onLoadMoreGroup(state.scopeKey);
                }
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
        {columns.length === 0 ||
        (allRows.length === 0 && compiledSearchQuery.normalizedQuery.length > 0) ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-token-description-foreground">
            {compiledSearchQuery.normalizedQuery.length > 0
              ? "No matching Pages"
              : "This View has no Pages"}
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-auto px-3 pb-3"
            data-database-board-scroll="true"
            data-page-create-surface-id={pageCreateSurfaceId}
          >
            <div className="min-w-max">
              <div
                data-database-board-sticky-header="true"
                className="sticky top-0 z-20 bg-(--background) pt-3"
              >
                <div className="flex items-stretch gap-3">
                  {columns.map((column) => {
                    const group = columnPresentations.get(column.id)!;
                    const layout = getDatabaseBoardColumnLayout(columnLayoutPrefs, group.pathKey);
                    const totalRows = columnTotalRows(column.id);
                    const autoCollapsed = totalRows === 0;
                    const collapsed = layout.collapsed || autoCollapsed;
                    const collapsedTargetSubgroup = boardSubgroups[0] ?? null;
                    const collapsedTargetRows = collapsedTargetSubgroup
                      ? ((subgroupsByColumn.get(column.id) ?? []).find(
                          (candidate) => candidate.key === collapsedTargetSubgroup.key,
                        )?.rows ?? [])
                      : [];
                    const collapsedTargetScopeKey = collapsedTargetSubgroup
                      ? groupScopeKeyForPath(column.groupKey, collapsedTargetSubgroup.key)
                      : null;
                    const active = boardSubgroups.some(
                      (subgroupIdentity) =>
                        dropIndicator?.scopeKey ===
                        groupScopeKeyForPath(column.groupKey, subgroupIdentity.key),
                    );
                    return (
                      <motion.div
                        key={column.id}
                        data-database-board-column-header-shell={column.groupKey ?? "unassigned"}
                        className="relative h-10 shrink-0"
                        initial={false}
                        animate={{
                          width: databaseBoardColumnSurfaceWidth(layout.width, collapsed),
                        }}
                        transition={columnWidthTransition}
                        style={
                          {
                            "--column-accent": group.accentColor,
                            willChange: reducedMotion ? undefined : "width",
                          } as React.CSSProperties
                        }
                      >
                        {collapsed ? (
                          <motion.div
                            data-database-board-collapsed-header-underlay={
                              collapsed ? "true" : undefined
                            }
                            className="absolute inset-x-0 top-0 z-10 rounded-t-lg bg-(--background)"
                            initial={reducedMotion ? false : { opacity: 0, x: -4 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={columnContentTransition}
                          >
                            <div
                              data-database-board-column-header={collapsed ? "true" : undefined}
                              data-database-board-collapsed-header={collapsed ? "true" : undefined}
                              className="relative flex flex-col items-center rounded-t-lg px-1 pt-3 pb-2"
                              onDragOver={
                                collapsedTargetScopeKey
                                  ? (event) =>
                                      handleBoardCellDragOver(
                                        event,
                                        collapsedTargetScopeKey,
                                        collapsedTargetRows,
                                        {
                                          groupKey: column.groupKey,
                                          subgroupKey: collapsedTargetSubgroup?.key ?? null,
                                        },
                                      )
                                  : undefined
                              }
                              onDragLeave={
                                collapsedTargetScopeKey
                                  ? (event) =>
                                      handleBoardCellDragLeave(event, collapsedTargetScopeKey)
                                  : undefined
                              }
                              onDrop={
                                collapsedTargetSubgroup && collapsedTargetScopeKey
                                  ? (event) =>
                                      handleBoardCellDrop(event, collapsedTargetRows, {
                                        groupKey: column.groupKey,
                                        subgroupKey: collapsedTargetSubgroup.key,
                                      })
                                  : undefined
                              }
                              style={{
                                backgroundColor: active
                                  ? group.activeSurfaceColor
                                  : group.surfaceColor,
                                boxShadow: active
                                  ? "inset 1.5px 1.5px 0 color-mix(in srgb, var(--column-accent) 38%, transparent), inset -1.5px 0 0 color-mix(in srgb, var(--column-accent) 38%, transparent)"
                                  : undefined,
                              }}
                            >
                              <DatabaseBoardGroupMarker group={group} />
                              <span
                                data-database-board-collapsed-label={collapsed ? "true" : undefined}
                                className="mt-2 text-base font-medium whitespace-nowrap opacity-70"
                                style={{
                                  color: group.accentColor,
                                  writingMode: "vertical-lr",
                                }}
                              >
                                {column.name}
                              </span>
                              <span
                                className="mt-2 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums"
                                style={{
                                  color: group.accentColor,
                                  background:
                                    "color-mix(in srgb, var(--column-accent) 14%, transparent)",
                                }}
                              >
                                {totalRows}
                              </span>
                              <div className="pointer-events-auto mt-2">
                                <ColumnActionPopover
                                  columnName={column.name}
                                  collapsed={layout.collapsed}
                                  width={layout.width}
                                  accentColor={group.accentColor}
                                  alwaysVisible
                                  onCollapsedChange={(nextCollapsed) =>
                                    patchColumnLayout(group.pathKey, {
                                      collapsed: nextCollapsed,
                                    })
                                  }
                                  onWidthChange={(width) =>
                                    patchColumnLayout(group.pathKey, { width })
                                  }
                                />
                              </div>
                              {active ? (
                                <div
                                  data-board-collapsed-drop-indicator="true"
                                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
                                >
                                  <DropIndicator
                                    className="relative"
                                    label={dropIndicator?.label}
                                  />
                                </div>
                              ) : null}
                            </div>
                          </motion.div>
                        ) : null}
                        {!collapsed ? (
                          <div className="h-10 overflow-hidden rounded-t-lg">
                            <motion.div
                              data-database-board-column-header={collapsed ? undefined : "true"}
                              className="group/column flex h-10 items-center rounded-t-lg px-2"
                              initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={columnContentTransition}
                              style={{
                                width: databaseBoardColumnSurfaceWidth(layout.width, false),
                                backgroundColor: active
                                  ? group.activeSurfaceColor
                                  : group.surfaceColor,
                                boxShadow: active
                                  ? "inset 0 0 0 1.5px color-mix(in srgb, var(--column-accent) 38%, transparent)"
                                  : undefined,
                              }}
                            >
                              <DatabaseBoardGroupMarker group={group} />
                              <span
                                data-database-board-column-label="true"
                                className="ml-1.5 min-w-0 truncate text-sm font-normal text-token-text-primary"
                              >
                                {column.name}
                              </span>
                              <span
                                data-database-board-column-count="true"
                                className="ml-1.5 text-sm tabular-nums text-token-description-foreground"
                              >
                                {totalRows}
                              </span>
                              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/column:opacity-100 focus-within:opacity-100">
                                <ColumnActionPopover
                                  columnName={column.name}
                                  collapsed={layout.collapsed}
                                  width={layout.width}
                                  accentColor={group.accentColor}
                                  alwaysVisible
                                  onCollapsedChange={(nextCollapsed) =>
                                    patchColumnLayout(group.pathKey, {
                                      collapsed: nextCollapsed,
                                    })
                                  }
                                  onWidthChange={(width) =>
                                    patchColumnLayout(group.pathKey, { width })
                                  }
                                />
                                {!subgroupProperty &&
                                groupPropertyId === "status" &&
                                column.groupKey !== null &&
                                onRequestCreatePage ? (
                                  <button
                                    type="button"
                                    aria-label={`Create Page in ${column.name}`}
                                    data-page-create-trigger="header"
                                    data-page-create-column-id={column.groupKey}
                                    className="flex size-6 shrink-0 items-center justify-center rounded-xs text-(--column-accent) hover:bg-token-foreground/5"
                                    onClick={() => onRequestCreatePage(column.groupKey!)}
                                  >
                                    <PlusIcon className="size-3.5" />
                                  </button>
                                ) : null}
                              </div>
                            </motion.div>
                          </div>
                        ) : null}
                      </motion.div>
                    );
                  })}
                </div>
              </div>
              {boardSubgroups.map((subgroupIdentity) => (
                <section
                  key={
                    subgroupIdentity.key === null
                      ? "subgroup:null"
                      : `subgroup:${subgroupIdentity.key}`
                  }
                  className={subgroupIdentity.name ? "mt-1" : undefined}
                >
                  {subgroupIdentity.name ? (
                    <div className="sticky left-0 z-10 flex h-8 w-72 items-center gap-1.5 px-1 text-xs font-medium text-token-text-secondary">
                      <DatabaseBoardGroupMarker
                        group={projectDatabaseBoardGroup({
                          property: subgroupProperty,
                          groupKey: subgroupIdentity.key,
                          label: subgroupIdentity.name,
                          pathKey: `subgroup:${subgroupIdentity.key ?? "unassigned"}`,
                          options: subgroupOptions,
                        })}
                      />
                      <span className="truncate">{subgroupIdentity.name}</span>
                    </div>
                  ) : null}
                  <div className="flex items-stretch gap-3">
                    {columns.map((column) => {
                      const group = columnPresentations.get(column.id)!;
                      const layout = getDatabaseBoardColumnLayout(columnLayoutPrefs, group.pathKey);
                      const collapsed = layout.collapsed || columnTotalRows(column.id) === 0;
                      const subgroup = (subgroupsByColumn.get(column.id) ?? []).find(
                        (candidate) => candidate.key === subgroupIdentity.key,
                      );
                      const rows = subgroup?.rows ?? [];
                      const cellScopeKey =
                        subgroup?.scopeKey ??
                        groupScopeKeyForPath(column.groupKey, subgroupIdentity.key);
                      const indicatorPlacement = resolveDropIndicatorPlacement(
                        rows.map((row) => ({ id: row.pageId })),
                        draggingPageIds,
                        dropIndicator?.scopeKey === cellScopeKey ? dropIndicator.index : undefined,
                      );
                      const active = dropIndicator?.scopeKey === cellScopeKey;
                      const canCreateInCollapsedColumn =
                        !layout.collapsed &&
                        !subgroupProperty &&
                        groupPropertyId === "status" &&
                        column.groupKey !== null &&
                        onRequestCreatePage !== undefined;
                      const collapsedColumnInteractive =
                        layout.collapsed || canCreateInCollapsedColumn;
                      const handleCellDragOver = (event: ReactDragEvent<HTMLElement>): void =>
                        handleBoardCellDragOver(event, cellScopeKey, rows, {
                          groupKey: column.groupKey,
                          subgroupKey: subgroupIdentity.key,
                        });
                      const handleCellDragLeave = (event: ReactDragEvent<HTMLElement>): void =>
                        handleBoardCellDragLeave(event, cellScopeKey);
                      const handleCellDrop = (event: ReactDragEvent<HTMLElement>): void =>
                        handleBoardCellDrop(event, rows, {
                          groupKey: column.groupKey,
                          subgroupKey: subgroupIdentity.key,
                        });
                      return (
                        <motion.div
                          key={`${column.id}:${subgroupIdentity.key ?? "null"}`}
                          data-board-column-root="true"
                          data-board-column-id={column.groupKey ?? "unassigned"}
                          data-board-column-collapsed={collapsed ? "true" : "false"}
                          data-board-column-drop-target-active={active ? "true" : undefined}
                          data-app-action-board-column-id={column.groupKey ?? "unassigned"}
                          data-database-view-subgroup-key={subgroupIdentity.key ?? "unassigned"}
                          className="relative flex min-h-14 shrink-0 flex-col overflow-hidden rounded-b-lg"
                          initial={false}
                          animate={{
                            width: databaseBoardColumnSurfaceWidth(layout.width, collapsed),
                          }}
                          transition={columnWidthTransition}
                          style={
                            {
                              "--column-accent": group.accentColor,
                              backgroundColor: active
                                ? group.activeSurfaceColor
                                : group.surfaceColor,
                              boxShadow: active
                                ? collapsed
                                  ? "inset 1.5px 0 0 color-mix(in srgb, var(--column-accent) 38%, transparent), inset -1.5px 0 0 color-mix(in srgb, var(--column-accent) 38%, transparent), inset 0 -1.5px 0 color-mix(in srgb, var(--column-accent) 38%, transparent)"
                                  : "inset 0 0 0 1.5px color-mix(in srgb, var(--column-accent) 38%, transparent)"
                                : undefined,
                              willChange: reducedMotion ? undefined : "width",
                            } as React.CSSProperties
                          }
                          onDragOver={collapsed ? undefined : handleCellDragOver}
                          onDragLeave={collapsed ? undefined : handleCellDragLeave}
                          onDrop={collapsed ? undefined : handleCellDrop}
                        >
                          <AnimatePresence initial={false} mode="popLayout">
                            {collapsed ? (
                              <motion.div
                                key="collapsed"
                                role={collapsedColumnInteractive ? "button" : undefined}
                                tabIndex={collapsedColumnInteractive ? 0 : undefined}
                                aria-label={
                                  layout.collapsed
                                    ? `Expand ${column.name}`
                                    : canCreateInCollapsedColumn
                                      ? `Create Page in ${column.name}`
                                      : undefined
                                }
                                aria-disabled={canCreateInCollapsedColumn ? false : undefined}
                                data-page-create-trigger={
                                  canCreateInCollapsedColumn ? "auto-collapsed-column" : undefined
                                }
                                data-page-create-column-id={
                                  canCreateInCollapsedColumn
                                    ? (column.groupKey ?? undefined)
                                    : undefined
                                }
                                className={cn(
                                  "flex min-h-32 w-full flex-1 flex-col items-center rounded-b-lg px-1 pb-3 outline-none",
                                  collapsedColumnInteractive &&
                                    "cursor-pointer focus-visible:ring-2 focus-visible:ring-token-focus",
                                )}
                                initial={reducedMotion ? false : { opacity: 0, x: -4 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -4, pointerEvents: "none" }}
                                transition={columnContentTransition}
                                onDragOver={handleCellDragOver}
                                onDragLeave={handleCellDragLeave}
                                onDrop={handleCellDrop}
                                onClick={
                                  collapsedColumnInteractive
                                    ? () => {
                                        if (layout.collapsed) {
                                          patchColumnLayout(group.pathKey, { collapsed: false });
                                          return;
                                        }
                                        if (canCreateInCollapsedColumn) {
                                          onRequestCreatePage(column.groupKey!);
                                        }
                                      }
                                    : undefined
                                }
                                onKeyDown={
                                  collapsedColumnInteractive
                                    ? (event) => {
                                        if (event.key !== "Enter" && event.key !== " ") return;
                                        event.preventDefault();
                                        if (layout.collapsed) {
                                          patchColumnLayout(group.pathKey, { collapsed: false });
                                          return;
                                        }
                                        if (canCreateInCollapsedColumn) {
                                          onRequestCreatePage(column.groupKey!);
                                        }
                                      }
                                    : undefined
                                }
                              />
                            ) : (
                              <motion.div
                                key="expanded"
                                data-database-board-column-content="expanded"
                                className="flex min-h-14 flex-1 shrink-0 flex-col gap-2 rounded-b-lg px-2 pb-2 pt-0.75"
                                initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -8, pointerEvents: "none" }}
                                transition={columnContentTransition}
                                style={{
                                  width: databaseBoardColumnSurfaceWidth(layout.width, false),
                                }}
                              >
                                {rows.map((row) => (
                                  <div key={row.pageId} className="relative">
                                    {dropIndicator?.exactSlot &&
                                    indicatorPlacement.beforePageId === row.pageId ? (
                                      <DropIndicator
                                        className="absolute inset-x-0 top-0 -translate-y-1/2"
                                        label={dropIndicator?.label}
                                      />
                                    ) : null}
                                    <DatabaseBoardCard {...cardProps(row)} />
                                  </div>
                                ))}
                                {dropIndicator?.exactSlot && indicatorPlacement.atEnd ? (
                                  <div className="relative -mt-2 h-0">
                                    <DropIndicator
                                      className="absolute inset-x-0 top-0"
                                      label={dropIndicator?.label}
                                    />
                                  </div>
                                ) : null}
                                {subgroup ? groupShowMore(subgroup.scopeKey) : null}
                                {!subgroupProperty &&
                                groupPropertyId === "status" &&
                                column.groupKey !== null &&
                                onRequestCreatePage ? (
                                  <button
                                    type="button"
                                    data-page-create-trigger="footer"
                                    data-page-create-column-id={column.groupKey}
                                    className="flex w-full items-center gap-2.25 rounded-md border-[0.5px] px-2.5 py-2.5 text-sm outline-none hover:bg-[color-mix(in_srgb,var(--column-accent,#888)_15%,var(--card))] focus-visible:ring-2 focus-visible:ring-token-focus"
                                    style={{
                                      color: group.accentColor,
                                      borderColor:
                                        "color-mix(in srgb, var(--column-accent) 20%, transparent)",
                                    }}
                                    onClick={() => onRequestCreatePage(column.groupKey!)}
                                  >
                                    <PlusIcon className="size-4" />
                                    New page
                                  </button>
                                ) : null}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </DatabaseViewPageContextMenuHost>
  );
}
