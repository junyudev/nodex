import {
  CoreApiError,
  readDatabaseViewGroups,
  readDatabaseViewWindow,
  subscribeBoardChanges,
} from "./api";
import type { BoardSummary, DatabasePage, PageInput, DatabasePageSummary } from "./types";
import type {
  DatabaseViewGroupScopeInput,
  DatabaseViewGroupsInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewWindowInput,
  DatabaseViewWindowSnapshot,
} from "../../shared/database-views";
import type {
  DatabaseViewPreferencesOverride,
  DatabaseViewPresentationOverride,
  DatabaseViewRulesOverride,
} from "../../shared/database-kernel";
import {
  buildPatchPageTransform,
  conflictKeysForPatch,
  overlap,
  type BoardTransform,
} from "./board-optimistic-ops";
import { toDatabasePageSummary } from "../../shared/page-summary";
import {
  applyBoardChangeEventToBoard,
  boardSummariesEqual,
  rebuildBoardFromRankedRows,
  removePageSummaryFromBoard,
  upsertCardSummaryInBoard,
} from "./board-summary-events";
import type { BoardChangeEvent } from "../../shared/ipc-api";
import {
  UNGROUPED_SCOPE_KEY,
  buildDatabaseViewWindowRenderModel,
  groupScopeKeyForColumn,
  groupScopeKeyForPath,
  type DatabaseViewRenderModel,
} from "./database-view-render-model";
import { getRendererProjectionInvalidationRegistry } from "./projection-invalidation-service";
import type {
  ProjectionInvalidationCause,
  ProjectionInvalidationRegistry,
  ProjectionRevocationMessage,
} from "./projection-invalidation-registry";
import {
  projectionCoordinateFromSnapshot,
  type ProjectionCoordinate,
  type ProjectionEffect,
} from "../../shared/projection-stream";
import { CausalProjectionRuntime, type ProjectionRepairRequest } from "./causal-projection-runtime";
import { projectCoreDatabaseQueryRow } from "../../shared/core-database-row-projection";
import {
  fenceDatabaseRowDetailsForProject,
  revokeDatabaseRowDetail,
} from "./database-row-detail-store";
import { mapWithConcurrency } from "./map-with-concurrency";
import { databaseViewPrimaryManualOrderDirection } from "../../shared/database-view-presentation";
import {
  beginRendererOwnerTrace,
  recordRendererOwnerTrace,
  rendererCausalTrace,
  type RendererCausalTrace,
  type RendererCausalTraceContext,
} from "./renderer-causal-trace";

const DEFAULT_BOARD_FRESHNESS_MS = 30_000;
const GROUP_WINDOW_FIRST = 50;
const GROUP_WINDOW_MAX_FIRST = 200;
const CONSISTENT_WINDOW_READ_ATTEMPTS = 4;
const MAX_RETAINED_BOARD_STORES = 32;
const GROUP_WINDOW_READ_CONCURRENCY = 8;

const changesProjectionCoordinate = (override: DatabaseViewPreferencesOverride | null): boolean =>
  Boolean(
    override &&
    (Object.keys(override.rulesOverride).length > 0 ||
      Object.prototype.hasOwnProperty.call(override.presentationOverride, "group") ||
      Object.prototype.hasOwnProperty.call(override.presentationOverride, "subgroup") ||
      override.presentationOverride.groupDirection !== undefined ||
      override.presentationOverride.completion !== undefined ||
      override.presentationOverride.hierarchy !== undefined ||
      override.presentationOverride.display !== undefined),
  );

export interface IndexedPage extends DatabasePageSummary {
  columnId: string;
  columnName: string;
  boardIndex: number;
}

/**
 * Stable key of one independently paged group window; see the definitions in
 * `database-view-render-model.ts`, which every render column also carries.
 */
export type GroupWindowScopeKey = string;

export { UNGROUPED_SCOPE_KEY, groupScopeKeyForColumn };

export interface ColumnPaginationState {
  readonly scopeKey: GroupWindowScopeKey;
  readonly loadedRows: number;
  readonly totalRows: number | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
}

export interface BoardStoreSnapshot {
  board: BoardSummary | null;
  databaseView: DatabaseViewRenderModel | null;
  pageIndex: ReadonlyMap<string, IndexedPage>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  pendingMutationCount: number;
  lastMutationError: string | null;
  /** Stable while the exact canonical materialization candidate is unchanged. */
  materializationRenderToken: number | null;
  groupPagination: ReadonlyMap<GroupWindowScopeKey, ColumnPaginationState>;
  totalRows: number | null;
}

/**
 * Cursor carried by a direct local projection delta. The delta may be applied
 * before the full Database View projection has caught up, so it must still
 * participate in the same store-epoch/commit-seq ordering rules as a read.
 */
export interface LocalProjectionCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

export interface OptimisticMutationResult<T> {
  ok: boolean;
  result?: T;
  error?: Error;
  superseded: boolean;
  opId: number;
}

type StoreListener = () => void;

type ReadViewWindowFn = (
  projectId: string,
  input: DatabaseViewWindowInput,
) => Promise<DatabaseViewWindowSnapshot>;
type ReadViewGroupsFn = (
  projectId: string,
  input: DatabaseViewGroupsInput,
) => Promise<DatabaseViewGroupsSnapshot>;
type SubscribeBoardChangesFn = (
  projectId: string,
  callback: (event: BoardChangeEvent) => void,
) => () => void;
type NowFn = () => number;

export interface BoardStoreDependencies {
  readViewWindow: ReadViewWindowFn;
  readViewGroups: ReadViewGroupsFn;
  subscribeBoardChanges: SubscribeBoardChangesFn;
  getProjectionInvalidationRegistry: () => ProjectionInvalidationRegistry | null;
  now: NowFn;
  causalTrace: RendererCausalTrace;
}

export interface EnsureFreshBoardOptions {
  maxAgeMs?: number;
  force?: boolean;
}

export interface LocalOverlayOptions {
  kind: string;
  conflictKeys: string[];
  apply: BoardTransform;
}

/** A pure optimistic transform replayed over each fresh Database View read. */
export type DatabaseViewTransform = (model: DatabaseViewRenderModel) => DatabaseViewRenderModel;

export interface RunOptimisticMutationOptions<T> {
  kind: string;
  /** Durable command identity when the outer workflow already owns one. */
  operationIdentity?: string;
  conflictKeys: string[];
  apply: BoardTransform;
  applyDatabaseView?: DatabaseViewTransform;
  runRemote: () => Promise<T>;
  /** Serializes commands whose Core intent is compiled from shared authority. */
  remoteLane?: string;
  getCommitCursor?: (result: T) => LocalProjectionCursor | null | undefined;
  /**
   * Proves that a cursor-covered bounded View has materialized the resource
   * needed to hand rendering back to canonical authority. A commit floor alone
   * is insufficient because the affected row can sit outside the loaded span.
   */
  isCommitMaterialized?: (canonicalBoard: BoardSummary) => boolean;
  isDatabaseViewCommitMaterialized?: (canonicalModel: DatabaseViewRenderModel) => boolean;
  refreshOnSuccess?: boolean;
  refreshOnFailure?: boolean;
  suppressErrorWhenSuperseded?: boolean;
}

export interface RunOptimisticDatabaseViewMutationOptions<T> {
  kind: string;
  /** Durable command identity when the outer workflow already owns one. */
  operationIdentity?: string;
  conflictKeys: string[];
  apply: DatabaseViewTransform;
  runRemote: (canonicalModel: DatabaseViewRenderModel) => Promise<T>;
  /** Serializes commands whose Core intent is compiled from shared authority. */
  remoteLane?: string;
  getCommitCursor?: (result: T) => LocalProjectionCursor | null | undefined;
  isCommitMaterialized?: (canonicalModel: DatabaseViewRenderModel) => boolean;
  refreshOnSuccess?: boolean;
  refreshOnFailure?: boolean;
  suppressErrorWhenSuperseded?: boolean;
}

interface RunOptimisticPatchOptions<T> {
  columnId: string;
  pageId: string;
  updates: Partial<PageInput>;
  runRemote: () => Promise<T>;
}

interface OptimisticEntry {
  opId: number;
  kind: string;
  conflictKeys: string[];
  apply: BoardTransform;
  applyDatabaseView: DatabaseViewTransform | null;
  phase: "pending" | "acknowledged" | "local";
  commitCursor: LocalProjectionCursor | null;
  isCommitMaterialized: ((canonicalBoard: BoardSummary) => boolean) | null;
  isDatabaseViewCommitMaterialized: ((canonicalModel: DatabaseViewRenderModel) => boolean) | null;
  minimumMaterializationGeneration: number | null;
  superseded: boolean;
  readonly trace: RendererCausalTraceContext | null;
}

interface MaterializationRenderCandidate {
  readonly operationIds: readonly number[];
  readonly board: BoardSummary | null;
  readonly databaseView: DatabaseViewRenderModel | null;
  readonly token: number;
}

const defaultDependencies: BoardStoreDependencies = {
  readViewWindow: readDatabaseViewWindow,
  readViewGroups: readDatabaseViewGroups,
  subscribeBoardChanges,
  getProjectionInvalidationRegistry: getRendererProjectionInvalidationRegistry,
  now: () => Date.now(),
  causalTrace: rendererCausalTrace,
};

function buildPageIndex(board: BoardSummary | null): ReadonlyMap<string, IndexedPage> {
  if (!board) return new Map();

  const index = new Map<string, IndexedPage>();
  for (let columnIndex = 0; columnIndex < board.columns.length; columnIndex += 1) {
    const column = board.columns[columnIndex];
    if (!column) continue;

    for (let pageIndex = 0; pageIndex < column.cards.length; pageIndex += 1) {
      const card = column.cards[pageIndex];
      if (!card) continue;

      index.set(card.id, {
        ...card,
        columnId: column.id,
        columnName: column.name,
        boardIndex: columnIndex * 100_000 + pageIndex,
      });
    }
  }

  return index;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error("Unknown error");
}

interface GroupWindowScope {
  readonly scopeKey: GroupWindowScopeKey;
  readonly scope: DatabaseViewGroupScopeInput | null;
}

interface GroupWindowState {
  readonly scope: DatabaseViewGroupScopeInput | null;
  readonly snapshot: DatabaseViewWindowSnapshot;
  readonly loadingMore: boolean;
  readonly inlineError: string | null;
}

