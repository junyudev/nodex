import { projectCoreDatabaseQueryRow } from "../../shared/core-database-row-projection";
import {
  projectDatabaseViewReference,
  projectCoreDatabaseRowSummaries,
  projectCoreDatabaseViewBoard,
  projectCoreDatabaseViewQuery,
} from "../../shared/database-page-projection";
import type {
  DatabaseContainerDescriptorV2,
  DatabaseModuleErrorCodeV2,
  DatabaseModuleReadResultV2,
  DatabaseViewRecordV2,
  DataSourceDescriptorV2,
  LibraryDatabaseModuleReadResultV2,
} from "../../shared/database-module-v2";
import type {
  DatabaseListWindowInput,
  DatabaseListWindowSnapshot,
  DatabaseViewGroupsInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewReadModel,
  DatabaseViewWindowInput,
  DatabaseViewWindowSnapshot,
  ReadDatabaseViewReferenceInput,
} from "../../shared/database-views";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import { stableStringifyDatabaseJson, type DatabaseJsonValue } from "../../shared/database-kernel";
import type { DatabaseRead, DatabaseReadSnapshot } from "../core-client/types";
import { toCoreDatabaseViewPreferencesOverride } from "../core-client/database-presentation-adapter";

type DescriptorReadResult = DatabaseModuleReadResultV2 | LibraryDatabaseModuleReadResultV2;
type BoundedProjectionInput =
  | DatabaseViewWindowInput
  | DatabaseListWindowInput
  | DatabaseViewGroupsInput;

export const minimumCommitSeqForDatabaseProjection = (
  input: BoundedProjectionInput,
  currentStoreEpoch: string,
): number => {
  const cursor = input.minimumCommitCursor;
  if (!cursor || cursor.storeEpoch !== currentStoreEpoch) return input.minimumCommitSeq ?? 0;
  return Math.max(input.minimumCommitSeq ?? 0, cursor.commitSeq);
};

const coreViewTarget = (
  input: BoundedProjectionInput,
): Extract<DatabaseRead, { readonly kind: "view_window" }>["target"] => {
  if (input.preferencesOverride && !input.databaseViewId) {
    throw new Error("Database View preferences require an explicit View");
  }
  if (input.databaseViewId && input.preferencesOverride) {
    return {
      kind: "presented_view",
      view_id: input.databaseViewId,
      preferences_override: toCoreDatabaseViewPreferencesOverride(input.preferencesOverride),
    };
  }
  if (input.databaseViewId) return { kind: "view", view_id: input.databaseViewId };
  if (input.databaseId) return { kind: "database", database_id: input.databaseId };
  return { kind: "project_default" };
};

export const databaseViewWindowRead = (input: DatabaseViewWindowInput): DatabaseRead => ({
  kind: "view_window",
  target: coreViewTarget(input),
  window: { after: input.after ?? null, first: input.first ?? 50 },
  ...(input.groupScope
    ? {
        group_scope: {
          kind: "path" as const,
          group_key: input.groupScope.groupKey,
          subgroup_key: input.groupScope.subgroupKey,
        },
      }
    : {}),
});

export const databaseListWindowRead = (input: DatabaseListWindowInput): DatabaseRead => ({
  kind: "list_window",
  target: coreViewTarget(input),
  window: { after: input.after ?? null, first: input.first ?? 200 },
});

export const databaseViewGroupsRead = (input: DatabaseViewGroupsInput): DatabaseRead => ({
  kind: "view_groups",
  target: coreViewTarget(input),
});

interface DescriptorByKind {
  readonly database: DatabaseContainerDescriptorV2;
  readonly data_source: DataSourceDescriptorV2;
  readonly view: DatabaseViewRecordV2;
}

export class DatabaseProjectionDescriptorError extends Error {
  constructor(
    readonly code: DatabaseModuleErrorCodeV2,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseProjectionDescriptorError";
  }
}

const requireDescriptor = <Kind extends keyof DescriptorByKind>(
  result: DescriptorReadResult,
  kind: Kind,
): DescriptorByKind[Kind] => {
  if (!result.ok) {
    throw new DatabaseProjectionDescriptorError(
      result.error.code,
      `Database ${kind} descriptor read failed (${result.error.code}): ${result.error.message}`,
    );
  }
  if (result.value.value.kind !== kind) {
    throw new Error(`Database Core returned a non-${kind} descriptor`);
  }
  return result.value.value.value as DescriptorByKind[Kind];
};

