import type { DatabaseViewPreferencesOverride, DatabaseViewLayout } from "./database-kernel";
import type { DatabaseViewQueryResultV2, DataSourcePageRowV2 } from "./database-module-v2";
import type { BoardSummary, DatabasePageSummary } from "./types";
import type { ContentAccessContext } from "./content-access-context";
import type { ProjectionCoordinate, ProjectionCursor } from "./projection-stream";

export interface ReadDatabaseViewReferenceInput {
  /** Authority inherited from the content surface containing the reference. */
  readonly accessContext: ContentAccessContext;
  readonly databaseViewId: string;
  /** Host Page identity used only for window-local include/exclude projection. */
  readonly hostBlockId?: string;
}

export type DatabaseViewJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DatabaseViewJsonValue[]
  | { readonly [key: string]: DatabaseViewJsonValue };

export interface DatabaseViewDefinition<ProjectScope extends string | null = string> {
  readonly id: string;
  readonly databaseBlockId: string;
  /**
   * Execution Project inherited by a Project surface, or null for a
   * Library-authorized surface. Database/View identity itself is Library-owned.
   */
  readonly projectId: ProjectScope;
  readonly name: string;
  readonly layout: DatabaseViewLayout;
  readonly config: Readonly<Record<string, DatabaseViewJsonValue>>;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DatabaseViewPageRow {
  readonly page: DatabasePageSummary;
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly rankKey: string;
}

export interface DatabaseViewReadModel {
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: import("./authorized-read-stamp").AuthorizedReadStamp;
  readonly dataSourceId: string;
  readonly view: DatabaseViewDefinition<string | null>;
  readonly rows: readonly DatabaseViewPageRow[];
}

/**
 * Restricts a window read to one stable primary/secondary group path. A null
 * key addresses the unassigned value at that level.
 */
export interface DatabaseViewGroupScopeInput {
  readonly kind: "path";
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
}

export interface DatabaseViewWindowInput {
  readonly databaseViewId?: string;
  readonly databaseId?: string;
  readonly after?: string;
  readonly first?: number;
  readonly groupScope?: DatabaseViewGroupScopeInput;
  /** Profile-local query and presentation patch, valid only with an explicit View. */
  readonly preferencesOverride?: DatabaseViewPreferencesOverride | null;
  /** Do not return a projection snapshot older than this local commit. */
  readonly minimumCommitSeq?: number;
  /**
   * Causal floor with its coordinate space. A different current Store epoch
   * returns replacement authority instead of waiting on an unreachable seq.
   */
  readonly minimumCommitCursor?: ProjectionCursor;
}

export type DatabaseListWindowInput = Omit<DatabaseViewWindowInput, "groupScope">;

export type DatabaseListProjectionRowSnapshot =
  | {
      readonly kind: "group";
      readonly occurrenceKey: string;
      readonly groupKey: string | null;
      readonly totalOccurrenceCount: number;
    }
  | {
      readonly kind: "subgroup";
      readonly occurrenceKey: string;
      readonly groupKey: string | null;
      readonly subgroupKey: string | null;
      readonly totalOccurrenceCount: number;
    }
  | {
      readonly kind: "page";
      readonly occurrenceKey: string;
      readonly row: DataSourcePageRowV2;
      readonly groupPath: readonly (string | null)[];
      readonly ancestorPageIds: readonly string[];
      readonly depth: number;
      readonly hasChildren: boolean;
      readonly subtreeOccurrenceCount: number;
      readonly concreteSubtreePageCount: number;
      readonly subtreeHeight: number;
      readonly firstChildOccurrenceKey: string | null;
      readonly transientKind: "none" | "ancestor" | "child";
    };

export interface DatabaseListGroupSummarySnapshot {
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly totalOccurrenceCount: number;
}

export interface DatabaseListWindowSnapshot<ProjectScope extends string | null = string> {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly viewId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: import("./authorized-read-stamp").AuthorizedReadStamp;
  readonly projection: Omit<ProjectionCoordinate, "storeEpoch">;
  readonly nextCursor: string | null;
  readonly rows: readonly DatabaseListProjectionRowSnapshot[];
  readonly groups: readonly DatabaseListGroupSummarySnapshot[];
  readonly totalProjectionRowCount: number;
  readonly totalOccurrenceCount: number;
  readonly totalModelCount: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly isComplete: boolean;
}

export type LibraryDatabaseListWindowSnapshot = DatabaseListWindowSnapshot<null>;

export interface DatabaseViewGroupsInput {
  readonly databaseViewId?: string;
  readonly databaseId?: string;
  /** Profile-local query and presentation patch, valid only with an explicit View. */
  readonly preferencesOverride?: DatabaseViewPreferencesOverride | null;
  /** Do not return a projection snapshot older than this local commit. */
  readonly minimumCommitSeq?: number;
  readonly minimumCommitCursor?: ProjectionCursor;
}

export interface DatabaseViewGroupSummarySnapshot {
  /** `null` counts the unassigned value at that path level. */
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly totalRows: number;
}

/**
 * Bounded per-group totals observed from data. `grouped: false` means the
 * View has no grouping Property and only `totalRows` is meaningful;
 * `truncated` reports that grouping cardinality exceeded the fixed bound.
 */
export interface DatabaseViewGroupsSnapshot<ProjectScope extends string | null = string> {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly viewId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: import("./authorized-read-stamp").AuthorizedReadStamp;
  readonly projection: Omit<ProjectionCoordinate, "storeEpoch">;
  readonly grouped: boolean;
  readonly subgrouped: boolean;
  readonly totalRows: number;
  readonly totalGroups: number;
  readonly groupLimit: number;
  readonly truncated: boolean;
  readonly groups: readonly DatabaseViewGroupSummarySnapshot[];
}

export type LibraryDatabaseViewGroupsSnapshot = DatabaseViewGroupsSnapshot<null>;

/**
 * A bounded Database View projection. `nextCursor` is the only indication that
 * another window is available; callers must not infer completion from row
 * count.
 */
export interface DatabaseViewWindowSnapshot<ProjectScope extends string | null = string> {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly viewId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: import("./authorized-read-stamp").AuthorizedReadStamp;
  readonly projection: Omit<ProjectionCoordinate, "storeEpoch">;
  readonly nextCursor: string | null;
  readonly rows: readonly DatabaseViewPageRow[];
  readonly board: BoardSummary;
  readonly view: DatabaseViewDefinition<ProjectScope>;
  /**
   * Bounded compatibility evidence for existing Database View renderers. It
   * contains only rows from this window and never contains Page bodies.
   */
  readonly query: DatabaseViewQueryResultV2;
}

export type LibraryDatabaseViewWindowSnapshot = DatabaseViewWindowSnapshot<null>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Applies the host-Page visibility option to rows already ordered and filtered
 * by the canonical Database View query engine.
 */
export const evaluateDatabaseViewRows = (
  model: DatabaseViewReadModel,
  context: { readonly hostBlockId?: string } = {},
): readonly DatabaseViewPageRow[] => {
  const includeHostPage =
    isRecord(model.view.config.options) && model.view.config.options.includeHostPage === true;
  if (!context.hostBlockId || includeHostPage) return model.rows;
  return model.rows.filter((row) => row.page.id !== context.hostBlockId);
};