type ProjectionSnapshot = Pick<DatabaseViewWindowSnapshot, "storeEpoch" | "projection">;

const hasSameProjectionAuthority = (left: ProjectionSnapshot, right: ProjectionSnapshot): boolean =>
  left.storeEpoch === right.storeEpoch &&
  left.projection.scopeKey === right.projection.scopeKey &&
  left.projection.schemaVersion === right.projection.schemaVersion &&
  left.projection.revision === right.projection.revision &&
  left.projection.effectHash === right.projection.effectHash;

const scopeContainsGroup = (
  scope: DatabaseViewGroupScopeInput | null,
  groupKey: string | null,
  subgroupKey: string | null,
): boolean => {
  if (scope === null) return true;
  return scope.groupKey === groupKey && scope.subgroupKey === subgroupKey;
};

const scopesFromGroups = (groups: DatabaseViewGroupsSnapshot): GroupWindowScope[] => {
  if (groups.truncated) {
    return [{ scopeKey: UNGROUPED_SCOPE_KEY, scope: null }];
  }
  if (!groups.grouped) {
    return [{ scopeKey: UNGROUPED_SCOPE_KEY, scope: null }];
  }
  return groups.groups.map((group) => ({
    scopeKey: groupScopeKeyForPath(group.groupKey, group.subgroupKey),
    scope: {
      kind: "path",
      groupKey: group.groupKey,
      subgroupKey: group.subgroupKey,
    },
  }));
};

const mergeBoards = (boards: readonly BoardSummary[]): BoardSummary => {
  const first = boards[0];
  if (!first) return { columns: [] };
  const seenCards = new Set<string>();
  return {
    columns: first.columns.map((column) => ({
      ...column,
      cards: boards.flatMap((board) =>
        (board.columns.find((candidate) => candidate.id === column.id)?.cards ?? []).filter(
          (card) => {
            if (seenCards.has(card.id)) return false;
            seenCards.add(card.id);
            return true;
          },
        ),
      ),
    })),
  };
};

/**
 * Composes the loaded group windows into one snapshot for the existing render
 * pipeline (board summary, render model, optimistic transforms). Continuation
 * state stays per group; the merged snapshot never exposes a global cursor.
 * The invalidation cursor is the oldest window's, so no event is skipped.
 */
const mergeGroupWindows = (
  windows: readonly DatabaseViewWindowSnapshot[],
): DatabaseViewWindowSnapshot | null => {
  const first = windows[0];
  if (!first) return null;
  const projection = first.projection;
  if (
    windows.some(
      (window) =>
        window.storeEpoch !== first.storeEpoch ||
        window.projection.scopeKey !== projection.scopeKey ||
        window.projection.schemaVersion !== projection.schemaVersion ||
        window.projection.revision !== projection.revision ||
        window.projection.effectHash !== projection.effectHash,
    )
  ) {
    throw new Error("Database View windows crossed a projection revision");
  }
  const seenRows = new Set<string>();
  const rows = windows.flatMap((window) =>
    window.rows.filter((row) => {
      if (seenRows.has(row.page.id)) return false;
      seenRows.add(row.page.id);
      return true;
    }),
  );
  const seenQueryRows = new Set<string>();
  const queryRows = windows.flatMap((window) =>
    window.query.rows.filter((row) => {
      if (seenQueryRows.has(row.page.pageId)) return false;
      seenQueryRows.add(row.page.pageId);
      return true;
    }),
  );
  return {
    ...first,
    commitSeq: Math.min(...windows.map((window) => window.commitSeq)),
    projection: {
      ...projection,
      coveredCommitSeq: Math.min(...windows.map((window) => window.projection.coveredCommitSeq)),
    },
    nextCursor: null,
    rows,
    board: mergeBoards(windows.map((window) => window.board)),
    query: { ...first.query, rows: queryRows },
  };
};

const groupPaginationEquals = (
  left: ReadonlyMap<GroupWindowScopeKey, ColumnPaginationState>,
  right: ReadonlyMap<GroupWindowScopeKey, ColumnPaginationState>,
): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [scopeKey, state] of left) {
    const other = right.get(scopeKey);
    if (
      !other ||
      other.loadedRows !== state.loadedRows ||
      other.totalRows !== state.totalRows ||
      other.hasMore !== state.hasMore ||
      other.loadingMore !== state.loadingMore ||
      other.error !== state.error
    ) {
      return false;
    }
  }
  return true;
};

const appendWindow = (
  current: DatabaseViewWindowSnapshot,
  next: DatabaseViewWindowSnapshot,
): DatabaseViewWindowSnapshot => {
  if (!hasSameProjectionAuthority(current, next) || current.viewId !== next.viewId) {
    throw new Error("Database View continuation crossed a projection revision");
  }
  const existingIds = new Set(current.rows.map((row) => row.page.id));
  return {
    ...next,
    rows: [...current.rows, ...next.rows.filter((row) => !existingIds.has(row.page.id))],
    board: mergeBoards([current.board, next.board]),
    query: {
      ...next.query,
      rows: [
        ...current.query.rows,
        ...next.query.rows.filter((row) => !existingIds.has(row.page.pageId)),
      ],
    },
  };
};

class BoardProjectStore {
  private readonly listeners = new Set<StoreListener>();

  private snapshot: BoardStoreSnapshot = {
    board: null,
    databaseView: null,
    pageIndex: new Map(),
    loading: true,
    loadingMore: false,
    hasMore: false,
    error: null,
    pendingMutationCount: 0,
    lastMutationError: null,
    materializationRenderToken: null,
    groupPagination: new Map(),
    totalRows: null,
  };

  private baseBoard: BoardSummary | null = null;

  private baseBoardAuthority: DatabaseViewWindowSnapshot | null = null;

  private baseDatabaseView: DatabaseViewRenderModel | null = null;

  private groupWindows = new Map<GroupWindowScopeKey, GroupWindowState>();

  private groupsSnapshot: DatabaseViewGroupsSnapshot | null = null;

  private optimisticEntries: OptimisticEntry[] = [];

  private materializationRenderCandidate: MaterializationRenderCandidate | null = null;

  private nextMaterializationRenderToken = 0;

  private readonly remoteLanes = new Map<string, Promise<boolean>>();

  private nextOpId = 1;

  private inFlightFetch: Promise<boolean> | null = null;

  private unsubscribeBoardChanges: (() => void) | null = null;

  private releaseActiveProjectionInvalidation: (() => void) | null = null;

  private releaseRetainedProjectionInvalidation: (() => void) | null = null;

  private causalProjectionRuntime: CausalProjectionRuntime | null = null;

  private requiredMinimumCommitSeq = 0;

  private requiredMinimumStoreEpoch: string | null = null;

  private canonicalReadGeneration = 0;

  private requiredRefreshGeneration = 0;

  private completedRefreshGeneration = 0;

  private lastFetchedAt = 0;

  private stale = true;

  private preferencesOverride: DatabaseViewPreferencesOverride | null = null;

  /**
   * Presentation refreshes keep the last readable projection on screen while
   * Core builds the replacement. This generation separates that retained
   * projection from authority fetched for the current presentation, so the
   * two are never compared as revisions of the same query.
   */
  private presentationGeneration = 0;

  private basePresentationGeneration = 0;

  private revocationGeneration = 0;

  /** Invalidates commands queued against authority from a replaced Store. */
  private authorityGeneration = 0;

  constructor(
    private readonly projectId: string,
    private readonly databaseViewId: string | null,
    private readonly dependencies: BoardStoreDependencies,
    private readonly onAccess: () => void,
    private readonly onInactive: () => void,
  ) {}

  setPreferencesOverride(preferencesOverride: DatabaseViewPreferencesOverride | null): void {
    if (JSON.stringify(this.preferencesOverride) === JSON.stringify(preferencesOverride)) return;
    this.preferencesOverride = preferencesOverride;
    this.presentationGeneration += 1;
    this.revocationGeneration += 1;
    this.requiredRefreshGeneration += 1;
    this.stale = true;
    // A presentation can select a different projection coordinate. Rebind the
    // complete registration/runtime pair so an existing registration can
    // never retain causal authority for the previous query.
    this.releaseActiveProjectionInvalidation?.();
    this.releaseRetainedProjectionInvalidation?.();
    this.releaseActiveProjectionInvalidation = null;
    this.releaseRetainedProjectionInvalidation = null;
    this.disposeCausalProjectionRuntime();
    // A personal presentation edit is a background replacement, not a
    // revocation. Keep the last readable snapshot until all first windows for
    // the new presentation can replace it atomically.
    this.recomputeSnapshot({ loading: false, error: null });
    if (this.listeners.size > 0) void this.fetchBoard();
  }

  setPresentationOverride(presentationOverride: DatabaseViewPresentationOverride | null): void {
    this.setPreferencesOverride({
      rulesOverride: this.preferencesOverride?.rulesOverride ?? {},
      presentationOverride: presentationOverride ?? {},
    });
  }

  setRulesOverride(rulesOverride: DatabaseViewRulesOverride | null): void {
    this.setPreferencesOverride({
      rulesOverride: rulesOverride ?? {},
      presentationOverride: this.preferencesOverride?.presentationOverride ?? {},
    });
  }

  getSnapshot = (): BoardStoreSnapshot => this.snapshot;

  /** Settles only the acknowledged entries represented by the current React commit. */
  markRendered = (renderToken: number): void => {
    const candidate = this.materializationRenderCandidate;
    if (!candidate || candidate.token !== renderToken) return;

    const materializedOperationIds = new Set(candidate.operationIds);
    this.materializationRenderCandidate = null;
    for (const entry of this.optimisticEntries) {
      if (!materializedOperationIds.has(entry.opId)) continue;
      recordRendererOwnerTrace(
        entry.trace,
        { kind: "rendered", reason: "render_handoff", renderToken },
        this.dependencies.causalTrace,
      );
      recordRendererOwnerTrace(
        entry.trace,
        { kind: "settled", reason: "proof_complete" },
        this.dependencies.causalTrace,
      );
    }
    this.optimisticEntries = this.optimisticEntries.filter(
      (entry) => !materializedOperationIds.has(entry.opId),
    );
    this.recomputeSnapshot();
  };

