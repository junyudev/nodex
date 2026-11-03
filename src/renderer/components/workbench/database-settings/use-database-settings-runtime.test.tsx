import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { DatabaseSettingsAuthority } from "@/lib/database-settings-runtime";
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