const projectionCoordinate = (
  projection: Extract<
    DatabaseReadSnapshot["value"],
    { readonly kind: "view_window" | "list_window" | "view_groups" }
  >["value"]["projection"],
) => ({
  scopeKey: projection.scope.canonical_key,
  schemaVersion: projection.scope.schema_version,
  revision: projection.revision,
  coveredCommitSeq: projection.covered_commit_seq,
  effectHash: projection.effect_hash ?? null,
});

export const projectDatabaseViewWindow = <ProjectScope extends string | null>(input: {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly snapshot: DatabaseReadSnapshot;
  readonly view: DescriptorReadResult;
  readonly database: DescriptorReadResult;
  readonly dataSource: DescriptorReadResult;
}): DatabaseViewWindowSnapshot<ProjectScope> => {
  if (input.snapshot.value.kind !== "view_window") {
    throw new Error("Database Core returned a non-window View snapshot");
  }
  if (!input.snapshot.authorization) {
    throw new Error("Database View read omitted canonical authorization");
  }
  const value = input.snapshot.value.value;
  const view = requireDescriptor(input.view, "view");
  const database = requireDescriptor(input.database, "database");
  const dataSource = requireDescriptor(input.dataSource, "data_source");
  const summaries = projectCoreDatabaseRowSummaries(value.rows.items);
  const rows = summaries.map((page, index) => ({
    page,
    groupKey: value.rows.items[index]?.effective_group_key ?? null,
    subgroupKey: value.rows.items[index]?.effective_subgroup_key ?? null,
    rankKey: value.rows.items[index]?.rank_key ?? "ffffffffffffffffffffffffffffffff",
  }));

  return {
    projectId: input.projectId,
    libraryId: input.libraryId,
    databaseId: value.database_id,
    dataSourceId: value.data_source_id,
    viewId: value.view_id,
    storeEpoch: input.snapshot.store_epoch,
    commitSeq: input.snapshot.commit_head,
    authorization: input.snapshot.authorization,
    projection: projectionCoordinate(value.projection),
    nextCursor: value.rows.next_cursor ?? null,
    rows,
    board: projectCoreDatabaseViewBoard(value.rows.items),
    query: projectCoreDatabaseViewQuery(value, input.libraryId, database, dataSource, view),
    view: {
      id: view.viewId,
      databaseBlockId: view.databaseId,
      projectId: input.projectId,
      name: view.name,
      layout: view.layout,
      config: JSON.parse(stableStringifyDatabaseJson(view.config)) as Readonly<
        Record<string, DatabaseJsonValue>
      >,
      isPrimary: view.isDefault,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    },
  };
};

export const projectDatabaseListWindow = <ProjectScope extends string | null>(input: {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly snapshot: DatabaseReadSnapshot;
  readonly dataSource: DescriptorReadResult;
}): DatabaseListWindowSnapshot<ProjectScope> => {
  if (input.snapshot.value.kind !== "list_window") {
    throw new Error("Database Core returned a non-List View snapshot");
  }
  if (!input.snapshot.authorization) {
    throw new Error("Database List read omitted canonical authorization");
  }
  const value = input.snapshot.value.value;
  const dataSource = requireDescriptor(input.dataSource, "data_source");
  const dataSourceId = parseDataSourceId(value.data_source_id);

  return {
    projectId: input.projectId,
    libraryId: input.libraryId,
    databaseId: value.database_id,
    dataSourceId: value.data_source_id,
    viewId: value.view_id,
    storeEpoch: input.snapshot.store_epoch,
    commitSeq: input.snapshot.commit_head,
    authorization: input.snapshot.authorization,
    projection: projectionCoordinate(value.projection),
    nextCursor: value.rows.next_cursor ?? null,
    rows: value.rows.items.map((row) => {
      if (row.kind === "group") {
        return {
          kind: row.kind,
          occurrenceKey: row.occurrence_key,
          groupKey: row.group_key ?? null,
          totalOccurrenceCount: row.total_occurrence_count,
        };
      }
      if (row.kind === "subgroup") {
        return {
          kind: row.kind,
          occurrenceKey: row.occurrence_key,
          groupKey: row.group_key ?? null,
          subgroupKey: row.subgroup_key ?? null,
          totalOccurrenceCount: row.total_occurrence_count,
        };
      }
      return {
        kind: row.kind,
        occurrenceKey: row.occurrence_key,
        row: projectCoreDatabaseQueryRow(row.summary, {
          libraryId: input.libraryId,
          dataSourceId,
          properties: dataSource.properties,
        }),
        groupPath: row.group_path.map((key) => key ?? null),
        ancestorPageIds: row.ancestor_page_ids,
        depth: row.depth,
        hasChildren: row.has_children,
        subtreeOccurrenceCount: row.subtree_occurrence_count,
        concreteSubtreePageCount: row.concrete_subtree_page_count,
        subtreeHeight: row.subtree_height,
        firstChildOccurrenceKey: row.first_child_occurrence_key ?? null,
        transientKind: row.transient_kind,
      };
    }),
    groups: value.groups.map((group) => ({
      groupKey: group.group_key ?? null,
      subgroupKey: group.subgroup_key ?? null,
      totalOccurrenceCount: group.total_occurrence_count,
    })),
    totalProjectionRowCount: value.total_projection_row_count,
    totalOccurrenceCount: value.total_occurrence_count,
    totalModelCount: value.total_model_count,
    windowStart: value.window_start,
    windowEnd: value.window_end,
    isComplete: value.is_complete,
  };
};

