import {
  type DatabaseApplyOperationV2,
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabaseContainerDescriptorV2,
  type DatabaseModuleErrorV2,
  type DatabaseModuleReadRequestV2,
  type DatabaseModuleReadResultV2,
  type DatabaseModuleReadSnapshotV2,
  type DataSourceDescriptorV2,
  type DataSourceRecordV2,
  type DatabaseViewRecordV2,
  type DatabasePageLayoutV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  type DatabaseViewId,
} from "../../shared/database-identities";
import { applyDatabaseSettingsModule, readDatabaseModule } from "./api";
import { databaseSettingsApplyCommand } from "./core-projection-commands";
import { beginRendererOwnerTrace, recordRendererOwnerTrace } from "./renderer-causal-trace";

export interface DatabaseSettingsAuthority {
  readonly snapshot: DatabaseModuleReadSnapshotV2;
  readonly database: DatabaseContainerDescriptorV2;
  readonly view: DatabaseViewRecordV2;
  readonly dataSource: DataSourceRecordV2;
  readonly source: DataSourceDescriptorV2;
}

export interface DatabaseSettingsRuntimeDependencies {
  readonly read: (
    projectId: string,
    request: DatabaseModuleReadRequestV2,
  ) => Promise<DatabaseModuleReadResultV2>;
  readonly apply: (projectId: string, request: DatabaseApplyV2) => Promise<DatabaseApplyResultV2>;
}

export class DatabaseSettingsReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DatabaseSettingsReadError";
  }
}

export class DatabaseSettingsMutationError extends Error {
  constructor(readonly commandError: DatabaseModuleErrorV2) {
    super(commandError.message);
    this.name = "DatabaseSettingsMutationError";
  }
}

const defaultDependencies: DatabaseSettingsRuntimeDependencies = {
  read: readDatabaseModule,
  apply: applyDatabaseSettingsModule,
};

const readSnapshot = async (
  projectId: string,
  read: DatabaseModuleReadRequestV2["read"],
  dependencies: DatabaseSettingsRuntimeDependencies,
): Promise<DatabaseModuleReadSnapshotV2> => {
  const result = await dependencies.read(projectId, { projectId, read });
  if (!result.ok) throw new DatabaseSettingsReadError(result.error.message, result.error.retryable);
  if (result.value.projectId === projectId) return result.value;
  throw new DatabaseSettingsReadError("Database settings crossed their Project authority", false);
};

/** Reads only the Database and Source owned by the mounted Database surface. */
export const readDatabaseSettingsAuthority = async (input: {
  readonly projectId: string;
  readonly databaseId: string;
  readonly preferredViewId?: string | null;
  readonly minimumCommitSeq?: number;
  readonly dependencies?: DatabaseSettingsRuntimeDependencies;
}): Promise<DatabaseSettingsAuthority> => {
  const dependencies = input.dependencies ?? defaultDependencies;
  const databaseSnapshot = await readSnapshot(
    input.projectId,
    {
      target: { kind: "database", databaseId: parseDatabaseId(input.databaseId) },
      mode: "database",
      ...(input.minimumCommitSeq === undefined ? {} : { minimumCommitSeq: input.minimumCommitSeq }),
    },
    dependencies,
  );
  if (databaseSnapshot.value.kind !== "database") {
    throw new DatabaseSettingsReadError("Database settings returned the wrong descriptor", false);
  }
  const database = databaseSnapshot.value.value;
  const activeViews = database.views.filter((view) => view.lifecycle === "active");
  const preferredView = input.preferredViewId
    ? activeViews.find((view) => view.viewId === parseDatabaseViewId(input.preferredViewId))
    : undefined;
  const selectedView =
    preferredView ??
    activeViews.find((view) => view.viewId === database.database.defaultViewId) ??
    activeViews[0];
  if (!selectedView) {
    throw new DatabaseSettingsReadError("Database has no active View", false);
  }
  const dataSource = database.dataSources.find(
    (source) => source.lifecycle === "active" && source.dataSourceId === selectedView.dataSourceId,
  );
  if (!dataSource) {
    throw new DatabaseSettingsReadError("Active View has no active Data Source", false);
  }
  const sourceSnapshot = await readSnapshot(
    input.projectId,
    {
      target: { kind: "data_source", dataSourceId: dataSource.dataSourceId },
      mode: "data_source",
      ...(input.minimumCommitSeq === undefined ? {} : { minimumCommitSeq: input.minimumCommitSeq }),
    },
    dependencies,
  );
  if (
    sourceSnapshot.storeEpoch !== databaseSnapshot.storeEpoch ||
    sourceSnapshot.value.kind !== "data_source" ||
    sourceSnapshot.value.value.dataSource.dataSourceId !== dataSource.dataSourceId
  ) {
    throw new DatabaseSettingsReadError("Database and Source settings did not converge", true);
  }
  return {
    snapshot: sourceSnapshot,
    database,
    view: selectedView,
    dataSource,
    source: sourceSnapshot.value.value,
  };
};

