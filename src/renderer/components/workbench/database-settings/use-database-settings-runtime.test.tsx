import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { emptyDatabaseViewConfig } from "@/lib/database-view-authoring";
import type { DatabaseSettingsAuthority } from "@/lib/database-settings-runtime";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../../shared/database-identities";
import type {
  DatabaseContainerDescriptorV2,
  DatabaseModuleReadSnapshotV2,
} from "../../../../shared/database-module-v2";
import { deferred } from "../agent-instance-settings.test-fixtures";
import { useDatabaseSettingsRuntime } from "./use-database-settings-runtime";

const reads = vi.hoisted(() => ({ authority: vi.fn(), layout: vi.fn(), commit: vi.fn() }));
vi.mock("@/lib/database-settings-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-settings-runtime")>()),
  readDatabaseSettingsAuthority: reads.authority,
  readDatabasePageLayout: reads.layout,
  commitDatabaseSettingsOperations: reads.commit,
}));
vi.mock("@/lib/projection-invalidation-context", () => ({
  useProjectionRegistration: () => undefined,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
const input = { projectId: "project", databaseId: "database", activeViewId: "view" };

test("keeps the Database's View list during a sibling switch, even before its settings load", () => {
  const databaseId = parseDatabaseId(input.databaseId);
  const defaultViewId = parseDatabaseViewId(input.activeViewId);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const descriptor: DatabaseContainerDescriptorV2 = {
    database: {
      databaseId,
      libraryId: "library",
      name: "Tasks",
      lifecycle: "active",
      defaultViewId,
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSources: [],
    views: [defaultViewId, parseDatabaseViewId("sibling")].map((viewId) => ({
      viewId,
      databaseId,
      dataSourceId: parseDataSourceId("source"),
      name: viewId,
      lifecycle: "active",
      layout: "list",
      config: emptyDatabaseViewConfig(),
      isDefault: viewId === defaultViewId,
      revision: 1,
      rankKey: viewId,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  };
  const snapshot: DatabaseModuleReadSnapshotV2 = {
    projectId: input.projectId,
    libraryId: descriptor.database.libraryId,
    storeEpoch: "epoch",
    commitSeq: 1,
    value: { kind: "database", value: descriptor },
  };
  const first = deferred<DatabaseSettingsAuthority>();
  const sibling = deferred<DatabaseSettingsAuthority>();
  reads.authority
    .mockImplementationOnce(({ onReadDatabase }) => {
      onReadDatabase(descriptor, snapshot);
      return first.promise;
    })
    .mockReturnValueOnce(sibling.promise);
  const { result, rerender } = renderHook(useDatabaseSettingsRuntime, {
    initialProps: { ...input, databaseId: input.databaseId as string | null },
  });
  expect(result.current.database).toBe(descriptor);
  expect(result.current.authority).toBeNull();

  // On a cold switch the View body has not resolved its Database yet.
  rerender({ ...input, databaseId: null, activeViewId: "sibling" });
  expect(result.current.database).toBe(descriptor);
  expect(result.current.authority).toBeNull();
  expect(reads.authority).toHaveBeenLastCalledWith(
    expect.objectContaining({ databaseId, preferredViewId: "sibling" }),
  );

  rerender({ ...input, databaseId: null, activeViewId: "unrelated-view" });
  expect(result.current.database).toBeNull();
  rerender({ ...input, databaseId: null, activeViewId: "sibling", projectId: "other-project" });
  expect(result.current.database).toBeNull();
});

test("an older read cannot release the loading state of a newer refresh", async () => {
  const first = deferred<DatabaseSettingsAuthority>();
  const second = deferred<DatabaseSettingsAuthority>();
  reads.authority.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = renderHook(() => useDatabaseSettingsRuntime(input));
  await waitFor(() => expect(reads.authority).toHaveBeenCalledOnce());
  let refresh!: Promise<DatabaseSettingsAuthority | null>;
  await act(async () => {
    refresh = result.current.refresh();
    await Promise.resolve();
  });
  await act(async () => {
    first.reject(new Error("Stale request"));
    await Promise.resolve();
  });
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeNull();
  await act(async () => {
    second.reject(new Error("Current request"));
    expect(await refresh).toBeNull();
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe("Couldn’t save database settings.");
});

test("failed mutations release their pending key while refreshing authority", async () => {
  reads.authority.mockImplementation(() => new Promise<DatabaseSettingsAuthority>(() => {}));
  const committed = deferred<DatabaseSettingsAuthority>();
  reads.commit.mockReturnValueOnce(committed.promise);
  const { result } = renderHook(() => useDatabaseSettingsRuntime(input));
  let mutation!: Promise<DatabaseSettingsAuthority | null>;
  await act(async () => {
    mutation = result.current.mutate({ pendingKey: "rename", buildOperations: () => [] });
    await Promise.resolve();
  });
  expect(result.current.pendingKey).toBe("rename");
  await act(async () => {
    committed.reject(new Error("Write failed"));
    expect(await mutation).toBeNull();
  });
  expect(result.current.pendingKey).toBeNull();
  expect(result.current.error).toBe("Couldn’t save database settings.");
  expect(reads.authority).toHaveBeenCalledTimes(2);
});