  subscribe = (listener: StoreListener): (() => void) => {
    this.onAccess();
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.ensureRealtimeSubscription();
      void this.ensureFreshBoard();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;

      this.teardownBoardChangesSubscription();
      this.ensureProjectionSubscription("retained");
      this.onInactive();
    };
  };

  isActive(): boolean {
    return this.listeners.size > 0;
  }

  disposeIfInactive(): boolean {
    if (this.listeners.size > 0 || this.optimisticEntries.length > 0 || this.remoteLanes.size > 0)
      return false;
    this.teardownRealtimeSubscription();
    this.clearInactiveAuthority();
    return true;
  }

  private disposeCausalProjectionRuntime(): void {
    this.causalProjectionRuntime?.dispose();
    this.causalProjectionRuntime = null;
  }

  private clearInactiveAuthority(): void {
    this.authorityGeneration += 1;
    this.revocationGeneration += 1;
    this.baseBoard = null;
    this.baseBoardAuthority = null;
    this.baseDatabaseView = null;
    this.groupWindows.clear();
    this.groupsSnapshot = null;
    this.inFlightFetch = null;
    this.revokeEntries("store_reset");
    this.optimisticEntries = [];
    this.materializationRenderCandidate = null;
    this.disposeCausalProjectionRuntime();
    this.requiredMinimumCommitSeq = 0;
    this.requiredMinimumStoreEpoch = null;
    this.canonicalReadGeneration = 0;
    this.presentationGeneration = 0;
    this.basePresentationGeneration = 0;
    this.requiredRefreshGeneration = 0;
    this.completedRefreshGeneration = 0;
    this.lastFetchedAt = 0;
    this.stale = true;
    this.setSnapshot({
      board: null,
      databaseView: null,
      pageIndex: new Map(),
      loading: true,
      loadingMore: false,
      hasMore: false,
      error: null,
      pendingMutationCount: 0,
      lastMutationError: null,
      materializationRenderToken: null,
      groupPagination: new Map(),
      totalRows: null,
    });
  }

  private fenceStoreEpochReplacement(): void {
    this.authorityGeneration += 1;
    this.remoteLanes.clear();
    this.revokeEntries("store_reset");
    this.optimisticEntries = [];
    this.materializationRenderCandidate = null;
    this.disposeCausalProjectionRuntime();
    this.requiredMinimumCommitSeq = 0;
    this.requiredMinimumStoreEpoch = null;
    this.releaseActiveProjectionInvalidation?.();
    this.releaseRetainedProjectionInvalidation?.();
    this.releaseActiveProjectionInvalidation = null;
    this.releaseRetainedProjectionInvalidation = null;
    fenceDatabaseRowDetailsForProject(this.projectId);
  }

  private requireMinimumCursor(minimum: number | LocalProjectionCursor): void {
    const cursor =
      typeof minimum === "number"
        ? minimum > 0
          ? {
              storeEpoch:
                this.requiredMinimumStoreEpoch ?? this.baseBoardAuthority?.storeEpoch ?? null,
              commitSeq: minimum,
            }
          : null
        : minimum;
    if (!cursor) return;
    if (cursor.storeEpoch === null) {
      this.requiredMinimumCommitSeq = Math.max(this.requiredMinimumCommitSeq, cursor.commitSeq);
      return;
    }
    if (this.requiredMinimumStoreEpoch !== cursor.storeEpoch) {
      this.requiredMinimumStoreEpoch = cursor.storeEpoch;
      this.requiredMinimumCommitSeq = cursor.commitSeq;
      return;
    }
    this.requiredMinimumCommitSeq = Math.max(this.requiredMinimumCommitSeq, cursor.commitSeq);
  }

  private windowInputBase(
    minimumCommitSeq = 0,
    minimumStoreEpoch: string | null = null,
  ): DatabaseViewWindowInput {
    const minimum =
      minimumStoreEpoch && minimumCommitSeq > 0
        ? {
            minimumCommitCursor: {
              storeEpoch: minimumStoreEpoch,
              commitSeq: minimumCommitSeq,
            },
          }
        : minimumCommitSeq > 0
          ? { minimumCommitSeq }
          : {};
    return this.databaseViewId
      ? {
          databaseViewId: this.databaseViewId,
          ...(this.preferencesOverride ? { preferencesOverride: this.preferencesOverride } : {}),
          ...minimum,
        }
      : minimum;
  }

  private groupsInput(
    minimumCommitSeq = 0,
    minimumStoreEpoch: string | null = null,
  ): DatabaseViewGroupsInput {
    const minimum =
      minimumStoreEpoch && minimumCommitSeq > 0
        ? {
            minimumCommitCursor: {
              storeEpoch: minimumStoreEpoch,
              commitSeq: minimumCommitSeq,
            },
          }
        : minimumCommitSeq > 0
          ? { minimumCommitSeq }
          : {};
    return this.databaseViewId
      ? {
          databaseViewId: this.databaseViewId,
          ...(this.preferencesOverride ? { preferencesOverride: this.preferencesOverride } : {}),
          ...minimum,
        }
      : minimum;
  }

  /** Span-preserving first-window size: a refresh re-reads what was loaded. */
  private firstForScope(scopeKey: GroupWindowScopeKey): number {
    const loaded = this.groupWindows.get(scopeKey)?.snapshot.rows.length ?? 0;
    return Math.min(Math.max(GROUP_WINDOW_FIRST, loaded), GROUP_WINDOW_MAX_FIRST);
  }

  private async readScopedWindow(
    scope: GroupWindowScope,
    first: number,
    after?: string,
    minimumCommitSeq = 0,
    minimumStoreEpoch: string | null = null,
  ): Promise<DatabaseViewWindowSnapshot> {
    return await this.dependencies.readViewWindow(this.projectId, {
      ...this.windowInputBase(minimumCommitSeq, minimumStoreEpoch),
      ...(scope.scope ? { groupScope: scope.scope } : {}),
      ...(after ? { after } : {}),
      first,
    });
  }

  private async readConsistentFirstWindows(
    minimumCommitSeq: number,
    minimumStoreEpoch: string | null,
  ): Promise<{
    readonly groups: DatabaseViewGroupsSnapshot;
    readonly windows: readonly {
      readonly scope: GroupWindowScope;
      readonly snapshot: DatabaseViewWindowSnapshot;
    }[];
  }> {
    let floor = minimumCommitSeq;
    for (let attempt = 0; attempt < CONSISTENT_WINDOW_READ_ATTEMPTS; attempt += 1) {
      const groups = await this.dependencies.readViewGroups(
        this.projectId,
        this.groupsInput(floor, minimumStoreEpoch),
      );
      const scopes = scopesFromGroups(groups);
      // An empty grouped View still needs one window for its descriptor.
      const fetchScopes: GroupWindowScope[] =
        scopes.length > 0 ? scopes : [{ scopeKey: UNGROUPED_SCOPE_KEY, scope: null }];
      const windows = await mapWithConcurrency(
        fetchScopes,
        GROUP_WINDOW_READ_CONCURRENCY,
        async (scope) => ({
          scope,
          snapshot: await this.readScopedWindow(
            scope,
            this.firstForScope(scope.scopeKey),
            undefined,
            floor,
            minimumStoreEpoch,
          ),
        }),
      );
      if (windows.every(({ snapshot }) => hasSameProjectionAuthority(groups, snapshot))) {
        return { groups, windows };
      }
      floor = Math.max(
        floor,
        groups.commitSeq,
        groups.projection.coveredCommitSeq,
        ...windows.flatMap(({ snapshot }) => [
          snapshot.commitSeq,
          snapshot.projection.coveredCommitSeq,
        ]),
      );
    }
    throw new Error("Database View changed faster than a consistent window snapshot could be read");
  }

  private rebuildFromGroups(): void {
    const merged = mergeGroupWindows(
      [...this.groupWindows.values()].map((group) => group.snapshot),
    );
    this.baseBoardAuthority = merged;
    this.baseBoard = merged?.board ?? null;
    this.baseDatabaseView = merged ? buildDatabaseViewWindowRenderModel(merged) : null;
  }

  private fetchBoardOnce = async (
    minimumCommitSeq: number,
    minimumStoreEpoch: string | null,
    refreshGeneration: number,
  ): Promise<boolean> => {
    const revocationGeneration = this.revocationGeneration;
    const presentationGeneration = this.presentationGeneration;
    let succeeded = false;
    const hasReadableBase = this.databaseViewId
      ? this.baseDatabaseView !== null
      : this.baseBoard !== null;
    const shouldShowLoading = !hasReadableBase && !this.snapshot.loading;
    if (shouldShowLoading) {
      this.setSnapshot({
        ...this.snapshot,
        loading: true,
      });
    }

    try {
      const { groups, windows } = await this.readConsistentFirstWindows(
        minimumCommitSeq,
        minimumStoreEpoch,
      );
      if (revocationGeneration !== this.revocationGeneration) {
        succeeded = true;
        return true;
      }
      const retainedAuthority = this.baseBoardAuthority;
      const currentAuthority =
        this.basePresentationGeneration === presentationGeneration ? retainedAuthority : null;
      const incomingAuthority = windows[0]?.snapshot;
      const storeEpochChanged = Boolean(
        retainedAuthority &&
        incomingAuthority &&
        incomingAuthority.storeEpoch !== retainedAuthority.storeEpoch,
      );
      const crossedRequestedEpoch = Boolean(
        minimumStoreEpoch &&
        incomingAuthority &&
        incomingAuthority.storeEpoch !== minimumStoreEpoch,
      );
      if (storeEpochChanged || crossedRequestedEpoch) {
        // Epochs have independent commit coordinates. Replace every derived
        // authority seam atomically so old receipts can never replay over the
        // freshly opened Store.
        this.fenceStoreEpochReplacement();
      }
      const incomingSeq = Math.min(...windows.map((window) => window.snapshot.commitSeq));
      if (!storeEpochChanged && !crossedRequestedEpoch && incomingSeq < minimumCommitSeq) {
        throw new Error(`Database View read did not reach local commit ${minimumCommitSeq}`);
      }
      if (
        currentAuthority &&
        incomingAuthority &&
        incomingAuthority.storeEpoch === currentAuthority.storeEpoch &&
        incomingAuthority.projection.scopeKey === currentAuthority.projection.scopeKey &&
        (incomingAuthority.projection.revision < currentAuthority.projection.revision ||
          (incomingAuthority.projection.revision === currentAuthority.projection.revision &&
            incomingAuthority.projection.coveredCommitSeq <
              currentAuthority.projection.coveredCommitSeq))
      ) {
        // Every fetched window predates what is already on screen; keep the
        // newer state and only refresh bookkeeping.
        this.lastFetchedAt = this.dependencies.now();
        this.stale = false;
        this.ensureProjectionSubscription();
        this.recomputeSnapshot({ loading: false, error: null });
        succeeded = true;
        return true;
      }
      if (
        currentAuthority &&
        incomingAuthority &&
        incomingAuthority.storeEpoch === currentAuthority.storeEpoch &&
        incomingAuthority.projection.scopeKey === currentAuthority.projection.scopeKey &&
        incomingAuthority.projection.revision === currentAuthority.projection.revision &&
        currentAuthority.projection.effectHash !== null &&
        incomingAuthority.projection.effectHash !== null &&
        incomingAuthority.projection.effectHash !== currentAuthority.projection.effectHash
      ) {
        throw new Error("Database View canonical read conflicts with its projection revision");
      }
      this.groupsSnapshot = groups;
      this.groupWindows = new Map(
        windows.map(({ scope, snapshot }) => [
          scope.scopeKey,
          {
            scope: scope.scope,
            snapshot,
            loadingMore: false,
            inlineError: null,
          },
        ]),
      );
      this.rebuildFromGroups();
      this.basePresentationGeneration = presentationGeneration;
      this.canonicalReadGeneration += 1;
      this.lastFetchedAt = this.dependencies.now();
      this.stale = false;
      this.ensureProjectionSubscription();
      this.recomputeSnapshot({
        loading: false,
        error: null,
      });
      succeeded = true;
      return true;
    } catch (error) {
      this.stale = true;
      this.recomputeSnapshot({
        loading: false,
        error: toError(error).message,
      });
      return false;
    } finally {
      if (succeeded) {
        this.completedRefreshGeneration = Math.max(
          this.completedRefreshGeneration,
          refreshGeneration,
        );
      }
    }
  };

  fetchBoard = async (minimum: number | LocalProjectionCursor = 0): Promise<boolean> => {
    this.requireMinimumCursor(minimum);
    while (true) {
      const requestedMinimumCommitSeq = this.requiredMinimumCommitSeq;
      const requestedMinimumStoreEpoch = this.requiredMinimumStoreEpoch;
      const requestedRefreshGeneration = this.requiredRefreshGeneration;
      let succeeded: boolean;
      if (this.inFlightFetch) {
        succeeded = await this.inFlightFetch;
      } else {
        const inFlight = this.fetchBoardOnce(
          requestedMinimumCommitSeq,
          requestedMinimumStoreEpoch,
          requestedRefreshGeneration,
        );
        this.inFlightFetch = inFlight;
        try {
          succeeded = await inFlight;
        } finally {
          if (this.inFlightFetch === inFlight) this.inFlightFetch = null;
        }
      }
      if (!succeeded) return false;
      if (
        this.requiredMinimumStoreEpoch === requestedMinimumStoreEpoch &&
        this.requiredMinimumCommitSeq <= requestedMinimumCommitSeq &&
        this.completedRefreshGeneration >= requestedRefreshGeneration
      )
        return true;
    }
  };

  /**
   * Silently converges one group from its first window, preserving the loaded
   * span. This is the consumer half of the cursor contract: a rejected
   * continuation is disposable read state, never a user-facing failure.
   */
  private refetchGroup = async (scopeKey: GroupWindowScopeKey): Promise<void> => {
    const group = this.groupWindows.get(scopeKey);
    if (!group) return;
    try {
      const snapshot = await this.readScopedWindow(
        { scopeKey, scope: group.scope },
        this.firstForScope(scopeKey),
        undefined,
        group.snapshot.commitSeq,
        group.snapshot.storeEpoch,
      );
      const current = this.groupWindows.get(scopeKey);
      if (!current) return;
      if (!hasSameProjectionAuthority(snapshot, current.snapshot)) {
        this.stale = true;
        await this.fetchBoard({
          storeEpoch: snapshot.storeEpoch,
          commitSeq: snapshot.projection.coveredCommitSeq,
        }).catch(() => {});
        return;
      }
      if (snapshot.commitSeq < current.snapshot.commitSeq) {
        return;
      }
      this.groupWindows = new Map(this.groupWindows).set(scopeKey, {
        ...current,
        snapshot,
        inlineError: null,
      });
      this.rebuildFromGroups();
      this.recomputeSnapshot();
    } catch (error) {
      this.setGroupState(scopeKey, { inlineError: toError(error).message });
    }
  };

  private setGroupState(
    scopeKey: GroupWindowScopeKey,
    patch: Partial<Pick<GroupWindowState, "loadingMore" | "inlineError">>,
  ): void {
    const current = this.groupWindows.get(scopeKey);
    if (!current) return;
    this.groupWindows = new Map(this.groupWindows).set(scopeKey, {
      ...current,
      ...patch,
    });
    this.recomputeSnapshot();
  }

  loadMoreGroup = async (scopeKey: GroupWindowScopeKey): Promise<void> => {
    if (this.basePresentationGeneration !== this.presentationGeneration) return;
    const group = this.groupWindows.get(scopeKey);
    const after = group?.snapshot.nextCursor;
    if (!group || !after || group.loadingMore || this.inFlightFetch) return;
    this.setGroupState(scopeKey, { loadingMore: true, inlineError: null });
    try {
      const next = await this.readScopedWindow(
        { scopeKey, scope: group.scope },
        GROUP_WINDOW_FIRST,
        after,
        group.snapshot.commitSeq,
        group.snapshot.storeEpoch,
      );
      const current = this.groupWindows.get(scopeKey);
      if (!current || current.snapshot.nextCursor !== after) return;
      if (
        !hasSameProjectionAuthority(next, current.snapshot) ||
        next.viewId !== current.snapshot.viewId
      ) {
        // Continuations are valid only inside one exact projection revision.
        // Dispose the cursor and converge the whole Board from first windows.
        this.stale = true;
        await this.fetchBoard({
          storeEpoch: next.storeEpoch,
          commitSeq: next.projection.coveredCommitSeq,
        }).catch(() => {});
        return;
      }
      this.groupWindows = new Map(this.groupWindows).set(scopeKey, {
        ...current,
        snapshot: appendWindow(current.snapshot, next),
        inlineError: null,
      });
      this.rebuildFromGroups();
      this.recomputeSnapshot({ error: null });
    } catch (error) {
      if (error instanceof CoreApiError && error.isCursorRejection({ requestHadCursor: true })) {
        const current = this.groupWindows.get(scopeKey);
        if (current) {
          this.groupWindows = new Map(this.groupWindows).set(scopeKey, {
            ...current,
            snapshot: { ...current.snapshot, nextCursor: null },
          });
        }
        await this.refetchGroup(scopeKey);
        return;
      }
      this.setGroupState(scopeKey, { inlineError: toError(error).message });
    } finally {
      this.setGroupState(scopeKey, { loadingMore: false });
    }
  };

  /** Advances every group that still has a continuation (flat list views). */
  loadMoreAll = async (): Promise<void> => {
    const scopeKeys = [...this.groupWindows.entries()]
      .filter(([, group]) => group.snapshot.nextCursor !== null)
      .map(([scopeKey]) => scopeKey);
    await mapWithConcurrency(scopeKeys, GROUP_WINDOW_READ_CONCURRENCY, this.loadMoreGroup);
  };

  loadMore = async (): Promise<void> => {
    await this.loadMoreAll();
  };

  ensureFreshBoard = async (options: EnsureFreshBoardOptions = {}): Promise<void> => {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOARD_FRESHNESS_MS;
    const hasReadableBase = this.databaseViewId
      ? this.baseDatabaseView !== null
      : this.baseBoard !== null;
    const boardIsFresh =
      hasReadableBase && !this.stale && this.dependencies.now() - this.lastFetchedAt <= maxAgeMs;
    if (!options.force && boardIsFresh) return;

    await this.fetchBoard();
  };

  refreshBoardAtLeast = async (minimum: number | LocalProjectionCursor = 0): Promise<boolean> => {
    this.stale = true;
    this.requiredRefreshGeneration += 1;
    return await this.fetchBoard(minimum);
  };

  refreshBoard = async (): Promise<void> => {
    await this.refreshBoardAtLeast();
  };

  setError = (message: string): void => {
    this.recomputeSnapshot({
      error: message,
    });
  };

  clearLastMutationError = (): void => {
    this.recomputeSnapshot({
      lastMutationError: null,
    });
  };

  resolveConflict = (conflictKeys: string[]): void => {
    this.supersedeConflicts(conflictKeys);
    this.recomputeSnapshot({
      lastMutationError: null,
    });
  };

  applyRemoteCard = (card: DatabasePage, cursor?: LocalProjectionCursor): void => {
    this.applyRemoteCardSummary(toDatabasePageSummary(card), cursor);
  };

  applyRemoteCardSummary = (card: DatabasePageSummary, cursor?: LocalProjectionCursor): void => {
    if (!this.baseBoard) return;

    const authority = this.baseBoardAuthority;
    if (
      cursor &&
      authority &&
      (authority.storeEpoch !== cursor.storeEpoch || cursor.commitSeq < authority.commitSeq)
    ) {
      // A delayed row read or tailer replay must never move an already newer
      // local projection backwards. The subsequent floor refresh can still
      // reconcile a row that was not covered by this delta.
      return;
    }

    const nextBoard = upsertCardSummaryInBoard(this.baseBoard, card);
    if (nextBoard === this.baseBoard && !cursor) return;

    this.baseBoard = nextBoard;
    if (authority && cursor) {
      // A DatabasePage summary is enough for the Board card, but it does not
      // carry the exact Data Source membership/property evidence required to
      // invent a new query row. Keep the query surface honest until the
      // cursor-fenced canonical read supplies that row.
      const hasWindowRow = authority.rows.some((row) => row.page.id === card.id);
      const hasQueryRow = authority.query.rows.some((row) => row.page.pageId === card.id);
      const nextAuthority: DatabaseViewWindowSnapshot = {
        ...authority,
        board: nextBoard,
        commitSeq: Math.max(authority.commitSeq, cursor.commitSeq),
        rows: hasWindowRow
          ? authority.rows.map((row) => (row.page.id === card.id ? { ...row, page: card } : row))
          : authority.rows,
        query: {
          ...authority.query,
          rows: hasQueryRow
            ? authority.query.rows.map((row) =>
                row.page.pageId === card.id ? { ...row, page: { ...row.page, ...card } } : row,
              )
            : authority.query.rows,
        },
      };
      this.baseBoardAuthority = nextAuthority;
      if (hasQueryRow) {
        this.baseDatabaseView = buildDatabaseViewWindowRenderModel(nextAuthority);
      }
      this.requireMinimumCursor(cursor);
    }
    this.recomputeSnapshot();
  };

  private projectionCoordinate = (): ProjectionCoordinate | null => {
    const authority = this.baseBoardAuthority;
    return authority ? projectionCoordinateFromSnapshot(authority) : null;
  };

  private ensureCausalProjectionRuntime(): CausalProjectionRuntime | null {
    const coordinate = this.projectionCoordinate();
    if (!coordinate) return null;
    if (this.causalProjectionRuntime) return this.causalProjectionRuntime;
    this.causalProjectionRuntime = new CausalProjectionRuntime({
      scopeKey: coordinate.scopeKey,
      schemaVersion: coordinate.schemaVersion,
      getCoordinate: this.projectionCoordinate,
      apply: this.applyProjectionEffect,
      readAtLeast: this.repairProjection,
      onIntegrityFailure: (error) => {
        this.recomputeSnapshot({ error: error.message });
      },
    });
    return this.causalProjectionRuntime;
  }

  private applyProjectionEffect = (effect: ProjectionEffect): void => {
    const authority = this.baseBoardAuthority;
    const board = this.baseBoard;
    const patch = effect.patch;
    if (!authority || !board || !patch) {
      throw new Error("Database View projection has no patchable base");
    }
    if (patch.kind !== "database_row_upsert" && patch.kind !== "database_row_remove") {
      throw new Error("Database View received a patch for another projection module");
    }
    if (
      patch.projectId !== this.projectId ||
      patch.databaseId !== authority.databaseId ||
      patch.dataSourceId !== authority.dataSourceId ||
      patch.viewId !== authority.viewId
    ) {
      throw new Error("Database View projection patch targets another scope");
    }

    const pageId = patch.kind === "database_row_upsert" ? patch.row.id : patch.pageId;
    const groupKey =
      patch.kind === "database_row_upsert" ? patch.effectiveGroupKey : patch.groupKey;
    const advanceWindow = (
      snapshot: DatabaseViewWindowSnapshot,
      groupScope: DatabaseViewGroupScopeInput | null,
    ): DatabaseViewWindowSnapshot => {
      const includesUpsert =
        patch.kind === "database_row_upsert" &&
        scopeContainsGroup(groupScope, patch.effectiveGroupKey, patch.effectiveSubgroupKey);
      const existingRow = snapshot.rows.find((row) => row.page.id === pageId);
      const alreadyLoaded = existingRow !== undefined;
      // A singleton patch carries fractional rank, not its index in an
      // effective Property/intrinsic sort. Re-sorting the whole window by that
      // rank would expose a manual-order frame before the required canonical
      // repair. Presentation-changing personal overrides also make the
      // patch's durable group coordinates non-authoritative for this window.
      const manualDirection = changesProjectionCoordinate(this.preferencesOverride)
        ? null
        : databaseViewPrimaryManualOrderDirection(snapshot.query.view.config.rules.sorts);
      const admitsUpsert =
        includesUpsert &&
        (alreadyLoaded ||
          (manualDirection !== null &&
            (snapshot.nextCursor === null || patch.row.order < snapshot.rows.length)));
      const upsertedRow =
        patch.kind === "database_row_upsert"
          ? {
              page: patch.row,
              groupKey:
                manualDirection === null && existingRow
                  ? existingRow.groupKey
                  : patch.effectiveGroupKey,
              subgroupKey:
                manualDirection === null && existingRow
                  ? existingRow.subgroupKey
                  : patch.effectiveSubgroupKey,
              rankKey:
                manualDirection === null && existingRow
                  ? existingRow.rankKey
                  : (patch.rankKey ?? "ffffffffffffffffffffffffffffffff"),
            }
          : null;
      const nextRows =
        manualDirection === null
          ? snapshot.rows.flatMap((row) => {
              if (row.page.id !== pageId) return [row];
              return admitsUpsert && upsertedRow ? [upsertedRow] : [];
            })
          : [
              ...snapshot.rows.filter((row) => row.page.id !== pageId),
              ...(admitsUpsert && upsertedRow ? [upsertedRow] : []),
            ]
              .sort((left, right) => {
                const order =
                  left.rankKey.localeCompare(right.rankKey) ||
                  left.page.id.localeCompare(right.page.id);
                return manualDirection === "asc" ? order : -order;
              })
              .slice(
                0,
                snapshot.nextCursor !== null && !alreadyLoaded ? snapshot.rows.length : undefined,
              );
      const queryRowsByPageId = new Map(
        snapshot.query.rows
          .filter((row) => row.page.pageId !== pageId)
          .map((row) => [row.page.pageId, row] as const),
      );
      if (admitsUpsert) {
        const projectedQueryRow = projectCoreDatabaseQueryRow(patch.sourceRow, {
          libraryId: snapshot.libraryId,
          dataSourceId: snapshot.query.dataSource.dataSourceId,
          properties: snapshot.query.properties,
        });
        const existingQueryRow = snapshot.query.rows.find((row) => row.page.pageId === pageId);
        queryRowsByPageId.set(
          pageId,
          manualDirection === null && existingQueryRow
            ? {
                ...projectedQueryRow,
                effectiveGroupKey: existingQueryRow.effectiveGroupKey,
                effectiveSubgroupKey: existingQueryRow.effectiveSubgroupKey,
                position: existingQueryRow.position,
              }
            : projectedQueryRow,
        );
      }
      const nextBoard = rebuildBoardFromRankedRows(snapshot.board, nextRows);
      return {
        ...snapshot,
        commitSeq: Math.max(snapshot.commitSeq, effect.coveredCommitSeq),
        projection: {
          scopeKey: effect.scope.canonical_key,
          schemaVersion: effect.scope.schema_version,
          revision: effect.resultRevision,
          coveredCommitSeq: effect.coveredCommitSeq,
          effectHash: effect.effectHash,
        },
        nextCursor: effect.requiresReadAtLeast ? null : snapshot.nextCursor,
        rows: nextRows,
        board: nextBoard,
        query: {
          ...snapshot.query,
          rows: nextRows.flatMap((row) => {
            const queryRow = queryRowsByPageId.get(row.page.id);
            return queryRow ? [queryRow] : [];
          }),
        },
      };
    };

    this.groupWindows = new Map(
      [...this.groupWindows].map(([scopeKey, state]) => [
        scopeKey,
        {
          ...state,
          snapshot: advanceWindow(state.snapshot, state.scope),
        },
      ]),
    );
    if (this.groupWindows.size > 0) {
      this.rebuildFromGroups();
    } else {
      const nextAuthority = advanceWindow(authority, null);
      this.baseBoard = nextAuthority.board;
      this.baseBoardAuthority = nextAuthority;
      this.baseDatabaseView = buildDatabaseViewWindowRenderModel(nextAuthority);
    }
    const nextAuthority = this.baseBoardAuthority;
    if (!nextAuthority) {
      throw new Error("Database View projection lost its canonical window");
    }
    if (this.groupsSnapshot) {
      const nextGroups = this.groupsSnapshot.groups
        .map((group) =>
          group.groupKey === groupKey &&
          group.subgroupKey ===
            (patch.kind === "database_row_upsert"
              ? patch.effectiveSubgroupKey
              : patch.subgroupKey) &&
          patch.groupTotal !== null
            ? { ...group, totalRows: patch.groupTotal }
            : group,
        )
        .filter((group) => group.totalRows > 0);
      if (
        this.groupsSnapshot.grouped &&
        patch.groupTotal !== null &&
        patch.groupTotal > 0 &&
        !nextGroups.some(
          (group) =>
            group.groupKey === groupKey &&
            group.subgroupKey ===
              (patch.kind === "database_row_upsert"
                ? patch.effectiveSubgroupKey
                : patch.subgroupKey),
        )
      ) {
        nextGroups.push({
          groupKey,
          subgroupKey:
            patch.kind === "database_row_upsert" ? patch.effectiveSubgroupKey : patch.subgroupKey,
          totalRows: patch.groupTotal,
        });
      }
      this.groupsSnapshot = {
        ...this.groupsSnapshot,
        commitSeq: Math.max(this.groupsSnapshot.commitSeq, effect.coveredCommitSeq),
        projection: nextAuthority.projection,
        totalRows: patch.totalRows,
        groups: nextGroups,
      };
    }
    this.requireMinimumCursor({
      storeEpoch: authority.storeEpoch,
      commitSeq: effect.coveredCommitSeq,
    });
    this.lastFetchedAt = this.dependencies.now();
    this.stale = effect.requiresReadAtLeast;
    this.recomputeSnapshot({ error: null });
  };

  private repairProjection = async (request: ProjectionRepairRequest): Promise<void> => {
    const current = this.projectionCoordinate();
    if (current && current.scopeKey !== request.scopeKey) {
      throw new Error("Projection repair targets another Database View scope");
    }
    const repaired = await this.refreshBoardAtLeast({
      storeEpoch: request.storeEpoch,
      commitSeq: request.minimumCommitSeq,
    });
    if (!repaired) {
      throw new Error(this.snapshot.error ?? "Database View projection repair failed");
    }
  };

  enqueueLocalOverlay = (options: LocalOverlayOptions): boolean => {
    this.supersedeConflicts(options.conflictKeys);
    const before = this.baseBoard ? this.composeBoard(this.baseBoard) : null;
    const entry = this.createEntry({
      ...options,
      phase: "local",
    });
    this.optimisticEntries.push(entry);
    const after = this.baseBoard ? this.composeBoard(this.baseBoard) : null;
    if (this.baseBoard && after === before) {
      this.optimisticEntries = this.optimisticEntries.filter(
        (candidate) => candidate.opId !== entry.opId,
      );
      return false;
    }

    this.recomputeSnapshot();
    return true;
  };

  applyLocalPatch = (columnId: string, pageId: string, updates: Partial<PageInput>): boolean => {
    return this.enqueueLocalOverlay({
      kind: "page:patch-local",
      conflictKeys: conflictKeysForPatch(pageId, updates),
      apply: buildPatchPageTransform(columnId, pageId, updates),
    });
  };

  runOptimisticPatch = async <T>({
    columnId,
    pageId,
    updates,
    runRemote,
  }: RunOptimisticPatchOptions<T>): Promise<T> => {
    const outcome = await this.runOptimisticMutation({
      kind: "block:properties",
      conflictKeys: conflictKeysForPatch(pageId, updates),
      apply: buildPatchPageTransform(columnId, pageId, updates),
      runRemote,
    });

    if (outcome.ok && outcome.result !== undefined) {
      return outcome.result;
    }
    throw outcome.error ?? new Error("Mutation failed");
  };

  runOptimisticMutation = async <T>(
    options: RunOptimisticMutationOptions<T>,
  ): Promise<OptimisticMutationResult<T>> => {
    const authorityGeneration = this.authorityGeneration;
    this.supersedeConflicts(options.conflictKeys);
    const entry = this.createEntry({
      ...options,
      phase: "pending",
    });
    this.optimisticEntries.push(entry);
    this.recomputeSnapshot();
    recordRendererOwnerTrace(
      entry.trace,
      { kind: "local_intent", reason: "local_intent" },
      this.dependencies.causalTrace,
    );

    try {
      const execute = async (): Promise<{
        readonly result: T;
        readonly readyForNextPlacement: boolean;
      }> => {
        recordRendererOwnerTrace(
          entry.trace,
          { kind: "submitted", reason: "transport_submit" },
          this.dependencies.causalTrace,
        );
        const result = await options.runRemote();
        if (!entry.superseded) {
          recordRendererOwnerTrace(
            entry.trace,
            { kind: "acknowledged", reason: "committed" },
            this.dependencies.causalTrace,
          );
        }
        entry.phase = "acknowledged";
        entry.commitCursor = options.getCommitCursor?.(result) ?? null;
        entry.minimumMaterializationGeneration = entry.commitCursor
          ? this.canonicalReadGeneration + 1
          : null;
        // A successful command is durable, but its exact View projection can
        // reach this store before or after the response. A receipt-backed entry
        // stays projected until authority covers that commit floor.
        this.recomputeSnapshot();
        let readyForNextPlacement = true;
        if (options.refreshOnSuccess !== false) {
          readyForNextPlacement = await this.refreshBoardAtLeast(entry.commitCursor ?? 0);
        }
        return { result, readyForNextPlacement };
      };
      const execution = options.remoteLane
        ? await this.runRemoteInLane(options.remoteLane, authorityGeneration, execute)
        : await execute();
      return {
        ok: true,
        result: execution.result,
        superseded: entry.superseded,
        opId: entry.opId,
      };
    } catch (error) {
      const normalized = toError(error);
      if (!entry.superseded) {
        recordRendererOwnerTrace(
          entry.trace,
          { kind: "failed", reason: "domain_failure" },
          this.dependencies.causalTrace,
        );
      }
      this.removeEntry(entry.opId);

      const shouldSurfaceError = !entry.superseded || options.suppressErrorWhenSuperseded === false;
      if (shouldSurfaceError) {
        this.recomputeSnapshot({
          error: normalized.message,
          lastMutationError: normalized.message,
        });
      }

      if (options.refreshOnFailure !== false) {
        await this.refreshBoard();
      }
      return {
        ok: false,
        error: normalized,
        superseded: entry.superseded,
        opId: entry.opId,
      };
    }
  };

  /**
   * Runs a mutation whose visible authority is the generic Database View
   * model. The transform lives in the same optimistic journal and placement
   * lane as the classic Board projection, so refreshes cannot expose a stale
   * frame and queued commands compile from the latest canonical read.
   */
  runOptimisticDatabaseViewMutation = async <T>(
    options: RunOptimisticDatabaseViewMutationOptions<T>,
  ): Promise<OptimisticMutationResult<T>> => {
    const { apply, runRemote, isCommitMaterialized, ...sharedOptions } = options;
    return await this.runOptimisticMutation({
      ...sharedOptions,
      apply: (board) => board,
      applyDatabaseView: apply,
      runRemote: async () => {
        const canonicalModel = this.baseDatabaseView;
        if (!canonicalModel) {
          throw new Error("The Database View is not loaded");
        }
        return await runRemote(canonicalModel);
      },
      isDatabaseViewCommitMaterialized: isCommitMaterialized,
    });
  };

  private async runRemoteInLane<T>(
    lane: string,
    authorityGeneration: number,
    task: () => Promise<{
      readonly result: T;
      readonly readyForNextPlacement: boolean;
    }>,
  ): Promise<{
    readonly result: T;
    readonly readyForNextPlacement: boolean;
  }> {
    const previous = this.remoteLanes.get(lane) ?? Promise.resolve(true);
    let settle: (succeeded: boolean) => void = () => {};
    const completion = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.remoteLanes.set(lane, completion);
    let succeeded = false;
    try {
      const previousSucceeded = await previous;
      if (!previousSucceeded) {
        throw new Error("A preceding Board placement did not reach canonical authority");
      }
      if (authorityGeneration !== this.authorityGeneration) {
        throw new Error("Board authority changed before the queued mutation could execute");
      }
      const result = await task();
      succeeded = result.readyForNextPlacement;
      return result;
    } finally {
      settle(succeeded);
      void completion.then(() => {
        if (this.remoteLanes.get(lane) === completion) {
          this.remoteLanes.delete(lane);
        }
      });
    }
  }

  private composeBoard(baseBoard: BoardSummary): BoardSummary {
    let next = baseBoard;
    for (const entry of this.optimisticEntries) {
      if (entry.superseded) continue;
      next = entry.apply(next);
    }
    return next;
  }

  private composeDatabaseView(baseModel: DatabaseViewRenderModel): DatabaseViewRenderModel {
    let next = baseModel;
    for (const entry of this.optimisticEntries) {
      if (entry.superseded || !entry.applyDatabaseView) continue;
      next = entry.applyDatabaseView(next);
    }
    return next;
  }

  private activePendingCount(): number {
    return this.optimisticEntries.filter((entry) => entry.phase === "pending" && !entry.superseded)
      .length;
  }

  private buildGroupPagination(): ReadonlyMap<GroupWindowScopeKey, ColumnPaginationState> {
    const totals = new Map<GroupWindowScopeKey, number>();
    for (const group of this.groupsSnapshot?.groups ?? []) {
      totals.set(groupScopeKeyForPath(group.groupKey, group.subgroupKey), group.totalRows);
    }
    if (this.groupsSnapshot && !this.groupsSnapshot.grouped) {
      totals.set(UNGROUPED_SCOPE_KEY, this.groupsSnapshot.totalRows);
    }
    const pagination = new Map<GroupWindowScopeKey, ColumnPaginationState>();
    for (const [scopeKey, group] of this.groupWindows) {
      pagination.set(scopeKey, {
        scopeKey,
        loadedRows: group.snapshot.rows.length,
        totalRows: totals.get(scopeKey) ?? null,
        hasMore: group.snapshot.nextCursor !== null,
        loadingMore: group.loadingMore,
        error: group.inlineError,
      });
    }
    return pagination;
  }

  private recomputeSnapshot(
    overrides: Partial<
      Pick<BoardStoreSnapshot, "loading" | "loadingMore" | "error" | "lastMutationError">
    > = {},
  ): void {
    const materializedOperationIds = this.pruneConvergedEntries();
    const composedBoard = this.baseBoard ? this.composeBoard(this.baseBoard) : null;
    const composedDatabaseView = this.baseDatabaseView
      ? this.composeDatabaseView(this.baseDatabaseView)
      : null;
    const board = boardSummariesEqual(this.snapshot.board, composedBoard)
      ? this.snapshot.board
      : composedBoard;
    this.refreshMaterializationRenderCandidate(
      materializedOperationIds,
      board,
      composedDatabaseView,
    );
    const hasLoading = Object.prototype.hasOwnProperty.call(overrides, "loading");
    const hasError = Object.prototype.hasOwnProperty.call(overrides, "error");
    const hasLoadingMore = Object.prototype.hasOwnProperty.call(overrides, "loadingMore");
    const hasLastMutationError = Object.prototype.hasOwnProperty.call(
      overrides,
      "lastMutationError",
    );
    const groupPagination = this.buildGroupPagination();
    const anyLoadingMore = [...groupPagination.values()].some((state) => state.loadingMore);
    const anyHasMore = [...groupPagination.values()].some((state) => state.hasMore);
    const next: BoardStoreSnapshot = {
      ...this.snapshot,
      board,
      databaseView: composedDatabaseView,
      pageIndex: board === this.snapshot.board ? this.snapshot.pageIndex : buildPageIndex(board),
      pendingMutationCount: this.activePendingCount(),
      materializationRenderToken: this.materializationRenderCandidate?.token ?? null,
      hasMore: anyHasMore,
      groupPagination,
      totalRows: this.groupsSnapshot?.totalRows ?? null,
      loading: hasLoading ? (overrides.loading as boolean) : this.snapshot.loading,
      loadingMore: hasLoadingMore ? (overrides.loadingMore as boolean) : anyLoadingMore,
      error: hasError ? (overrides.error as string | null) : this.snapshot.error,
      lastMutationError: hasLastMutationError
        ? (overrides.lastMutationError as string | null)
        : this.snapshot.lastMutationError,
    };
    this.setSnapshot(next);
  }

  private refreshMaterializationRenderCandidate(
    operationIds: readonly number[],
    board: BoardSummary | null,
    databaseView: DatabaseViewRenderModel | null,
  ): void {
    if (operationIds.length === 0) {
      this.materializationRenderCandidate = null;
      return;
    }

    const previous = this.materializationRenderCandidate;
    const sameOperations =
      previous?.operationIds.length === operationIds.length &&
      operationIds.every((operationId, index) => previous.operationIds[index] === operationId);
    if (sameOperations && previous.board === board && previous.databaseView === databaseView)
      return;

    this.nextMaterializationRenderToken += 1;
    this.materializationRenderCandidate = {
      operationIds: [...operationIds],
      board,
      databaseView,
      token: this.nextMaterializationRenderToken,
    };
    for (const operationId of operationIds) {
      const entry = this.optimisticEntries.find((candidate) => candidate.opId === operationId);
      if (!entry) continue;
      recordRendererOwnerTrace(
        entry.trace,
        {
          kind: "materialized",
          reason: "canonical_observation",
          renderToken: this.nextMaterializationRenderToken,
        },
        this.dependencies.causalTrace,
      );
    }
  }

  private pruneConvergedEntries(): readonly number[] {
    if (!this.baseBoard && !this.baseDatabaseView) return [];
    if (this.optimisticEntries.length === 0) return [];

    let working = this.baseBoard;
    let workingDatabaseView = this.baseDatabaseView;
    let changed = false;
    const nextEntries: OptimisticEntry[] = [];
    const materializedOperationIds: number[] = [];

    for (const entry of this.optimisticEntries) {
      if (entry.superseded) {
        changed = true;
        continue;
      }

      const after = working ? entry.apply(working) : working;
      const afterDatabaseView =
        workingDatabaseView && entry.applyDatabaseView
          ? entry.applyDatabaseView(workingDatabaseView)
          : workingDatabaseView;

      if (entry.phase === "pending") {
        nextEntries.push(entry);
        working = after;
        workingDatabaseView = afterDatabaseView;
        continue;
      }

      // Retained local overlays are now auto-collected when base state catches up.
      if (entry.phase === "local") {
        if (after === working && afterDatabaseView === workingDatabaseView) {
          changed = true;
          continue;
        }
        nextEntries.push(entry);
        working = after;
        workingDatabaseView = afterDatabaseView;
        continue;
      }

      if (
        entry.commitCursor !== null &&
        (!this.baseBoardAuthority ||
          this.baseBoardAuthority.storeEpoch !== entry.commitCursor.storeEpoch ||
          this.baseBoardAuthority.projection.coveredCommitSeq < entry.commitCursor.commitSeq)
      ) {
        nextEntries.push(entry);
        working = after;
        workingDatabaseView = afterDatabaseView;
        continue;
      }

      if (entry.commitCursor !== null) {
        if (
          entry.minimumMaterializationGeneration !== null &&
          this.canonicalReadGeneration < entry.minimumMaterializationGeneration
        ) {
          nextEntries.push(entry);
          working = after;
          workingDatabaseView = afterDatabaseView;
          continue;
        }
        const boardMaterialized = entry.isCommitMaterialized
          ? this.baseBoard !== null && entry.isCommitMaterialized(this.baseBoard)
          : after === working;
        const databaseViewMaterialized = entry.isDatabaseViewCommitMaterialized
          ? this.baseDatabaseView !== null &&
            entry.isDatabaseViewCommitMaterialized(this.baseDatabaseView)
          : afterDatabaseView === workingDatabaseView;
        const materialized = boardMaterialized && databaseViewMaterialized;
        if (materialized) {
          nextEntries.push(entry);
          materializedOperationIds.push(entry.opId);
          working = after;
          workingDatabaseView = afterDatabaseView;
          continue;
        }
        nextEntries.push(entry);
        working = after;
        workingDatabaseView = afterDatabaseView;
        continue;
      }

      // Acknowledged entries remain visible until canonical state satisfies
      // the same semantic intent, at which point the transform is a no-op.
      if (after !== working || afterDatabaseView !== workingDatabaseView) {
        nextEntries.push(entry);
        working = after;
        workingDatabaseView = afterDatabaseView;
        continue;
      }

      nextEntries.push(entry);
      materializedOperationIds.push(entry.opId);
      working = after;
      workingDatabaseView = afterDatabaseView;
    }

    if (changed) this.optimisticEntries = nextEntries;
    return materializedOperationIds;
  }

  private createEntry({
    kind,
    operationIdentity,
    conflictKeys,
    apply,
    applyDatabaseView,
    phase,
    isCommitMaterialized,
    isDatabaseViewCommitMaterialized,
  }: {
    kind: string;
    operationIdentity?: string;
    conflictKeys: string[];
    apply: BoardTransform;
    applyDatabaseView?: DatabaseViewTransform;
    phase: OptimisticEntry["phase"];
    isCommitMaterialized?: (canonicalBoard: BoardSummary) => boolean;
    isDatabaseViewCommitMaterialized?: (canonicalModel: DatabaseViewRenderModel) => boolean;
  }): OptimisticEntry {
    const opId = this.nextOpId++;
    return {
      opId,
      kind,
      conflictKeys,
      apply,
      applyDatabaseView: applyDatabaseView ?? null,
      phase,
      commitCursor: null,
      isCommitMaterialized: isCommitMaterialized ?? null,
      isDatabaseViewCommitMaterialized: isDatabaseViewCommitMaterialized ?? null,
      minimumMaterializationGeneration: null,
      superseded: false,
      trace:
        phase === "pending"
          ? beginRendererOwnerTrace(
              {
                semanticKey: `board.${kind}`,
                operationIdentity:
                  operationIdentity ??
                  `board:${this.projectId}:${this.databaseViewId ?? "primary"}:${opId}`,
                owner: "board-store",
                protocol: "receipt_fenced_projection",
                scopeKind: "database",
              },
              this.dependencies.causalTrace,
            )
          : null,
    };
  }

  private supersedeConflicts(conflictKeys: string[]): void {
    if (conflictKeys.length === 0) return;
    let changed = false;
    for (const entry of this.optimisticEntries) {
      if (entry.superseded) continue;
      if (!overlap(entry.conflictKeys, conflictKeys)) continue;
      entry.superseded = true;
      recordRendererOwnerTrace(
        entry.trace,
        { kind: "superseded", reason: "newer_intent" },
        this.dependencies.causalTrace,
      );
      changed = true;
    }
    if (!changed) return;
    this.pruneSupersededEntries();
  }

  private pruneSupersededEntries(): void {
    this.optimisticEntries = this.optimisticEntries.filter((entry) => !entry.superseded);
  }

  private removeEntry(opId: number): void {
    this.optimisticEntries = this.optimisticEntries.filter((entry) => entry.opId !== opId);
  }

  private revokeEntries(reason: "authority_revoked" | "store_reset"): void {
    for (const entry of this.optimisticEntries) {
      if (entry.superseded) continue;
      entry.superseded = true;
      recordRendererOwnerTrace(
        entry.trace,
        { kind: "revoked", reason },
        this.dependencies.causalTrace,
      );
    }
  }

  private removeEntriesForPage(pageId: string): boolean {
    const conflictPrefix = `card:${pageId}:`;
    const nextEntries = this.optimisticEntries.filter((entry) => {
      const removesEntry = entry.conflictKeys.some((key) => key.startsWith(conflictPrefix));
      if (removesEntry) {
        entry.superseded = true;
        recordRendererOwnerTrace(
          entry.trace,
          { kind: "revoked", reason: "authority_revoked" },
          this.dependencies.causalTrace,
        );
      }
      return !removesEntry;
    });
    if (nextEntries.length === this.optimisticEntries.length) return false;
    this.optimisticEntries = nextEntries;
    return true;
  }

  private setSnapshot(next: BoardStoreSnapshot): void {
    const previous = this.snapshot;
    if (
      previous.board === next.board &&
      previous.databaseView === next.databaseView &&
      previous.pageIndex === next.pageIndex &&
      previous.loading === next.loading &&
      previous.loadingMore === next.loadingMore &&
      previous.hasMore === next.hasMore &&
      previous.error === next.error &&
      previous.pendingMutationCount === next.pendingMutationCount &&
      previous.lastMutationError === next.lastMutationError &&
      previous.materializationRenderToken === next.materializationRenderToken &&
      previous.totalRows === next.totalRows &&
      groupPaginationEquals(previous.groupPagination, next.groupPagination)
    ) {
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private requestRealtimeRefresh(minimum: number | LocalProjectionCursor = 0): void {
    this.stale = true;
    void this.fetchBoard(minimum);
  }

  private evictRevokedPage(pageId: string, commitSeq: number): void {
    revokeDatabaseRowDetail(this.projectId, pageId);
    const removedOptimisticEntry = this.removeEntriesForPage(pageId);
    const currentAuthority = this.baseBoardAuthority;
    const authorityRow = currentAuthority?.rows.find((row) => row.page.id === pageId);
    const baseContainsPage =
      this.baseBoard?.columns.some((column) => column.cards.some((card) => card.id === pageId)) ??
      false;
    if (!currentAuthority || (!authorityRow && !baseContainsPage)) {
      if (removedOptimisticEntry) this.recomputeSnapshot({ error: null });
      return;
    }
    const groupKey = authorityRow?.groupKey ?? null;
    const evictFromWindow = (snapshot: DatabaseViewWindowSnapshot): DatabaseViewWindowSnapshot => ({
      ...snapshot,
      commitSeq: Math.max(snapshot.commitSeq, commitSeq),
      board: removePageSummaryFromBoard(snapshot.board, pageId),
      rows: snapshot.rows.filter((row) => row.page.id !== pageId),
      query: {
        ...snapshot.query,
        rows: snapshot.query.rows.filter((row) => row.page.pageId !== pageId),
      },
    });
    const nextAuthority = evictFromWindow(currentAuthority);
    this.baseBoardAuthority = nextAuthority;
    this.baseBoard = nextAuthority.board;
    this.baseDatabaseView = buildDatabaseViewWindowRenderModel(nextAuthority);
    this.groupWindows = new Map(
      [...this.groupWindows].map(([scopeKey, state]) => [
        scopeKey,
        {
          ...state,
          snapshot: evictFromWindow(state.snapshot),
        },
      ]),
    );
    if (this.groupsSnapshot && authorityRow) {
      this.groupsSnapshot = {
        ...this.groupsSnapshot,
        commitSeq: Math.max(this.groupsSnapshot.commitSeq, commitSeq),
        totalRows: Math.max(0, this.groupsSnapshot.totalRows - 1),
        groups: this.groupsSnapshot.groups
          .map((group) =>
            group.groupKey === groupKey
              ? { ...group, totalRows: Math.max(0, group.totalRows - 1) }
              : group,
          )
          .filter((group) => group.totalRows > 0),
      };
    }
    this.recomputeSnapshot({ error: null });
  }

  private clearRevokedAggregate(): void {
    this.baseBoard = null;
    this.baseBoardAuthority = null;
    this.baseDatabaseView = null;
    this.groupWindows.clear();
    this.groupsSnapshot = null;
    this.revokeEntries("authority_revoked");
    this.optimisticEntries = [];
    this.materializationRenderCandidate = null;
    // Keep the causal runtime paired with its still-live registration. The
    // canonical repair below advances its dynamically read coordinate.
    this.recomputeSnapshot({
      loading: false,
      error: "Database View is unavailable",
    });
  }

  private revokeFromProjection = (cause: ProjectionRevocationMessage): void => {
    this.stale = true;
    this.revocationGeneration += 1;
    this.requiredRefreshGeneration += 1;
    this.requireMinimumCursor(cause.stream);
    if (cause.delivery.revocation.resource_kind === "page") {
      this.evictRevokedPage(cause.delivery.revocation.resource_id, cause.stream.commitSeq);
      return;
    }
    this.clearRevokedAggregate();
  };

  private fenceProjectionAuthority = (
    cause: Extract<
      ProjectionInvalidationCause,
      {
        readonly kind: "checkpoint" | "reset";
      }
    >,
  ): void => {
    this.stale = true;
    this.revocationGeneration += 1;
    this.requiredRefreshGeneration += 1;
    if (cause.kind === "reset") {
      this.requiredMinimumStoreEpoch = cause.stream.storeEpoch;
      this.requiredMinimumCommitSeq = cause.stream.commitSeq;
    } else {
      this.requireMinimumCursor(cause.stream);
    }
    this.baseBoard = null;
    this.baseBoardAuthority = null;
    this.baseDatabaseView = null;
    this.groupWindows.clear();
    this.groupsSnapshot = null;
    this.revokeEntries(cause.kind === "reset" ? "store_reset" : "authority_revoked");
    this.optimisticEntries = [];
    this.materializationRenderCandidate = null;
    // The registry has already fenced the paired causal runtime. Disposing it
    // here would orphan the still-live registration and drop every later
    // projection effect.
    fenceDatabaseRowDetailsForProject(this.projectId);
    this.recomputeSnapshot({ loading: true, error: null });
  };

  private refreshFromProjection = async (cause: ProjectionInvalidationCause): Promise<void> => {
    this.stale = true;
    if (this.listeners.size === 0) return;
    const refreshed = await this.fetchBoard(cause.stream);
    if (!refreshed) {
      throw new Error(this.snapshot.error ?? "Board projection refresh failed");
    }
  };

  private invalidateRetainedProjection = async (
    cause: ProjectionInvalidationCause,
  ): Promise<void> => {
    if (this.listeners.size > 0) return;
    this.clearInactiveAuthority();
    this.requireMinimumCursor(cause.stream);
  };

  private ensureRealtimeSubscription(): void {
    if (!this.unsubscribeBoardChanges) {
      this.unsubscribeBoardChanges = this.dependencies.subscribeBoardChanges(
        this.projectId,
        (event) => {
          if (this.databaseViewId) {
            this.stale = true;
            this.requestRealtimeRefresh(
              event.storeEpoch && event.commitSeq !== undefined
                ? { storeEpoch: event.storeEpoch, commitSeq: event.commitSeq }
                : (event.commitSeq ?? 0),
            );
            return;
          }
          const authority = this.baseBoardAuthority;
          if (
            !authority ||
            !event.storeEpoch ||
            event.commitSeq === undefined ||
            event.storeEpoch !== authority.storeEpoch ||
            event.commitSeq < authority.commitSeq
          ) {
            this.requestRealtimeRefresh(
              event.storeEpoch && event.commitSeq !== undefined
                ? { storeEpoch: event.storeEpoch, commitSeq: event.commitSeq }
                : (event.commitSeq ?? 0),
            );
            return;
          }
          const nextBoard = applyBoardChangeEventToBoard(this.baseBoard ?? undefined, event);
          if (nextBoard) {
            if (nextBoard !== this.baseBoard) {
              this.baseBoard = nextBoard;
              this.baseBoardAuthority = {
                ...authority,
                board: nextBoard,
                commitSeq: event.commitSeq,
              };
              this.lastFetchedAt = this.dependencies.now();
              this.stale = false;
              this.recomputeSnapshot();
            }
            return;
          }
          this.requestRealtimeRefresh({
            storeEpoch: event.storeEpoch,
            commitSeq: event.commitSeq,
          });
        },
      );
    }
    this.ensureProjectionSubscription("active");
  }

  private ensureProjectionSubscription(mode: "active" | "retained" = "active"): void {
    if (
      mode === "active"
        ? this.releaseActiveProjectionInvalidation
        : this.releaseRetainedProjectionInvalidation
    )
      return;
    const authority = this.baseBoardAuthority;
    const registry = this.dependencies.getProjectionInvalidationRegistry();
    if (!authority || !registry) return;
    const causalRuntime = mode === "active" ? this.ensureCausalProjectionRuntime() : null;
    // Releasing a registration cannot cancel a callback that the registry has
    // already selected for delivery. Fence every callback to the presentation
    // coordinate that created it so a late predecessor cannot clear its successor.
    const presentationGeneration = this.presentationGeneration;
    const isCurrentPresentation = () => presentationGeneration === this.presentationGeneration;
    const release = registry.register({
      scope: {
        kind: "project",
        libraryId: authority.libraryId,
        projectId: this.projectId,
      },
      consumerKey: JSON.stringify(["board", this.projectId, this.databaseViewId]),
      ...(causalRuntime ? { causalRuntime } : {}),
      projectionEffects: causalRuntime ? "ignore" : "match",
      getDependencies: () => {
        if (!isCurrentPresentation()) return {};
        const current = this.baseBoardAuthority;
        return {
          databaseIds: current ? [current.databaseId] : [],
          dataSourceIds: current ? [current.dataSourceId] : [],
          viewIds: current ? [current.viewId] : [],
          pageIds: [...this.snapshot.pageIndex.keys()],
        };
      },
      getCursor: () => {
        if (!isCurrentPresentation()) return null;
        const current = this.baseBoardAuthority;
        return current
          ? {
              storeEpoch: current.storeEpoch,
              commitSeq: current.projection.coveredCommitSeq,
            }
          : null;
      },
      revoke: (cause) => {
        if (!isCurrentPresentation()) return;
        this.revokeFromProjection(cause);
      },
      fence: (cause) => {
        if (!isCurrentPresentation()) return;
        this.fenceProjectionAuthority(cause);
      },
      invalidate: (cause) => {
        if (!isCurrentPresentation()) return;
        return causalRuntime
          ? this.refreshFromProjection(cause)
          : this.invalidateRetainedProjection(cause);
      },
    });
    if (mode === "active") {
      this.releaseActiveProjectionInvalidation = release;
      this.releaseRetainedProjectionInvalidation?.();
      this.releaseRetainedProjectionInvalidation = null;
      return;
    }
    this.releaseRetainedProjectionInvalidation = release;
    this.releaseActiveProjectionInvalidation?.();
    this.releaseActiveProjectionInvalidation = null;
    this.disposeCausalProjectionRuntime();
  }

  private teardownBoardChangesSubscription(): void {
    this.unsubscribeBoardChanges?.();
    this.unsubscribeBoardChanges = null;
  }

  private teardownRealtimeSubscription(): void {
    this.teardownBoardChangesSubscription();
    this.releaseActiveProjectionInvalidation?.();
    this.releaseRetainedProjectionInvalidation?.();
    this.releaseActiveProjectionInvalidation = null;
    this.releaseRetainedProjectionInvalidation = null;
    this.disposeCausalProjectionRuntime();
  }
}

class BoardStoreRegistry {
  private readonly stores = new Map<
    string,
    {
      readonly store: BoardProjectStore;
      lastAccess: number;
    }
  >();

  private accessSequence = 0;

  constructor(private readonly dependencies: BoardStoreDependencies) {}

  getStore(projectId: string, databaseViewId: string | null = null): BoardProjectStore {
    const key = JSON.stringify([projectId, databaseViewId]);
    const existing = this.stores.get(key);
    if (existing) {
      this.touch(existing);
      return existing.store;
    }

    const store = new BoardProjectStore(
      projectId,
      databaseViewId,
      this.dependencies,
      () => {
        const entry = this.stores.get(key);
        if (entry) this.touch(entry);
      },
      () => this.pruneInactiveStores(),
    );
    const entry = { store, lastAccess: 0 };
    this.touch(entry);
    this.stores.set(key, entry);
    return store;
  }

  private touch(entry: { lastAccess: number }): void {
    this.accessSequence += 1;
    entry.lastAccess = this.accessSequence;
  }

  private pruneInactiveStores(): void {
    if (this.stores.size <= MAX_RETAINED_BOARD_STORES) return;
    const candidates = [...this.stores.entries()]
      .filter(([, entry]) => !entry.store.isActive())
      .sort(([, left], [, right]) => left.lastAccess - right.lastAccess);
    for (const [key, entry] of candidates) {
      if (this.stores.size <= MAX_RETAINED_BOARD_STORES) return;
      if (!entry.store.disposeIfInactive()) continue;
      this.stores.delete(key);
    }
  }
}

export function createBoardStoreRegistry(
  dependencies: Partial<BoardStoreDependencies> = {},
): BoardStoreRegistry {
  return new BoardStoreRegistry({
    ...defaultDependencies,
    ...dependencies,
  });
}

const sharedBoardStoreRegistry = createBoardStoreRegistry();

export function getBoardProjectStore(
  projectId: string,
  databaseViewId: string | null = null,
): BoardProjectStore {
  return sharedBoardStoreRegistry.getStore(projectId, databaseViewId);
}

export function ensureFreshDatabaseViewBoard(
  projectId: string,
  databaseViewId: string,
  options?: EnsureFreshBoardOptions,
): Promise<void> {
  return getBoardProjectStore(projectId, databaseViewId).ensureFreshBoard(options);
}
