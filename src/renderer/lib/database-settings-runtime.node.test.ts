import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import type {
  DatabaseApplyResultV2,
  DatabaseContainerDescriptorV2,
  DatabaseModuleReadResultV2,
  DataSourceDescriptorV2,
} from "../../shared/database-module-v2";

const traceMocks = vi.hoisted(() => ({ events: [] as unknown[] }));

vi.mock("./renderer-causal-trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./renderer-causal-trace")>()),
  beginRendererOwnerTrace: () => ({
    semanticKey: "database.settings.apply",
    operationIdentityHash: "f".repeat(64),
    owner: "DatabaseSettingsRuntime",
    protocol: "pending_operation",
    scopeKind: "database",
  }),
  recordRendererOwnerTrace: (_context: unknown, event: unknown) => {
    traceMocks.events.push(event);
    return true;
  },
}));

import {
  commitDatabaseSettingsOperations,
  DatabaseSettingsReadError,
  type DatabaseSettingsRuntimeDependencies,
} from "./database-settings-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const projectId = "project:test";
const libraryId = "library:test";
const storeEpoch = "epoch:test";
const databaseId = parseDatabaseId("database:test");
const dataSourceId = parseDataSourceId("data-source:test");
const viewId = parseDatabaseViewId("view:test");

const dataSource = {
  dataSourceId,
  libraryId,
  homeDatabaseId: databaseId,
  name: "Tasks",
  schemaKey: "tasks",
  schemaRevision: 1,
  lifecycle: "active",
  rankKey: "a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const descriptor = {
  database: {
    databaseId,
    libraryId,
    name: "Tasks",
    lifecycle: "active",
    defaultViewId: viewId,
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  dataSources: [dataSource],
  views: [
    {
      viewId,
      databaseId,
      dataSourceId,
      name: "All tasks",
      layout: "list",
      config: {},
      isDefault: true,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
} as unknown as DatabaseContainerDescriptorV2;

const source = { dataSource, properties: [] } satisfies DataSourceDescriptorV2;

const readResult = (
  commitSeq: number,
  value:
    | { readonly kind: "database"; readonly value: DatabaseContainerDescriptorV2 }
    | { readonly kind: "data_source"; readonly value: DataSourceDescriptorV2 },
): DatabaseModuleReadResultV2 => ({
  ok: true,
  value: {
    projectId,
    libraryId,
    storeEpoch,
    commitSeq,
    authorization: null,
    value,
  },
});

const applyResult = (operationId: string): DatabaseApplyResultV2 =>
  ({
    ok: true,
    value: { operationId, commitSeq: 2 },
    localCommit: {
      status: "committed",
      commit: { store_epoch: storeEpoch, commit_seq: 2, manifest_hash: "f".repeat(64) },
      delivery: null,
    },
  }) as DatabaseApplyResultV2;

const operation = {
  kind: "delete_view" as const,
  databaseId,
  viewId,
  expectedRevision: 1,
};

function runtimeFixture({ retryApply = false }: { readonly retryApply?: boolean } = {}) {
  const postSourceRead = deferred<DatabaseModuleReadResultV2>();
  const postSourceStarted = deferred<void>();
  let applied = false;
  let applyAttempts = 0;
  const read = vi.fn<DatabaseSettingsRuntimeDependencies["read"]>(async (_projectId, request) => {
    const postApply = applied;
    if (request.read.target.kind === "database") {
      return readResult(postApply ? 2 : 1, { kind: "database", value: descriptor });
    }
    if (!postApply) return readResult(1, { kind: "data_source", value: source });
    postSourceStarted.resolve();
    return await postSourceRead.promise;
  });
  const apply = vi.fn<DatabaseSettingsRuntimeDependencies["apply"]>(async (_projectId, request) => {
    applyAttempts += 1;
    if (retryApply && applyAttempts === 1) throw new Error("response lost");
    applied = true;
    return applyResult(request.operationId);
  });
  return {
    dependencies: { read, apply } satisfies DatabaseSettingsRuntimeDependencies,
    apply,
    postSourceRead,
    postSourceStarted,
    read,
  };
}

describe("DatabaseSettingsRuntime", () => {
  beforeEach(() => {
    traceMocks.events.length = 0;
  });

  it("keeps one retry identity pending until the causally fenced reread completes", async () => {
    const fixture = runtimeFixture({ retryApply: true });
    const mutation = commitDatabaseSettingsOperations({
      projectId,
      databaseId,
      operationId: "database-settings-operation",
      buildOperations: () => [operation],
      dependencies: fixture.dependencies,
    });

    await fixture.postSourceStarted.promise;
    expect(fixture.apply).toHaveBeenCalledTimes(2);
    expect(fixture.apply.mock.calls[0]?.[1]).toBe(fixture.apply.mock.calls[1]?.[1]);
    expect(
      fixture.read.mock.calls.slice(-2).map(([, request]) => request.read.minimumCommitSeq),
    ).toEqual([2, 2]);
    expect(traceMocks.events).toEqual([{ kind: "local_intent", reason: "local_intent" }]);

    fixture.postSourceRead.resolve(readResult(2, { kind: "data_source", value: source }));
    await expect(mutation).resolves.toMatchObject({ snapshot: { commitSeq: 2 } });
    expect(traceMocks.events).toEqual([
      { kind: "local_intent", reason: "local_intent" },
      { kind: "result", reason: "terminal_result" },
      { kind: "settled", reason: "proof_complete" },
    ]);
  });

  it("does not report a terminal result when the fenced reread fails", async () => {
    const fixture = runtimeFixture();
    const mutation = commitDatabaseSettingsOperations({
      projectId,
      databaseId,
      operationId: "database-settings-read-failure",
      buildOperations: () => [operation],
      dependencies: fixture.dependencies,
    });

    await fixture.postSourceStarted.promise;
    fixture.postSourceRead.resolve({
      ok: false,
      error: { code: "state_corrupt", message: "unavailable", retryable: true },
    });
    await expect(mutation).rejects.toBeInstanceOf(DatabaseSettingsReadError);
    expect(traceMocks.events).toEqual([{ kind: "local_intent", reason: "local_intent" }]);
  });
});
