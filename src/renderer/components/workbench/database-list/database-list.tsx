import {
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { usePropertyOptionRegistries } from "@/components/database/use-property-option-registries";
import type { DataSourcePagePropertyMenuSource } from "@/components/database/data-source-page-property-menu-source";
import type { ColumnPaginationState } from "@/lib/board-store";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "@/lib/data-source-property-value-operations";
import {
  readDataSourceRelationTargets,
  readDataSourceRelationTargetDescriptor,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import { readDatabasePropertyOptions } from "@/lib/database-view-authoring";
import { collectRequiredPropertyOptionIds } from "@/lib/database-option-registry-requirements";
import { databasePropertyValueSearchText } from "@/lib/database-property-search-text";
import { resolveDatabaseTaskFilterCapabilities } from "@/lib/database-view-task-filter";
import {
  buildDatabaseViewColumns,
  type DatabaseViewRenderColumn,
  type DatabaseViewRenderModel,
  type DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import {
  buildDatabaseViewMovePageRunOperations,
  buildDatabaseViewPropertyValueOperations,
  canMoveDatabaseViewPage,
  commitDatabaseViewOperations,
  DatabaseViewMutationError,
  type DatabaseViewMutationReceipt,
} from "@/lib/database-view-row-mutations";
import { databaseViewSupportsSortedSlotInference } from "@/lib/database-view-drag-operations";
import {
  compilePageCollectionSearchQuery,
  matchesPageCollectionSearchQuery,
} from "@/lib/page-search";
import { normalizeSearchText } from "@/lib/search-text";
import { cn } from "@/lib/utils";
import { StatusIcon } from "@/lib/status-presentation";
import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabaseViewField,
  EffectiveDatabaseView,
} from "../../../../shared/database-kernel";
import { isPriority } from "../../../../shared/priority";
import type {
  DatabaseApplyOperationV2,
  DatabaseListMoveUndoRecipeV2,
  DatabaseViewDisclosureTargetV2,
} from "../../../../shared/database-module-v2";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import { parseDataSourcePropertyId } from "../../../../shared/database-identities";
import {
  buildDatabaseListProjection,
  applyOptimisticDatabaseListDrop,
  captureDatabaseListScrollAnchor,
  computeDatabaseListVirtualWindow,
  databaseListScrollTopForOccurrence,
  databaseListMountedActiveOccurrenceKey,
  databaseListGroupKey,
  emptyDatabaseListSelection,
  isDatabaseListOccurrenceSelected,
  moveDatabaseListActiveOccurrence,
  moveDatabaseListActiveOccurrenceToBoundary,
  projectCoreDatabaseListRows,
  resolveDatabaseListAuthority,
  restoreDatabaseListScrollTop,
  selectAllDatabaseListOccurrences,
  selectDatabaseListOccurrence,
  selectedDatabaseListPageIds,
  syncDatabaseListSelection,
  type DatabaseListPageRow,
  type DatabaseListProjectionRow,
  type DatabaseListSelectionState,
} from "./database-list-model";
import {
  createDatabaseListPropertyEditorBinding,
  DatabaseListInlineProperties,
  DatabaseListTrailingPropertyCells,
  type DatabaseListPropertyRuntime,
} from "./database-list-property-cells";
import {
  DatabaseListDisclosureIcon,
  DatabaseListPlusIcon,
  DatabaseListPriorityIcon,
} from "./database-list-icons";
import { databaseListGroupLabel } from "./database-list-property-presentation";
import { isWorkflowStatus } from "../../../../shared/workflow-status";
import { DATABASE_LIST_INTERACTIVE_SELECTOR, DatabaseListRow } from "./database-list-row";
import type { DatabaseViewPageMenuSession } from "../database-view-page-context-menu";
import { DatabaseViewPageContextMenuHost } from "../database-view-page-context-menu-host";
import type { DatabaseViewPageActionPort } from "../database-view-page-actions";
import { buildDatabaseViewPageDragData } from "../database-view-page-drag";
import { DatabaseListSelectionActionBar } from "./database-list-selection-action-bar";
import { useDatabaseListGrid } from "./use-database-list-grid";
import {
  databaseListIdentifierSamples,
  projectDatabaseListPageIdentity,
  withForcedDatabaseListField,
  type DatabaseListPageIdentity,
} from "./database-list-grid";
import {
  databaseListDragTargetChangesPlacement,
  databaseListProjectionReflectsMove,
  resolveDatabaseListDragPreviewPlacement,
} from "./database-list-drag-model";
import {
  DatabaseListDndProvider,
  DatabaseListGroupDropTarget,
  type DatabaseListDndCommit,
} from "./database-list-dnd";
import {
  databaseListPreferencesOverride,
  useDatabaseListWindow,
  type DatabaseListWindowState,
} from "./use-database-list-window";
import {
  handleDatabaseViewMutationHistoryKeyDown,
  useDatabaseViewMutationHistory,
  type DatabaseViewMutationHistory,
} from "../database-view-mutation-history";
import { databaseListNestingContinuations } from "./database-list-nesting-lines";
import { DATABASE_LIST_THEME_CLASS_NAME } from "./database-list-theme";
import { undoDatabaseViewBlockTransfer } from "../database-view-block-transfer-undo";
import {
  endLocalBlockDragSession,
  hasDragType,
  NODEX_BLOCK_TRANSFER_DRAG_MIME,
  resolveCrossSurfaceTransferMode,
  resolveLocalBlockDragDropSession,
  resolveLocalBlockDragOverSession,
  shouldHandleNativeCrossSurfaceDrag,
  summarizeBlockPagePromotionPreview,
} from "../block-transfer/cross-surface-drag";
import { readTaskShorthandPagePromotionEnabled } from "@/lib/page-promotion-preference";
import { commitDatabaseViewBlockDrop } from "../database-view-block-drop-command";
import {
  resolveDatabaseListBlockDropRejection,
  resolveDatabaseListBlockDropPreview,
  type DatabaseListBlockDropPreview,
} from "./database-list-block-drop";
import type { DatabaseViewPageOpenHandler } from "../database-view-page-open";
import type { PageChatActivitySummary } from "@/lib/types";

const INITIAL_OVERSCAN = 100;
const EMPTY_DATABASE_LIST_PAGE_IDENTITY: DatabaseListPageIdentity = {
  label: "",
  title: "",
};
const IDLE_OVERSCAN_STEP = 600;
const IDLE_OVERSCAN_PASSES = 3;

interface DatabaseListProps {
  readonly model: DatabaseViewRenderModel;
  readonly effectivePresentation?: EffectiveDatabaseView;
  readonly groupPagination?: ReadonlyMap<string, ColumnPaginationState>;
  readonly onLoadMoreGroup?: (scopeKey: string) => Promise<void> | void;
  readonly searchQuery: string;
  readonly onOpenPage: DatabaseViewPageOpenHandler;
  readonly pageActionPort?: DatabaseViewPageActionPort;
  readonly onCommitted?: () => Promise<void> | void;
  readonly commitOperations?: typeof commitDatabaseViewOperations;
  readonly presentedPageIds?: ReadonlySet<string>;
  readonly initialSelectedPageIds?: ReadonlySet<string>;
  readonly onSelectedPageIdsChange?: (pageIds: ReadonlySet<string>) => void;
  readonly collapsedOccurrenceKeys?: readonly string[];
  readonly onOccurrenceDisclosureChange?: (
    target: DatabaseViewDisclosureTargetV2,
    collapsed: boolean,
  ) => void;
  readonly scrollStateKey?: string;
  readonly forcedDisplayField?: DatabaseViewField | null;
  readonly pageCreateSurfaceId?: string;
  readonly onRequestCreatePage?: (groupKey: string) => void;
  readonly mutationHistory?: DatabaseViewMutationHistory;
  readonly pageChatActivityByPageId: ReadonlyMap<string, PageChatActivitySummary>;
  readonly onRemovePageChatRelation: (pageId: string, sessionId: string) => Promise<void>;
}

interface DatabaseListCommitOptions {
  readonly mutationKeys?: readonly string[];
  readonly errorMessage?: string;
  readonly inlineError?: boolean;
  readonly propagateError?: boolean;
  readonly deferError?: boolean;
  readonly modelOverride?: DatabaseViewRenderModel;
}

interface DatabaseListFocusRequest {
  readonly id: number;
  readonly occurrenceKey: string;
}

interface DatabaseListOptimisticMove {
  readonly sessionId: number;
  readonly rootOccurrenceKeys: ReadonlySet<string>;
  readonly rootPageIds: ReadonlySet<string>;
  readonly targetOccurrenceKey: string;
  readonly position: "before" | "after" | "nest" | "root";
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly receiptCommitSeq: number | null;
  readonly normalizedTarget:
    | Extract<
        NonNullable<DatabaseViewMutationReceipt>["operationOutcomes"][number],
        { readonly kind: "list_occurrence_move" }
      >["normalizedTarget"]
    | null;
}

interface DatabaseListInteractionState {
  readonly selection: DatabaseListSelectionState;
  readonly focusRequest: DatabaseListFocusRequest | null;
}

type DatabaseListSelectionUpdate = (
  current: DatabaseListSelectionState,
) => DatabaseListSelectionState;

type DatabaseListInteractionAction =
  | {
      readonly kind: "update-selection";
      readonly update: DatabaseListSelectionUpdate;
      readonly focusRequestId?: number;
      readonly preserveFocusRequest?: boolean;
    }
  | {
      readonly kind: "consume-focus-request";
      readonly focusRequestId: number;
    };

const reduceDatabaseListInteraction = (
  state: DatabaseListInteractionState,
  action: DatabaseListInteractionAction,
): DatabaseListInteractionState => {
  if (action.kind === "consume-focus-request") {
    if (state.focusRequest?.id !== action.focusRequestId) return state;
    return { ...state, focusRequest: null };
  }

  const selection = action.update(state.selection);
  const occurrenceKey = selection.activeOccurrenceKey;
  const focusRequest =
    action.focusRequestId !== undefined && occurrenceKey
      ? { id: action.focusRequestId, occurrenceKey }
      : action.preserveFocusRequest
        ? state.focusRequest
        : null;
  if (selection === state.selection && focusRequest === state.focusRequest) return state;
  return { selection, focusRequest };
};

const propertyValueMutationKey = (pageId: string, propertyId: string): string =>
  `PROPERTY_VALUE_${encodeURIComponent(pageId)}_${encodeURIComponent(propertyId)}`;

const propertyDefinitionMutationKey = (propertyId: string): string =>
  `PROPERTY_DEFINITION_${encodeURIComponent(propertyId)}`;

const pageMutationKey = (pageId: string): string => `PAGE_${encodeURIComponent(pageId)}`;

const updateMutationCounts = (
  current: ReadonlyMap<string, number>,
  keys: readonly string[],
  delta: 1 | -1,
): ReadonlyMap<string, number> => {
  const next = new Map(current);
  for (const key of new Set(keys)) {
    const count = (next.get(key) ?? 0) + delta;
    if (count <= 0) next.delete(key);
    else next.set(key, count);
  }
  return next;
};

const searchablePropertyValues = (
  model: DatabaseViewRenderModel,
  pageId: string,
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): string => {
  const row = model.query.rows.find((candidate) => candidate.page.pageId === pageId);
  if (!row) return "";
  const propertyById = new Map(
    model.query.properties.map((property) => [String(property.propertyId), property] as const),
  );
  return Object.values(row.values)
    .map((entry) => {
      const property = propertyById.get(entry.propertyId);
      return databasePropertyValueSearchText(entry.value, {
        optionBacked: property?.valueType === "select" || property?.valueType === "multi_select",
        options: optionRegistries[entry.propertyId],
      });
    })
    .join(" ");
};

const searchableAuthorityValues = (
  authority: DataSourcePageRowV2,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): string => {
  const propertyById = new Map(
    properties.map((property) => [String(property.propertyId), property] as const),
  );
  return Object.values(authority.values)
    .map((entry) => {
      const property = propertyById.get(entry.propertyId);
      return databasePropertyValueSearchText(entry.value, {
        optionBacked: property?.valueType === "select" || property?.valueType === "multi_select",
        options: optionRegistries[entry.propertyId],
      });
    })
    .join(" ");
};

const availableListFields = (
  model: DatabaseViewRenderModel,
  fields: readonly DatabaseViewField[],
): readonly DatabaseViewField[] => {
  const propertyIds = new Set(
    model.query.properties.flatMap((property) =>
      property.lifecycle === "active" ? [String(property.propertyId)] : [],
    ),
  );
  return fields.filter((field) => {
    if (field.kind === "intrinsic") return true;
    if (!propertyIds.has(String(field.propertyId))) return false;
    return field.propertyId !== "status" && field.propertyId !== "priority";
  });
};

const groupLabel = (
  model: DatabaseViewRenderModel,
  propertyId: string | undefined,
  key: string | null,
): string => {
  const property = model.query.properties.find(
    (candidate) => candidate.lifecycle === "active" && candidate.propertyId === propertyId,
  );
  const option = property
    ? readDatabasePropertyOptions(property).find((candidate) => candidate.id === key)
    : undefined;
  return databaseListGroupLabel(propertyId, key, option?.name);
};

const databaseListGroupMarker = (propertyId: string | undefined, key: string | null): ReactNode => {
  if (propertyId === "status" && key) {
    return <StatusIcon statusId={key} className="size-4 shrink-0" />;
  }
  if (propertyId === "priority" && isPriority(key)) {
    return <DatabaseListPriorityIcon priority={key} className="size-4" />;
  }
  return (
    <span className="size-2 shrink-0 rounded-full ring-[1px] ring-[var(--database-list-icon-muted)]" />
  );
};

const initialSelection = (
  rows: readonly DatabaseListProjectionRow[],
  pageIds: ReadonlySet<string> | undefined,
): DatabaseListSelectionState => {
  const firstVisibleOccurrenceKey = rows.find((row) => row.kind === "page")?.key ?? null;
  if (!pageIds || pageIds.size === 0) {
    return {
      ...emptyDatabaseListSelection(),
      activeOccurrenceKey: firstVisibleOccurrenceKey,
    };
  }
  const selectedOccurrenceKeys = new Set(
    rows.flatMap((row) => (row.kind === "page" && pageIds.has(row.pageId) ? [row.key] : [])),
  );
  const first = selectedOccurrenceKeys.values().next().value ?? null;
  return {
    selectedOccurrenceKeys,
    allMatching: false,
    excludedOccurrenceKeys: new Set(),
    anchorOccurrenceKey: first,
    activeOccurrenceKey: first,
  };
};

const idleCallback = (callback: () => void): (() => void) => {
  if (typeof window === "undefined") return () => undefined;
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(callback, { timeout: 300 });
    return () => window.cancelIdleCallback(id);
  }
  const id = globalThis.setTimeout(callback, 32);
  return () => globalThis.clearTimeout(id);
};

const samePageIds = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((pageId) => right.has(pageId));

export function DatabaseList({
  model,
  effectivePresentation,
  groupPagination,
  onLoadMoreGroup,
  searchQuery,
  onOpenPage,
  pageActionPort,
  onCommitted,
  commitOperations = commitDatabaseViewOperations,
  presentedPageIds,
  initialSelectedPageIds,
  onSelectedPageIdsChange,
  collapsedOccurrenceKeys: controlledCollapsedOccurrenceKeys,
  onOccurrenceDisclosureChange,
  scrollStateKey = `database-view:${model.databaseViewId}:list`,
  forcedDisplayField = null,
  pageCreateSurfaceId,
  onRequestCreatePage,
  mutationHistory: providedMutationHistory,
  pageChatActivityByPageId,
  onRemovePageChatRelation,
}: DatabaseListProps) {
  const localMutationHistory = useDatabaseViewMutationHistory(
    `${model.storeEpoch}:${model.databaseViewId}`,
  );
  const mutationHistory = providedMutationHistory ?? localMutationHistory;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inFlightScopesRef = useRef(new Set<string>());
  const previousProjectionRef = useRef<readonly DatabaseListProjectionRow[]>([]);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollDelayRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const lastScrollCommitAtRef = useRef(0);
  const pointerTimerRef = useRef<number | null>(null);
  const moveSessionIdRef = useRef(0);
  const restoredScrollStateKeyRef = useRef<string | null>(null);
  const lastReportedSelectionRef = useRef<{
    readonly handler: NonNullable<DatabaseListProps["onSelectedPageIdsChange"]>;
    readonly pageIds: ReadonlySet<string>;
  } | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const presentation = effectivePresentation?.presentation ?? model.query.view.config.presentation;
  const effective = effectivePresentation ?? {
    layout: "list" as const,
    rules: model.query.view.config.rules,
    presentation,
  };
  const usesCoreAuthority = model.authorization !== null;
  const coreWindow = useDatabaseListWindow({ model, effective });
  const grouped = presentation.group !== null;
  const subgrouped = presentation.subgroup !== null;
  const listConfig = presentation.display;
  const sessionListFields = useMemo(() => {
    return withForcedDatabaseListField(listConfig.fields, forcedDisplayField);
  }, [forcedDisplayField, listConfig.fields]);
  const requiredOptionIds = useMemo(() => {
    const displayedPropertyIds = new Set(
      sessionListFields.flatMap((field) =>
        field.kind === "property" ? [String(field.propertyId)] : [],
      ),
    );
    return collectRequiredPropertyOptionIds({
      properties: model.query.properties,
      rows: [
        ...model.query.rows,
        ...coreWindow.rows.flatMap((item) => (item.kind === "page" ? [item.row] : [])),
      ],
      propertyIds: displayedPropertyIds,
    });
  }, [coreWindow.rows, model.query.properties, model.query.rows, sessionListFields]);
  const propertyOptionRegistries = usePropertyOptionRegistries({
    accessContext: model.accessContext,
    properties: model.query.properties,
    requiredOptionIds,
  });
  const nested = presentation.hierarchy.showSubPages && presentation.hierarchy.nestedSubPages;
  const [localCollapsedOccurrenceKeys, setLocalCollapsedOccurrenceKeys] = useState<
    ReadonlySet<string>
  >(() => new Set(controlledCollapsedOccurrenceKeys ?? []));
  const collapsedOccurrenceKeys = useMemo(
    () =>
      controlledCollapsedOccurrenceKeys === undefined
        ? localCollapsedOccurrenceKeys
        : new Set(controlledCollapsedOccurrenceKeys),
    [controlledCollapsedOccurrenceKeys, localCollapsedOccurrenceKeys],
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [overscan, setOverscan] = useState(INITIAL_OVERSCAN);
  const [pointerSuppressed, setPointerSuppressed] = useState(false);
  const [dndActive, setDndActive] = useState(false);
  const [blockDropPreview, setBlockDropPreview] = useState<DatabaseListBlockDropPreview | null>(
    null,
  );
  const [blockDropMessage, setBlockDropMessage] = useState<string | null>(null);
  const [optimisticMove, setOptimisticMove] = useState<DatabaseListOptimisticMove | null>(null);
  const [pendingMutationCount, setPendingMutationCount] = useState(0);
  const [pendingMutationKeys, setPendingMutationKeys] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [inlineMutationErrors, setInlineMutationErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [continuationError, setContinuationError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pageDragInstanceId] = useState(() => Symbol("database-list-page-drag"));
  const mutationPending = pendingMutationCount > 0;
  const compiledSearchQuery = useMemo(
    () => compilePageCollectionSearchQuery(deferredSearchQuery),
    [deferredSearchQuery],
  );
  const columns = useMemo(() => {
    const projected = buildDatabaseViewColumns(
      model.query,
      presentation.group?.propertyId ?? null,
      listConfig.showEmptyGroups,
    ).map((column): DatabaseViewRenderColumn => ({
      ...column,
      name: groupLabel(model, presentation.group?.propertyId, column.groupKey),
      rows:
        compiledSearchQuery.normalizedQuery.length === 0
          ? column.rows
          : column.rows.filter((row) =>
              matchesPageCollectionSearchQuery(
                row.pageKey,
                normalizeSearchText(
                  `${row.title} ${row.preview} ${row.plainText} ${searchablePropertyValues(model, row.pageId, propertyOptionRegistries.options)}`,
                ),
                compiledSearchQuery,
              ),
            ),
    }));
    return presentation.groupDirection === "desc" ? [...projected].reverse() : projected;
  }, [
    listConfig.showEmptyGroups,
    model,
    presentation.group?.propertyId,
    presentation.groupDirection,
    propertyOptionRegistries.options,
    compiledSearchQuery,
  ]);
  const totalRowsByScope = useMemo(
    () =>
      new Map(
        columns.map((column) => [
          column.scopeKey,
          groupPagination?.get(column.scopeKey)?.totalRows ?? column.rows.length,
        ]),
      ),
    [columns, groupPagination],
  );
  const taskFilterCapabilities = useMemo(
    () => resolveDatabaseTaskFilterCapabilities(model.query.properties),
    [model.query.properties],
  );
  const statusOptions = taskFilterCapabilities.status?.options ?? [];
  const priorityOptions = taskFilterCapabilities.priority?.options ?? [];
  const clientProjection = useMemo(
    () =>
      buildDatabaseListProjection({
        columns,
        grouped,
        subgrouped,
        showSubPages: presentation.hierarchy.showSubPages,
        nested,
        collapsedOccurrenceKeys,
        totalRowsByScope,
      }),
    [
      collapsedOccurrenceKeys,
      columns,
      grouped,
      nested,
      presentation.hierarchy.showSubPages,
      subgrouped,
      totalRowsByScope,
    ],
  );
  const coreProjection = useMemo(
    () =>
      projectCoreDatabaseListRows({
        rows: coreWindow.rows,
        properties: model.query.properties,
        conditionalColors: presentation.conditionalColors,
        collapsedOccurrenceKeys,
        groupLabel: (key) => groupLabel(model, presentation.group?.propertyId, key),
        subgroupLabel: (key) => groupLabel(model, presentation.subgroup?.propertyId, key),
        ...(compiledSearchQuery.normalizedQuery.length === 0
          ? {}
          : {
              matchesPage: (row: DatabaseViewRenderRow, authority: DataSourcePageRowV2) =>
                matchesPageCollectionSearchQuery(
                  row.pageKey,
                  normalizeSearchText(
                    `${row.title} ${row.preview} ${row.plainText} ${searchableAuthorityValues(authority, model.query.properties, propertyOptionRegistries.options)}`,
                  ),
                  compiledSearchQuery,
                ),
            }),
      }),
    [
      collapsedOccurrenceKeys,
      coreWindow.rows,
      model,
      presentation.group?.propertyId,
      presentation.conditionalColors,
      presentation.subgroup?.propertyId,
      propertyOptionRegistries.options,
      compiledSearchQuery,
    ],
  );
  // Authorized runtime Views have exactly one ordering authority: Core's List
  // occurrence projection. Falling back to the Board query while that window
  // loads makes rows visibly reorder once or several times during handoff.
  const authoritativeProjection = resolveDatabaseListAuthority({
    coreAuthorized: usesCoreAuthority,
    coreRows: coreProjection.rows,
    clientRows: clientProjection,
  });
  // Recompute the optimistic hierarchy over each fresh authoritative row set,
  // so concurrent title/Property updates keep flowing during a pending move.
  const projection = useMemo(
    () =>
      optimisticMove
        ? applyOptimisticDatabaseListDrop({
            rows: authoritativeProjection,
            occurrenceKeys: optimisticMove.rootOccurrenceKeys,
            targetOccurrenceKey: optimisticMove.targetOccurrenceKey,
            position: optimisticMove.position,
            groupKey: optimisticMove.groupKey,
            subgroupKey: optimisticMove.subgroupKey,
          })
        : authoritativeProjection,
    [authoritativeProjection, optimisticMove],
  );
  const authorityByPageId = useMemo(() => {
    const authority = new Map(model.query.rows.map((row) => [row.page.pageId, row] as const));
    for (const [pageId, row] of coreProjection.authorityByPageId) {
      authority.set(pageId, row);
    }
    return authority;
  }, [coreProjection.authorityByPageId, model.query.rows]);
  const mutationModel = useMemo<DatabaseViewRenderModel>(() => {
    const orderedAuthority = new Map<string, DataSourcePageRowV2>();
    if (coreWindow.active) {
      for (const snapshot of coreWindow.rows) {
        if (snapshot.kind !== "page") continue;
        if (!orderedAuthority.has(snapshot.row.page.pageId)) {
          orderedAuthority.set(snapshot.row.page.pageId, snapshot.row);
        }
      }
    }
    for (const row of model.query.rows) {
      if (!orderedAuthority.has(row.page.pageId)) {
        orderedAuthority.set(row.page.pageId, row);
      }
    }
    return {
      ...model,
      query: {
        ...model.query,
        view: {
          ...model.query.view,
          layout: effective.layout,
          config: {
            ...model.query.view.config,
            presentation,
          },
        },
        rows: [...orderedAuthority.values()],
      },
    };
  }, [coreWindow.active, coreWindow.rows, effective.layout, model, presentation]);
  const mutationModelRef = useRef(mutationModel);
  mutationModelRef.current = mutationModel;
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;
  const coreWindowRef = useRef(coreWindow);
  coreWindowRef.current = coreWindow;
  const [interaction, dispatchInteraction] = useReducer(reduceDatabaseListInteraction, {
    selection: initialSelection(projection, initialSelectedPageIds),
    focusRequest: null,
  });
  const { focusRequest, selection } = interaction;
  const focusRequestIdRef = useRef(0);
  const updateSelection = (update: DatabaseListSelectionUpdate, requestFocus = false): void => {
    const focusRequestId = requestFocus ? ++focusRequestIdRef.current : undefined;
    dispatchInteraction({
      kind: "update-selection",
      update,
      focusRequestId,
    });
  };
  const allFields = useMemo(
    () => availableListFields(model, sessionListFields),
    [model, sessionListFields],
  );
  const selectedPropertyIds = useMemo(
    () =>
      new Set(
        sessionListFields.flatMap((field) =>
          field.kind === "property" ? [String(field.propertyId)] : [],
        ),
      ),
    [sessionListFields],
  );
  const activePropertyIds = useMemo(
    () =>
      new Set(
        model.query.properties.flatMap((property) =>
          property.lifecycle === "active" ? [String(property.propertyId)] : [],
        ),
      ),
    [model.query.properties],
  );
  const coreColumnVisibility = useMemo(
    () => ({
      priority: selectedPropertyIds.has("priority") && activePropertyIds.has("priority"),
      status: selectedPropertyIds.has("status") && activePropertyIds.has("status"),
    }),
    [activePropertyIds, selectedPropertyIds],
  );
  const identifierSamples = useMemo(
    () =>
      databaseListIdentifierSamples(projection, (row) =>
        row.kind === "page" ? row.row.pageKey : null,
      ),
    [projection],
  );
  const { identityFields, inlineFields, trailingFields, gridTemplateColumns } = useDatabaseListGrid(
    allFields,
    coreColumnVisibility,
    identifierSamples,
  );
  const pageIdentityByOccurrenceKey = useMemo(() => {
    const identities = new Map<string, DatabaseListPageIdentity>();
    for (const row of projection) {
      if (row.kind !== "page") continue;
      identities.set(row.key, projectDatabaseListPageIdentity(row.row.pageKey, identityFields));
    }
    return identities;
  }, [identityFields, projection]);
  const virtualWindow = useMemo(
    () =>
      computeDatabaseListVirtualWindow(
        projection,
        scrollTop,
        viewportHeight,
        dndActive ? Math.max(overscan, 1_200) : overscan,
      ),
    [dndActive, overscan, projection, scrollTop, viewportHeight],
  );
  const renderedRows = projection.slice(virtualWindow.startIndex, virtualWindow.endIndex);
  const mountedActiveOccurrenceKey = databaseListMountedActiveOccurrenceKey({
    rows: projection,
    startIndex: virtualWindow.startIndex,
    endIndex: virtualWindow.endIndex,
    activeOccurrenceKey: selection.activeOccurrenceKey,
  });
  const selectedPageIds = useMemo(
    () => selectedDatabaseListPageIds(projection, selection),
    [projection, selection],
  );
  const pageDragRows = useMemo(
    () => projection.flatMap((entry) => (entry.kind === "page" ? [entry.row] : [])),
    [projection],
  );
  const pageDragDisabled =
    model.readOnlyReason !== null ||
    !coreWindow.active ||
    optimisticMove !== null ||
    blockDropPreview !== null;
  const projectionIndexByKey = useMemo(
    () => new Map(projection.map((row, index) => [row.key, index] as const)),
    [projection],
  );
  const nestingContinuationsByKey = useMemo(
    () => databaseListNestingContinuations(projection),
    [projection],
  );
  const logicalExtraRows = usesCoreAuthority
    ? coreWindow.active && compiledSearchQuery.normalizedQuery.length === 0
      ? Math.max(0, coreWindow.totalProjectionRowCount - coreWindow.rows.length)
      : 0
    : [...(groupPagination?.values() ?? [])].reduce(
        (total, state) =>
          total + Math.max(0, (state.totalRows ?? state.loadedRows) - state.loadedRows),
        0,
      );
  const paginationError = usesCoreAuthority
    ? null
    : ([...(groupPagination?.values() ?? [])].find((state) => state.error !== null)?.error ?? null);
  const visibleError = mutationError ?? coreWindow.error ?? continuationError ?? paginationError;
  const activePage =
    projection.find(
      (row): row is DatabaseListPageRow =>
        row.kind === "page" && row.key === selection.activeOccurrenceKey,
    ) ?? null;
  const selectionCount =
    selection.allMatching && coreWindow.active
      ? coreWindow.isComplete
        ? selectedPageIds.size
        : coreWindow.totalModelCount
      : selectedPageIds.size;

  useEffect(() => {
    dispatchInteraction({
      kind: "update-selection",
      update: (current) =>
        syncDatabaseListSelection(current, projection, previousProjectionRef.current),
      preserveFocusRequest: true,
    });
    previousProjectionRef.current = projection;
  }, [projection]);

  useEffect(() => {
    if (!optimisticMove) return;
    const receiptCommitSeq = optimisticMove.receiptCommitSeq;
    if (
      receiptCommitSeq === null ||
      receiptCommitSeq === undefined ||
      !coreWindow.active ||
      coreWindow.storeEpoch !== model.storeEpoch ||
      coreWindow.commitSeq < receiptCommitSeq ||
      !optimisticMove.normalizedTarget ||
      !databaseListProjectionReflectsMove({
        rows: authoritativeProjection,
        moveRootPageIds: [...optimisticMove.rootPageIds],
        normalizedTarget: optimisticMove.normalizedTarget,
      })
    )
      return;
    setOptimisticMove(null);
  }, [
    authoritativeProjection,
    coreWindow.active,
    coreWindow.commitSeq,
    coreWindow.storeEpoch,
    model.storeEpoch,
    optimisticMove,
  ]);

  useEffect(() => {
    if (!onSelectedPageIdsChange) {
      lastReportedSelectionRef.current = null;
      return;
    }
    const previous = lastReportedSelectionRef.current;
    if (
      previous?.handler === onSelectedPageIdsChange &&
      samePageIds(previous.pageIds, selectedPageIds)
    ) {
      return;
    }
    lastReportedSelectionRef.current = {
      handler: onSelectedPageIdsChange,
      pageIds: selectedPageIds,
    };
    onSelectedPageIdsChange(selectedPageIds);
  }, [onSelectedPageIdsChange, selectedPageIds]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = (): void => setViewportHeight(scroller.clientHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => observer?.disconnect();
  }, [scrollStateKey]);

  useEffect(() => {
    if (projection.length === 0 || restoredScrollStateKeyRef.current === scrollStateKey) {
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let restoredTop: number | null = null;
    try {
      const rawAnchor = window.sessionStorage.getItem(`${scrollStateKey}:anchor`);
      if (rawAnchor) {
        const value = JSON.parse(rawAnchor) as {
          rowKey?: unknown;
          intraRowOffset?: unknown;
        };
        if (typeof value.rowKey === "string" && typeof value.intraRowOffset === "number") {
          restoredTop = restoreDatabaseListScrollTop(projection, {
            rowKey: value.rowKey,
            intraRowOffset: value.intraRowOffset,
          });
        }
      }
      if (restoredTop === null) {
        const legacyTop = Number(window.sessionStorage.getItem(`${scrollStateKey}:top`));
        if (Number.isFinite(legacyTop) && legacyTop > 0) restoredTop = legacyTop;
      }
    } catch {
      // Session restoration is best effort; Core data remains authoritative.
    }
    if (restoredTop !== null) {
      scroller.scrollTop = restoredTop;
      setScrollTop(restoredTop);
    }
    restoredScrollStateKeyRef.current = scrollStateKey;
  }, [projection, scrollStateKey]);

  useEffect(() => {
    let pass = 0;
    let cancel: () => void = () => undefined;
    const schedule = (): void => {
      cancel = idleCallback(() => {
        pass += 1;
        setOverscan(INITIAL_OVERSCAN + pass * IDLE_OVERSCAN_STEP);
        if (pass < IDLE_OVERSCAN_PASSES) schedule();
      });
    };
    schedule();
    return () => cancel();
  }, [model.databaseViewId]);

  useEffect(() => {
    if (!focusRequest) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = [
      ...(hostRef.current?.querySelectorAll<HTMLElement>("[data-list-key]") ?? []),
    ].find((candidate) => candidate.dataset.listKey === focusRequest.occurrenceKey);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
      dispatchInteraction({
        kind: "consume-focus-request",
        focusRequestId: focusRequest.id,
      });
      return;
    }
    const nextTop = databaseListScrollTopForOccurrence({
      rows: projection,
      occurrenceKey: focusRequest.occurrenceKey,
      viewportTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
    });
    if (nextTop === null || nextTop === scroller.scrollTop) {
      dispatchInteraction({
        kind: "consume-focus-request",
        focusRequestId: focusRequest.id,
      });
      return;
    }
    scroller.scrollTop = nextTop;
    setScrollTop(nextTop);
  }, [focusRequest, projection, virtualWindow.endIndex, virtualWindow.startIndex]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      if (scrollDelayRef.current !== null) window.clearTimeout(scrollDelayRef.current);
      if (pointerTimerRef.current !== null) window.clearTimeout(pointerTimerRef.current);
    },
    [],
  );

  const loadMoreGroup = async (scopeKey: string): Promise<void> => {
    if (!onLoadMoreGroup || inFlightScopesRef.current.has(scopeKey)) return;
    inFlightScopesRef.current.add(scopeKey);
    setContinuationError(null);
    try {
      await onLoadMoreGroup(scopeKey);
    } catch {
      setContinuationError("Couldn’t load the next List window.");
    } finally {
      inFlightScopesRef.current.delete(scopeKey);
    }
  };

  useEffect(() => {
    if (viewportHeight <= 0) return;
    const nearEnd = scrollTop + viewportHeight >= virtualWindow.totalHeight - 640;
    if (!nearEnd) return;
    if (usesCoreAuthority) {
      coreWindow.loadMore();
      return;
    }
    if (!onLoadMoreGroup) return;
    for (const pagination of groupPagination?.values() ?? []) {
      if (!pagination.hasMore || pagination.loadingMore) continue;
      void loadMoreGroup(pagination.scopeKey);
    }
    // Pagination functions intentionally read their latest in-flight refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    coreWindow.active,
    coreWindow.isComplete,
    coreWindow.loadingMore,
    coreWindow.nextCursor,
    groupPagination,
    onLoadMoreGroup,
    scrollTop,
    viewportHeight,
    virtualWindow.totalHeight,
    usesCoreAuthority,
  ]);

  const commit = async (
    operations: readonly DatabaseApplyOperationV2[],
    options: DatabaseListCommitOptions = {},
  ): Promise<DatabaseViewMutationReceipt | null> => {
    if (operations.length === 0) return null;
    const mutationKeys = [...new Set(options.mutationKeys ?? [])];
    setPendingMutationCount((current) => current + 1);
    setPendingMutationKeys((current) => updateMutationCounts(current, mutationKeys, 1));
    setMutationError(null);
    if (mutationKeys.length > 0) {
      setInlineMutationErrors((current) => {
        const next = new Map(current);
        for (const key of mutationKeys) next.delete(key);
        return next;
      });
    }
    try {
      const receipt = await commitOperations({
        model: options.modelOverride ?? mutationModel,
        operations,
      });
      await onCommitted?.();
      return receipt;
    } catch (cause) {
      const message = options.errorMessage ?? "Couldn’t update these pages. Refresh and try again.";
      if (options.deferError) {
        // A semantic caller may rebase once before surfacing the conflict.
      } else if (options.inlineError && mutationKeys.length > 0) {
        setInlineMutationErrors((current) => {
          const next = new Map(current);
          for (const key of mutationKeys) next.set(key, message);
          return next;
        });
      } else {
        setMutationError(message);
      }
      await onCommitted?.();
      if (options.propagateError) throw cause;
      return null;
    } finally {
      setPendingMutationCount((current) => Math.max(0, current - 1));
      setPendingMutationKeys((current) => updateMutationCounts(current, mutationKeys, -1));
    }
  };

  const isGroupComplete = (pageIds: readonly string[]): boolean => {
    if (usesCoreAuthority) {
      return coreWindow.active && !coreWindow.loading && coreWindow.isComplete;
    }
    const column = columns.find((candidate) =>
      pageIds.every((pageId) => candidate.rows.some((row) => row.pageId === pageId)),
    );
    return column ? groupPagination?.get(column.scopeKey)?.hasMore !== true : false;
  };

  const movePages = (
    pageIds: readonly string[],
    direction: "up" | "down" | "top" | "bottom",
  ): void => {
    try {
      const operations = buildDatabaseViewMovePageRunOperations({
        model: mutationModel,
        pageIds,
        direction,
        groupComplete: isGroupComplete(pageIds),
      });
      if (operations.length === 0) {
        setMutationError("This selection can’t be moved in the current ordering.");
        return;
      }
      void commit(operations, {
        mutationKeys: pageIds.map(pageMutationKey),
        errorMessage: "Couldn’t move this selection. Try again.",
      });
    } catch {
      setMutationError("This selection can’t be moved as one run.");
    }
  };

  const setProperty = (
    pageId: string,
    propertyId: "status" | "priority",
    value: string | null,
  ): void => {
    try {
      void commit(
        buildDatabaseViewPropertyValueOperations({
          model: mutationModel,
          pageId,
          propertyId,
          value,
        }),
        {
          mutationKeys: [propertyValueMutationKey(pageId, propertyId)],
          errorMessage: "Couldn’t save this property. Try again.",
          inlineError: true,
        },
      );
    } catch {
      setMutationError(`Couldn’t update this Page’s ${propertyId}.`);
    }
  };

  const setPropertyValue = (pageId: string, propertyId: string, value: DatabaseJsonValue): void => {
    try {
      void commit(
        buildDatabaseViewPropertyValueOperations({
          model: mutationModel,
          pageId,
          propertyId,
          value,
        }),
        {
          mutationKeys: [propertyValueMutationKey(pageId, propertyId)],
          errorMessage: "Couldn’t save this property. Try again.",
          inlineError: true,
        },
      );
    } catch {
      setMutationError("Couldn’t update this property.");
    }
  };

  const patchOptions = (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    delta: {
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    },
  ): void => {
    try {
      void commit(
        buildDataSourceMultiSelectPatchOperations({
          pageId,
          dataSourceId: model.dataSourceId,
          property,
          ...delta,
        }),
        {
          mutationKeys: [propertyValueMutationKey(pageId, property.propertyId)],
          errorMessage: "Couldn’t save this property. Try again.",
          inlineError: true,
        },
      );
    } catch {
      setMutationError("Couldn’t update this property.");
    }
  };

  const patchRelation = (
    pageId: string,
    propertyId: string,
    delta: {
      readonly addPageIds: readonly string[];
      readonly removeEdgeIds: readonly string[];
    },
  ): void => {
    void commit(
      [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId,
              dataSourceId: model.dataSourceId,
              propertyId: parseDataSourcePropertyId(propertyId),
              edit: { kind: "patch_set", delta: { kind: "relation", ...delta } },
            },
          ],
        },
      ],
      {
        mutationKeys: [propertyValueMutationKey(pageId, propertyId)],
        errorMessage: "Couldn’t save this property. Try again.",
        inlineError: true,
      },
    );
  };

  const replaceRelation = (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    targetPageId: string | null,
  ): void => {
    const current = authorityByPageId.get(pageId)?.values[property.propertyId];
    void commit(
      buildDataSourceRelationReplacementOperations({
        pageId,
        dataSourceId: model.dataSourceId,
        property,
        expectedValueRevision: current?.revision ?? 0,
        targetPageId,
      }),
      {
        mutationKeys: [propertyValueMutationKey(pageId, property.propertyId)],
        errorMessage: "Couldn’t save this property. Try again.",
        inlineError: true,
      },
    );
  };

  const createOption = async (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    option: { readonly optionId: string; readonly name: string; readonly color?: string },
  ): Promise<void> => {
    const current = authorityByPageId.get(pageId)?.values[property.propertyId];
    await commit(
      buildDataSourceCreateOptionAndSelectOperations({
        pageId,
        dataSourceId: model.dataSourceId,
        property,
        current,
        option: {
          id: option.optionId,
          name: option.name,
          ...(option.color === undefined ? {} : { color: option.color }),
        },
      }),
      {
        mutationKeys: [
          propertyDefinitionMutationKey(property.propertyId),
          propertyValueMutationKey(pageId, property.propertyId),
        ],
        errorMessage: "Couldn’t save this property. Try again.",
        inlineError: true,
        propagateError: true,
      },
    );
  };

  const propertyRuntime: DatabaseListPropertyRuntime = {
    disabled: model.readOnlyReason !== null,
    isPending: (pageId, propertyId) =>
      pendingMutationKeys.has(propertyValueMutationKey(pageId, propertyId)) ||
      pendingMutationKeys.has(propertyDefinitionMutationKey(propertyId)),
    errorFor: (pageId, propertyId) =>
      inlineMutationErrors.get(propertyValueMutationKey(pageId, propertyId)) ??
      inlineMutationErrors.get(propertyDefinitionMutationKey(propertyId)) ??
      null,
    options: propertyOptionRegistries.options,
    optionStates: propertyOptionRegistries.states,
    optionHasMore: propertyOptionRegistries.hasMore,
    optionLoadingMore: propertyOptionRegistries.loadingMore,
    relationCandidates: () =>
      [...authorityByPageId.values()].map((row) => ({
        pageId: row.page.pageId,
        title: row.page.title,
      })),
    onSetValue: setPropertyValue,
    onPatchOptions: patchOptions,
    onPatchRelation: patchRelation,
    onReplaceOneRelation: replaceRelation,
    onCreateOption: createOption,
    onRequestOptions: propertyOptionRegistries.requestOptions,
    onRequestMoreOptions: propertyOptionRegistries.requestMoreOptions,
    onLoadRelationTargets: async (pageId, property, after) =>
      await readDataSourceRelationTargets({
        accessContext: model.accessContext,
        pageId,
        property,
        after,
      }),
    onSearchRelationCandidates: async (property, query, after) =>
      await searchDataSourceRelationCandidates({
        accessContext: model.accessContext,
        property,
        query,
        after,
      }),
    onLoadRelationTargetDescriptor: async (property) =>
      await readDataSourceRelationTargetDescriptor({
        accessContext: model.accessContext,
        property,
      }),
    onOpenRelationPage: (pageId, title) => {
      onOpenPage(pageId, title, "preview");
    },
    onRelationValueStale: () => void onCommitted?.(),
  };

  const undoListMove = async (recipe: DatabaseListMoveUndoRecipeV2): Promise<boolean> => {
    try {
      const receipt = await commit(
        [
          {
            kind: "undo_list_occurrence_move",
            recipe,
          },
        ],
        {
          mutationKeys: recipe.postParentGuards.map((guard) => pageMutationKey(guard.pageId)),
          errorMessage: "Couldn’t safely undo this List move.",
          propagateError: true,
        },
      );
      return receipt !== null;
    } catch {
      setMutationError("This move can’t be undone because one of its Pages changed afterward.");
      return false;
    }
  };

  const dropPages = (drop: DatabaseListDndCommit): void => {
    const windowState = coreWindowRef.current;
    if (!windowState.active || !windowState.projection) {
      setMutationError("Wait for the authoritative List to finish loading before dragging.");
      return;
    }
    const previewPlacement = resolveDatabaseListDragPreviewPlacement({
      rows: authoritativeProjection,
      target: drop.previewTarget,
    });
    if (!previewPlacement) {
      setMutationError("This drop target is no longer available.");
      return;
    }
    if (
      !databaseListDragTargetChangesPlacement({
        rows: authoritativeProjection,
        sources: drop.sources,
        target: drop.previewTarget,
      })
    ) {
      setMutationError(null);
      return;
    }
    const optimistic: DatabaseListOptimisticMove = {
      sessionId: ++moveSessionIdRef.current,
      rootOccurrenceKeys: new Set(drop.sources.rootRows.map((row) => row.key)),
      rootPageIds: new Set(drop.sources.rootRows.map((row) => row.pageId)),
      targetOccurrenceKey: previewPlacement.targetOccurrenceKey,
      position: previewPlacement.position,
      groupKey: previewPlacement.groupKey,
      subgroupKey: previewPlacement.subgroupKey,
      receiptCommitSeq: null,
      normalizedTarget: null,
    };
    setOptimisticMove(optimistic);
    setMutationError(null);
    void (async () => {
      let attemptWindow: DatabaseListWindowState = windowState;
      for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
        const latestProjection = attemptWindow.projection;
        if (!attemptWindow.active || !latestProjection) break;
        const operation: DatabaseApplyOperationV2 = {
          kind: "move_list_occurrences",
          viewId: model.databaseViewId,
          preferencesOverride: databaseListPreferencesOverride(effectiveRef.current),
          expectedProjection: {
            scopeKey: latestProjection.scopeKey,
            schemaVersion: latestProjection.schemaVersion,
            revision: latestProjection.revision,
            coveredCommitSeq: latestProjection.coveredCommitSeq,
            effectHash: latestProjection.effectHash,
          },
          initiatorOccurrenceKey: drop.initiatorOccurrenceKey,
          selection: drop.sources.selection,
          target: drop.target,
        };
        try {
          const receipt = await commit([operation], {
            mutationKeys: drop.sources.rootRows.map((row) => pageMutationKey(row.pageId)),
            errorMessage: "Couldn’t move these Pages. Try again.",
            propagateError: true,
            deferError: attemptIndex === 0,
            modelOverride: mutationModelRef.current,
          });
          const outcome = receipt?.operationOutcomes.find(
            (candidate) =>
              candidate.kind === "list_occurrence_move" && candidate.operationIndex === 0,
          );
          if (!receipt || !outcome || outcome.kind !== "list_occurrence_move") {
            throw new Error("The List move receipt omitted its semantic outcome");
          }
          mutationHistory.registerListMove(outcome.undoRecipe);
          setOptimisticMove((current) =>
            current && current.sessionId === optimistic.sessionId
              ? {
                  ...current,
                  receiptCommitSeq: receipt.commitSeq,
                  normalizedTarget: outcome.normalizedTarget,
                }
              : current,
          );
          return;
        } catch (cause) {
          const canRebase =
            attemptIndex === 0 &&
            cause instanceof DatabaseViewMutationError &&
            cause.commandError.code === "revision_conflict";
          if (!canRebase) break;
          attemptWindow = await coreWindowRef.current.refresh();
        }
      }
      setOptimisticMove((current) =>
        current?.sessionId === optimistic.sessionId ? null : current,
      );
      setMutationError("Couldn’t move these Pages. Review the latest hierarchy and try again.");
    })();
  };

  const updateCollapsedOccurrences = (
    updates: readonly { readonly key: string; readonly collapsed: boolean }[],
  ): void => {
    const next = new Set(collapsedOccurrenceKeys);
    for (const update of updates) {
      if (update.collapsed) next.add(update.key);
      else next.delete(update.key);
      onOccurrenceDisclosureChange?.(
        { kind: "group", occurrenceKey: update.key },
        update.collapsed,
      );
    }
    if (controlledCollapsedOccurrenceKeys === undefined) {
      setLocalCollapsedOccurrenceKeys(next);
    }
  };

  const toggleCollapseKey = (key: string): void =>
    updateCollapsedOccurrences([
      {
        key,
        collapsed: !collapsedOccurrenceKeys.has(key),
      },
    ]);

  const mutationHistoryProjectId =
    model.accessContext.kind === "project" ? model.accessContext.projectId : null;

  const blockDropRejection = (): string | null =>
    resolveDatabaseListBlockDropRejection({
      pageDragActive: dndActive,
      readOnly: model.readOnlyReason !== null,
      projectScoped: mutationHistoryProjectId !== null,
      searchActive: compiledSearchQuery.normalizedQuery.length > 0,
      projectionReady:
        coreWindow.active &&
        coreWindow.storeEpoch === model.storeEpoch &&
        coreWindow.projection !== null,
    });

  const previewBlockDrop = (
    event: ReactDragEvent<HTMLDivElement>,
  ): DatabaseListBlockDropPreview | null => {
    const eventTarget = event.target instanceof Element ? event.target : null;
    const rowElement = eventTarget?.closest<HTMLElement>("[data-list-key]") ?? null;
    const bounds = rowElement?.getBoundingClientRect();
    return resolveDatabaseListBlockDropPreview({
      rows: projection,
      overOccurrenceKey: rowElement?.dataset.listKey ?? null,
      pointerY: event.clientY,
      rowTop: bounds?.top ?? event.clientY,
      rowBottom: bounds?.bottom ?? event.clientY,
      exactSlot: databaseViewSupportsSortedSlotInference(mutationModel),
    });
  };

  const handleBlockDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!shouldHandleNativeCrossSurfaceDrag(event.dataTransfer)) return;
    if (!hasDragType(event.dataTransfer, NODEX_BLOCK_TRANSFER_DRAG_MIME)) return;
    const rejection = blockDropRejection();
    if (rejection) {
      event.dataTransfer.dropEffect = "none";
      setBlockDropPreview(null);
      setBlockDropMessage(rejection);
      return;
    }
    const preview = previewBlockDrop(event);
    if (!preview) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = resolveCrossSurfaceTransferMode(event);
    setBlockDropPreview(preview);
    const session = resolveLocalBlockDragOverSession(event.dataTransfer);
    const promotionMessage = session
      ? summarizeBlockPagePromotionPreview({
          mode: resolveCrossSurfaceTransferMode(event),
          rootCount: session.payload.rootBlockIds.length,
          hints: session.taskShorthandPreviewHints ?? [],
          literal: !readTaskShorthandPagePromotionEnabled() || event.shiftKey,
        })
      : "";
    setBlockDropMessage([promotionMessage, preview.message].filter(Boolean).join(" · "));
  };

  const handleBlockDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!shouldHandleNativeCrossSurfaceDrag(event.dataTransfer)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setBlockDropPreview(null);
    setBlockDropMessage(null);
  };

  const handleBlockDrop = async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    const session = resolveLocalBlockDragDropSession(event.dataTransfer);
    if (!session) return;
    const rejection = blockDropRejection();
    if (rejection) {
      event.preventDefault();
      event.stopPropagation();
      endLocalBlockDragSession({ sessionId: session.sessionId });
      setBlockDropPreview(null);
      setBlockDropMessage(null);
      toast.info(rejection);
      return;
    }
    const preview = previewBlockDrop(event);
    const expectedProjection = coreWindow.projection;
    if (!preview || !expectedProjection) return;
    event.preventDefault();
    event.stopPropagation();
    setBlockDropPreview(null);
    setBlockDropMessage(null);
    await commitDatabaseViewBlockDrop({
      session,
      projectId: mutationHistoryProjectId,
      storeEpoch: model.storeEpoch,
      dataSourceId: model.dataSourceId,
      placement: {
        kind: "list_occurrence",
        viewId: model.databaseViewId,
        preferencesOverride: databaseListPreferencesOverride(effectiveRef.current),
        expectedProjection,
        target: preview.target,
      },
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      mutationHistory,
      onCommitted: async () => await onCommitted?.(),
    });
  };

  useEffect(() => {
    setBlockDropPreview(null);
    setBlockDropMessage(null);
  }, [coreWindow.projection, projection]);

  useEffect(() => {
    if (!blockDropPreview && !blockDropMessage) return;
    const clear = (): void => {
      setBlockDropPreview(null);
      setBlockDropMessage(null);
    };
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, [blockDropMessage, blockDropPreview]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || dndActive) return;
    if (
      handleDatabaseViewMutationHistoryKeyDown({
        event,
        history: mutationHistory,
        undoListMove,
        undoBlockTransfer: mutationHistoryProjectId
          ? async (token) =>
              await undoDatabaseViewBlockTransfer({
                projectId: mutationHistoryProjectId,
                storeEpoch: model.storeEpoch,
                token,
                onCommitted,
              })
          : undefined,
      })
    )
      return;
    if ((event.target as HTMLElement).closest(DATABASE_LIST_INTERACTIVE_SELECTOR)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      updateSelection(
        (current) =>
          moveDatabaseListActiveOccurrence({
            state: current,
            rows: projection,
            direction: event.key === "ArrowDown" ? 1 : -1,
            extendSelection: event.shiftKey,
          }),
        true,
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      updateSelection(
        (current) =>
          moveDatabaseListActiveOccurrenceToBoundary({
            state: current,
            rows: projection,
            boundary: event.key === "Home" ? "first" : "last",
            extendSelection: event.shiftKey,
          }),
        true,
      );
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      updateSelection((current) =>
        selectAllDatabaseListOccurrences({
          state: current,
          rows: projection,
        }),
      );
      return;
    }
    if (event.key === " " && activePage) {
      event.preventDefault();
      updateSelection((current) =>
        selectDatabaseListOccurrence({
          state: current,
          rows: projection,
          occurrenceKey: activePage.key,
          mode: "toggle",
        }),
      );
      return;
    }
    if (event.key === "Enter" && activePage) {
      event.preventDefault();
      onOpenPage(activePage.pageId, activePage.row.title, "preview");
      return;
    }
    if (
      event.key === "Escape" &&
      (selection.allMatching || selection.selectedOccurrenceKeys.size > 0)
    ) {
      event.preventDefault();
      updateSelection((current) => ({
        ...current,
        selectedOccurrenceKeys: new Set(),
        allMatching: false,
        excludedOccurrenceKeys: new Set(),
        anchorOccurrenceKey: null,
      }));
      return;
    }
    if (event.key.toLowerCase() !== "t") return;
    event.preventDefault();
    if (event.altKey) {
      const collapsibleKeys = projection.flatMap((row) => (row.kind === "group" ? [row.key] : []));
      const collapse = !collapsibleKeys.some((key) => collapsedOccurrenceKeys.has(key));
      updateCollapsedOccurrences(
        collapsibleKeys
          .filter((key) => collapsedOccurrenceKeys.has(key) !== collapse)
          .map((key) => ({ key, collapsed: collapse })),
      );
      return;
    }
    if (!activePage || !grouped) return;
    toggleCollapseKey(databaseListGroupKey(activePage.groupKey));
  };

  const renderPage = (item: DatabaseListPageRow, logicalIndex: number) => {
    const authority = authorityByPageId.get(item.pageId);
    if (!authority) return null;
    const selected = isDatabaseListOccurrenceSelected(selection, item.key);
    const projectionIndex = projectionIndexByKey.get(item.key) ?? -1;
    const previousRow = projection[projectionIndex - 1];
    const nextRow = projection[projectionIndex + 1];
    const selectedBefore =
      previousRow?.kind === "page" && isDatabaseListOccurrenceSelected(selection, previousRow.key);
    const selectedAfter =
      nextRow?.kind === "page" && isDatabaseListOccurrenceSelected(selection, nextRow.key);
    const row = (
      <DatabaseListRow
        key={item.key}
        item={item}
        libraryId={model.libraryId}
        selected={selected}
        selectedBefore={selectedBefore}
        selectedAfter={selectedAfter}
        active={mountedActiveOccurrenceKey === item.key}
        presented={presentedPageIds?.has(item.pageId) ?? false}
        inlineProperties={
          <DatabaseListInlineProperties
            fields={inlineFields}
            properties={model.query.properties}
            authority={authority}
            runtime={propertyRuntime}
          />
        }
        trailingCells={
          <DatabaseListTrailingPropertyCells fields={trailingFields} authority={authority} />
        }
        ariaRowIndex={logicalIndex + 1}
        onSelect={(mode) =>
          updateSelection((current) =>
            selectDatabaseListOccurrence({
              state: current,
              rows: projection,
              occurrenceKey: item.key,
              mode,
            }),
          )
        }
        onActivate={() =>
          updateSelection((current) =>
            current.activeOccurrenceKey === item.key
              ? current
              : { ...current, activeOccurrenceKey: item.key },
          )
        }
        onOpen={(titleSnapshot, openMode) => {
          onOpenPage(item.pageId, titleSnapshot, openMode);
        }}
        statusOptions={statusOptions}
        priorityOptions={priorityOptions}
        onSetStatus={(optionId) => setProperty(item.pageId, "status", optionId)}
        onSetPriority={(optionId) => setProperty(item.pageId, "priority", optionId)}
        statusMutationDisabled={
          model.readOnlyReason !== null ||
          pendingMutationKeys.has(propertyValueMutationKey(item.pageId, "status"))
        }
        priorityMutationDisabled={
          model.readOnlyReason !== null ||
          pendingMutationKeys.has(propertyValueMutationKey(item.pageId, "priority"))
        }
        showPriority={coreColumnVisibility.priority}
        showStatus={coreColumnVisibility.status}
        identity={pageIdentityByOccurrenceKey.get(item.key) ?? EMPTY_DATABASE_LIST_PAGE_IDENTITY}
        nestingContinuations={nestingContinuationsByKey.get(item.key) ?? []}
        externalDropEdge={
          blockDropPreview?.feedback.kind === "line" &&
          blockDropPreview.feedback.occurrenceKey === item.key
            ? blockDropPreview.feedback.edge
            : null
        }
        pragmaticDragData={
          pageDragDisabled || item.transientKind !== "none"
            ? null
            : buildDatabaseViewPageDragData({
                model: mutationModel,
                row: item.row,
                allRows: pageDragRows,
                selectedPageIds,
                instanceId: pageDragInstanceId,
              })
        }
        pageAccessProjectId={
          model.accessContext.kind === "project" ? model.accessContext.projectId : null
        }
        pageChatActivity={pageChatActivityByPageId.get(item.pageId)}
        onOpenRelatedChat={pageActionPort?.openRelatedChat}
        onRemovePageChatRelation={(sessionId) => onRemovePageChatRelation(item.pageId, sessionId)}
      />
    );
    return row;
  };

  const resolvePageMenuSession = (targetKey: string): DatabaseViewPageMenuSession | null => {
    const item = projection.find(
      (candidate): candidate is DatabaseListPageRow =>
        candidate.kind === "page" && candidate.key === targetKey,
    );
    if (!item) return null;
    const authority = authorityByPageId.get(item.pageId);
    if (!authority) return null;
    const groupComplete = isGroupComplete([item.pageId]);
    const propertySource: DataSourcePagePropertyMenuSource = {
      descriptors: model.query.properties.map((property) => ({
        property,
        disabled: propertyRuntime.disabled,
        pending: propertyRuntime.isPending(item.pageId, property.propertyId),
      })),
      resolveBinding(propertyId) {
        const property = model.query.properties.find(
          (candidate) => candidate.propertyId === propertyId,
        );
        if (!property) throw new Error(`Unknown List Property: ${propertyId}`);
        return createDatabaseListPropertyEditorBinding(property, authority, propertyRuntime);
      },
    };
    return {
      page: {
        libraryId: model.libraryId,
        accessContext: model.accessContext,
        projectId: model.accessContext.kind === "project" ? model.accessContext.projectId : null,
        pageId: item.pageId,
        pageKey: item.row.pageKey,
        titleSnapshot: item.row.title,
      },
      canMoveUp: canMoveDatabaseViewPage({
        model: mutationModel,
        pageId: item.pageId,
        direction: "up",
        groupComplete,
      }),
      canMoveDown: canMoveDatabaseViewPage({
        model: mutationModel,
        pageId: item.pageId,
        direction: "down",
        groupComplete,
      }),
      propertySource,
      actionPort: pageActionPort,
      deleteDisabled: model.readOnlyReason !== null,
      onMove: (direction) => movePages([item.pageId], direction),
    };
  };

  const selectedIds = [...selectedPageIds];
  const canMoveSelection = (direction: "up" | "down"): boolean => {
    if (selection.allMatching && usesCoreAuthority && !coreWindow.isComplete) return false;
    try {
      return (
        buildDatabaseViewMovePageRunOperations({
          model: mutationModel,
          pageIds: selectedIds,
          direction,
          groupComplete: isGroupComplete(selectedIds),
        }).length > 0
      );
    } catch {
      return false;
    }
  };
  const canMoveSelectionUp = canMoveSelection("up");
  const canMoveSelectionDown = canMoveSelection("down");

  return (
    <DatabaseListDndProvider
      rows={projection}
      selection={selection}
      scrollerRef={scrollerRef}
      disabled={pageDragDisabled}
      overlayColumns={{
        priority: coreColumnVisibility.priority,
        identifier: identityFields.length > 0,
        status: coreColumnVisibility.status,
      }}
      onActiveChange={setDndActive}
      onCommit={dropPages}
    >
      <DatabaseViewPageContextMenuHost resolveSession={resolvePageMenuSession}>
        <div
          ref={hostRef}
          data-database-view-id={model.databaseViewId}
          data-page-create-surface-id={pageCreateSurfaceId}
          className={cn(
            "relative h-full min-h-0 min-w-0 bg-[var(--database-list-surface)] text-[var(--database-list-text-primary)]",
            DATABASE_LIST_THEME_CLASS_NAME,
          )}
        >
          <div
            ref={scrollerRef}
            role="grid"
            aria-label="Database List"
            aria-rowcount={projection.length + logicalExtraRows}
            aria-busy={mutationPending || coreWindow.loading || undefined}
            data-list-container="true"
            className={cn(
              "h-full min-h-0 overflow-auto overscroll-contain [scrollbar-gutter:stable]",
              selectionCount > 0 ? "pb-16" : "pb-2",
              pointerSuppressed && !dndActive && "[&_[data-list-row=true]]:pointer-events-none",
            )}
            onKeyDown={handleKeyDown}
            onDragEnter={handleBlockDragOver}
            onDragOver={handleBlockDragOver}
            onDragLeave={handleBlockDragLeave}
            onDrop={(event) => {
              void handleBlockDrop(event);
            }}
            onScroll={(event) => {
              const nextTop = event.currentTarget.scrollTop;
              latestScrollTopRef.current = nextTop;
              const flushScroll = (): void => {
                scrollDelayRef.current = null;
                scrollFrameRef.current = requestAnimationFrame(() => {
                  const committedTop = latestScrollTopRef.current;
                  lastScrollCommitAtRef.current = performance.now();
                  setScrollTop(committedTop);
                  try {
                    window.sessionStorage.setItem(`${scrollStateKey}:top`, String(committedTop));
                    const anchor = captureDatabaseListScrollAnchor(projection, committedTop);
                    if (anchor) {
                      window.sessionStorage.setItem(
                        `${scrollStateKey}:anchor`,
                        JSON.stringify(anchor),
                      );
                    }
                  } catch {
                    // A blocked session store must not affect List scrolling.
                  }
                  scrollFrameRef.current = null;
                });
              };
              if (scrollFrameRef.current === null && scrollDelayRef.current === null) {
                const elapsed = performance.now() - lastScrollCommitAtRef.current;
                if (elapsed >= 50) flushScroll();
                else {
                  scrollDelayRef.current = window.setTimeout(flushScroll, 50 - elapsed);
                }
              }
              setPointerSuppressed(true);
              if (pointerTimerRef.current !== null) window.clearTimeout(pointerTimerRef.current);
              pointerTimerRef.current = window.setTimeout(() => {
                setPointerSuppressed(false);
                pointerTimerRef.current = null;
              }, 100);
            }}
          >
            {visibleError ? (
              <div
                role="alert"
                className="sticky top-0 z-20 mx-2 mb-2 flex min-h-8 items-center justify-between gap-3 rounded-lg border border-token-error-foreground/15 bg-token-error-background/90 px-2.5 text-xs text-token-error-foreground backdrop-blur"
              >
                <span>{visibleError}</span>
                {coreWindow.error || continuationError || paginationError ? (
                  <NodexButton
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      if (coreWindow.error) {
                        coreWindow.retry();
                        return;
                      }
                      setContinuationError(null);
                      for (const pagination of groupPagination?.values() ?? []) {
                        if (pagination.hasMore) void loadMoreGroup(pagination.scopeKey);
                      }
                    }}
                  >
                    Retry
                  </NodexButton>
                ) : null}
              </div>
            ) : null}
            {projection.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-token-description-foreground">
                {usesCoreAuthority && coreWindow.loading
                  ? "Loading Pages…"
                  : compiledSearchQuery.normalizedQuery.length > 0
                    ? "No matching Pages"
                    : "No Pages in this View"}
              </div>
            ) : (
              <div
                data-list-layout-grid="true"
                className="grid min-w-[320px] items-stretch gap-x-2"
                style={{ gridTemplateColumns } as CSSProperties}
              >
                {virtualWindow.paddingStart > 0 ? (
                  <div
                    aria-hidden="true"
                    className="col-span-full"
                    style={{ height: virtualWindow.paddingStart }}
                  />
                ) : null}
                {renderedRows.map((item, renderedIndex) => {
                  const logicalIndex = virtualWindow.startIndex + renderedIndex;
                  if (item.kind === "page") return renderPage(item, logicalIndex);
                  if (item.kind === "subgroup") {
                    return (
                      <DatabaseListGroupDropTarget
                        item={item}
                        key={item.key}
                        role="row"
                        aria-rowindex={logicalIndex + 1}
                        data-list-row="true"
                        data-list-key={item.key}
                        data-database-list-block-drop={
                          blockDropPreview?.feedback.kind === "surface" &&
                          blockDropPreview.feedback.occurrenceKey === item.key
                            ? "true"
                            : undefined
                        }
                        className="sticky top-[35.5px] z-[9] grid h-8 items-center gap-x-2 bg-[var(--database-list-surface)] [grid-template-columns:subgrid] [grid-column:1/-1]"
                      >
                        <div
                          role="gridcell"
                          className={cn(
                            "mx-2 grid h-8 items-center gap-x-2 rounded-lg bg-[var(--database-list-subgroup)] [grid-template-columns:subgrid] [grid-column:1/-1]",
                            blockDropPreview?.feedback.kind === "surface" &&
                              blockDropPreview.feedback.occurrenceKey === item.key &&
                              "ring-1 ring-inset ring-[var(--database-list-drop-indicator)]",
                          )}
                        >
                          <span aria-hidden="true" style={{ gridColumn: "indent" }} />
                          <span
                            className="flex items-center justify-center text-[var(--database-list-text-muted)]"
                            style={{ gridColumn: "checkbox" }}
                          >
                            {databaseListGroupMarker(
                              presentation.subgroup?.propertyId,
                              item.subgroupKey,
                            )}
                          </span>
                          <span
                            className="flex min-w-0 items-center gap-2"
                            style={{ gridColumn: "identifier / list-end" }}
                          >
                            <span className="truncate text-xs font-medium text-[var(--database-list-group-text)]">
                              {groupLabel(
                                model,
                                presentation.subgroup?.propertyId,
                                item.subgroupKey,
                              )}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-[var(--database-list-group-count)]">
                              {item.totalRows}
                            </span>
                          </span>
                        </div>
                      </DatabaseListGroupDropTarget>
                    );
                  }
                  const resolvedGroupLabel = groupLabel(
                    model,
                    presentation.group?.propertyId,
                    item.groupKey,
                  );
                  const groupCreateAction =
                    model.readOnlyReason === null &&
                    presentation.group?.propertyId === "status" &&
                    isWorkflowStatus(item.groupKey) &&
                    onRequestCreatePage
                      ? { status: item.groupKey, request: onRequestCreatePage }
                      : null;
                  return (
                    <DatabaseListGroupDropTarget
                      item={item}
                      key={item.key}
                      role="row"
                      aria-rowindex={logicalIndex + 1}
                      data-list-row="true"
                      data-list-key={item.key}
                      data-database-list-block-drop={
                        blockDropPreview?.feedback.kind === "surface" &&
                        blockDropPreview.feedback.occurrenceKey === item.key
                          ? "true"
                          : undefined
                      }
                      className="sticky top-[-0.5px] z-10 mb-0.5 grid h-9 items-center gap-x-2 bg-[var(--database-list-surface)] [grid-template-columns:subgrid] [grid-column:1/-1]"
                    >
                      <div
                        role="gridcell"
                        data-list-group-divider="true"
                        className={cn(
                          "mx-2 grid h-9 items-center gap-x-2 overflow-hidden rounded-lg pr-2 [grid-template-columns:subgrid] [grid-column:1/-1]",
                          blockDropPreview?.feedback.kind === "surface" &&
                            blockDropPreview.feedback.occurrenceKey === item.key &&
                            "ring-1 ring-inset ring-[var(--database-list-drop-indicator)]",
                        )}
                        style={{
                          background:
                            "linear-gradient(90deg, var(--database-list-group-start) 0%, var(--database-list-group-end) 100%), var(--database-list-group-end)",
                        }}
                      >
                        <span aria-hidden="true" style={{ gridColumn: "indent" }} />
                        <button
                          type="button"
                          aria-expanded={!item.collapsed}
                          aria-label={`${item.collapsed ? "Expand" : "Collapse"} ${resolvedGroupLabel}`}
                          className="grid size-7 place-items-center rounded-full text-[var(--database-list-text-muted)] outline-none hover:bg-[var(--database-list-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--database-list-focus)]"
                          style={{ gridColumn: "checkbox" }}
                          onClick={() => toggleCollapseKey(item.key)}
                        >
                          <DatabaseListDisclosureIcon open={!item.collapsed} />
                        </button>
                        {coreColumnVisibility.priority ? (
                          <span
                            className="flex size-4 items-center justify-center text-[var(--database-list-text-muted)]"
                            style={{ gridColumn: "priority" }}
                          >
                            {databaseListGroupMarker(presentation.group?.propertyId, item.groupKey)}
                          </span>
                        ) : null}
                        <span
                          className="flex min-w-0 items-center gap-2"
                          style={{ gridColumn: "identifier / list-end" }}
                        >
                          {!coreColumnVisibility.priority
                            ? databaseListGroupMarker(presentation.group?.propertyId, item.groupKey)
                            : null}
                          <span className="truncate text-[13px] font-medium leading-[normal] text-[var(--database-list-group-text)]">
                            {resolvedGroupLabel}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-[var(--database-list-group-count)]">
                            {item.totalRows}
                          </span>
                          {groupCreateAction ? (
                            <NodexButton
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Create new Page"
                              data-page-create-trigger="header"
                              data-page-create-column-id={groupCreateAction.status}
                              className="ml-auto size-6 rounded-full px-0.5 text-[var(--database-list-text-muted)]"
                              onClick={() => groupCreateAction.request(groupCreateAction.status)}
                            >
                              <DatabaseListPlusIcon />
                            </NodexButton>
                          ) : null}
                        </span>
                      </div>
                    </DatabaseListGroupDropTarget>
                  );
                })}
                {virtualWindow.paddingEnd > 0 ? (
                  <div
                    aria-hidden="true"
                    className="col-span-full"
                    style={{ height: virtualWindow.paddingEnd }}
                  />
                ) : null}
              </div>
            )}
            {coreWindow.loadingMore ||
            (!usesCoreAuthority &&
              [...(groupPagination?.values() ?? [])].some((state) => state.loadingMore)) ? (
              <div
                role="status"
                className="flex h-8 items-center justify-center gap-1.5 text-xs text-token-description-foreground"
              >
                <ActivitySpinnerIcon className="icon-2xs" />
                Loading more…
              </div>
            ) : null}
          </div>
          {blockDropPreview?.feedback.kind === "surface" &&
          blockDropPreview.feedback.occurrenceKey === null ? (
            <div
              aria-hidden="true"
              data-database-list-block-drop-root="true"
              className="pointer-events-none absolute inset-1 z-[18] rounded-lg ring-1 ring-inset ring-[var(--database-list-drop-indicator)]"
            />
          ) : null}
          {blockDropMessage ? (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute right-3 top-2 z-20 bg-[var(--database-list-surface)] px-1.5 py-1 text-xs text-[var(--database-list-text-muted)] shadow-sm"
            >
              {blockDropMessage}
            </div>
          ) : null}
          <DatabaseListSelectionActionBar
            count={selectionCount}
            canMoveUp={canMoveSelectionUp}
            canMoveDown={canMoveSelectionDown}
            onMove={(direction) => movePages(selectedIds, direction)}
            onClear={() =>
              updateSelection((current) => ({
                ...current,
                selectedOccurrenceKeys: new Set(),
                allMatching: false,
                excludedOccurrenceKeys: new Set(),
                anchorOccurrenceKey: null,
              }))
            }
          />
        </div>
      </DatabaseViewPageContextMenuHost>
    </DatabaseListDndProvider>
  );
}