export const projectDatabaseViewGroups = <ProjectScope extends string | null>(input: {
  readonly projectId: ProjectScope;
  readonly libraryId: string;
  readonly snapshot: DatabaseReadSnapshot;
}): DatabaseViewGroupsSnapshot<ProjectScope> => {
  if (input.snapshot.value.kind !== "view_groups") {
    throw new Error("Database Core returned a non-groups View snapshot");
  }
  if (!input.snapshot.authorization) {
    throw new Error("Database View groups read omitted canonical authorization");
  }
  const value = input.snapshot.value.value;
  return {
    projectId: input.projectId,
    libraryId: input.libraryId,
    databaseId: value.database_id,
    dataSourceId: value.data_source_id,
    viewId: value.view_id,
    storeEpoch: input.snapshot.store_epoch,
    commitSeq: input.snapshot.commit_head,
    authorization: input.snapshot.authorization,
    projection: projectionCoordinate(value.projection),
    grouped: value.grouped,
    subgrouped: value.subgrouped,
    totalRows: value.total_rows,
    totalGroups: value.total_groups,
    groupLimit: value.group_limit,
    truncated: value.truncated,
    groups: value.groups.map((group) => ({
      groupKey: group.group_key ?? null,
      subgroupKey: group.subgroup_key ?? null,
      totalRows: group.total_rows,
    })),
  };
};

export const projectDatabaseViewReferenceModel = (
  window: DatabaseViewWindowSnapshot<string | null>,
  input: ReadDatabaseViewReferenceInput,
): DatabaseViewReadModel =>
  projectDatabaseViewReference(window.query, input, {
    libraryId: window.libraryId,
    storeEpoch: window.storeEpoch,
    commitSeq: window.commitSeq,
    authorization: window.authorization,
  });

export const viewDescriptorReads = (snapshot: DatabaseReadSnapshot) => {
  if (snapshot.value.kind !== "view_window") {
    throw new Error("Database Core returned a non-window View snapshot");
  }
  const value = snapshot.value.value;
  const minimumCommitSeq = snapshot.commit_head;
  return {
    view: {
      target: { kind: "view" as const, viewId: parseDatabaseViewId(value.view_id) },
      mode: "view" as const,
      minimumCommitSeq,
    },
    database: {
      target: { kind: "database" as const, databaseId: parseDatabaseId(value.database_id) },
      mode: "database" as const,
      minimumCommitSeq,
    },
    dataSource: {
      target: {
        kind: "data_source" as const,
        dataSourceId: parseDataSourceId(value.data_source_id),
      },
      mode: "data_source" as const,
      minimumCommitSeq,
    },
  };
};

export const listDescriptorRead = (snapshot: DatabaseReadSnapshot) => {
  if (snapshot.value.kind !== "list_window") {
    throw new Error("Database Core returned a non-List View snapshot");
  }
  return {
    target: {
      kind: "data_source" as const,
      dataSourceId: parseDataSourceId(snapshot.value.value.data_source_id),
    },
    mode: "data_source" as const,
    minimumCommitSeq: snapshot.commit_head,
  };
};