/** Reads the Source-owned Page layout only when its dedicated route/consumer opens. */
export const readDatabasePageLayout = async (input: {
  readonly projectId: string;
  readonly dataSourceId: string;
  readonly minimumCommitSeq?: number;
  readonly dependencies?: DatabaseSettingsRuntimeDependencies;
}): Promise<DatabasePageLayoutV2> => {
  const dependencies = input.dependencies ?? defaultDependencies;
  const snapshot = await readSnapshot(
    input.projectId,
    {
      target: { kind: "data_source", dataSourceId: parseDataSourceId(input.dataSourceId) },
      mode: "page_layout",
      ...(input.minimumCommitSeq === undefined ? {} : { minimumCommitSeq: input.minimumCommitSeq }),
    },
    dependencies,
  );
  if (snapshot.value.kind === "page_layout") return snapshot.value.value;
  throw new DatabaseSettingsReadError("Page layout returned the wrong projection", false);
};

const applyExactRequest = async (
  projectId: string,
  request: DatabaseApplyV2,
  dependencies: DatabaseSettingsRuntimeDependencies,
): Promise<DatabaseApplyResultV2> => {
  let retried = false;
  let result: DatabaseApplyResultV2;
  try {
    result = await dependencies.apply(projectId, request);
  } catch {
    retried = true;
    result = await dependencies.apply(projectId, request);
  }
  if (!result.ok && result.error.retryable && !retried) {
    result = await dependencies.apply(projectId, request);
  }
  return result;
};

/** Applies one atomic settings transaction, then returns a causally newer narrow descriptor. */
export const commitDatabaseSettingsOperations = async (input: {
  readonly projectId: string;
  readonly databaseId: string;
  readonly preferredViewId?: DatabaseViewId | string | null;
  readonly operationId: string;
  readonly buildOperations: (
    authority: DatabaseSettingsAuthority,
  ) => readonly DatabaseApplyOperationV2[];
  readonly dependencies?: DatabaseSettingsRuntimeDependencies;
}): Promise<DatabaseSettingsAuthority> => {
  const dependencies = input.dependencies ?? defaultDependencies;
  const authority = await readDatabaseSettingsAuthority({
    projectId: input.projectId,
    databaseId: input.databaseId,
    preferredViewId: input.preferredViewId,
    dependencies,
  });
  const operations = input.buildOperations(authority);
  if (operations.length === 0) return authority;
  const trace = beginRendererOwnerTrace({
    semanticKey: databaseSettingsApplyCommand.key,
    operationIdentity: input.operationId,
    owner: databaseSettingsApplyCommand.owner,
    protocol: databaseSettingsApplyCommand.protocol.kind,
    scopeKind: "database",
  });
  recordRendererOwnerTrace(trace, { kind: "local_intent", reason: "local_intent" });
  const result = await applyExactRequest(
    input.projectId,
    {
      operationId: input.operationId,
      projectId: input.projectId,
      storeEpoch: authority.snapshot.storeEpoch,
      actor: { kind: "renderer_database_management" },
      operations,
    },
    dependencies,
  );
  if (!result.ok) throw new DatabaseSettingsMutationError(result.error);
  const refreshed = await readDatabaseSettingsAuthority({
    projectId: input.projectId,
    databaseId: input.databaseId,
    preferredViewId: input.preferredViewId,
    minimumCommitSeq: result.value.commitSeq,
    dependencies,
  });
  recordRendererOwnerTrace(trace, { kind: "result", reason: "terminal_result" });
  recordRendererOwnerTrace(trace, { kind: "settled", reason: "proof_complete" });
  return refreshed;
};
