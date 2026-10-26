import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi, afterEach } from "vitest";
import { pluginRow } from "../../shared/test-fixtures/plugins";
import {
  applyPluginManagementEvent,
  runPluginMutation,
  patchPluginData,
} from "./plugin-management-cache";
import { pluginManagementKeys } from "./plugin-management-query-keys";
import { commandPluginManagement } from "./plugin-management-adapter";
vi.mock("./plugin-management-adapter", () => ({
  commandPluginManagement: vi.fn(),
  subscribePluginManagement: vi.fn(() => () => {}),
  subscribePluginProjectChanges: vi.fn(() => () => {}),
}));
const context = { hostId: "local", projectId: null } as const;
const scope = { ...context, accountEpoch: 1, hostGeneration: 1, bindingRevision: null, cwds: [] };
const clients: QueryClient[] = [];
const client = () => {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(value);
  return value;
};
afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
  vi.resetAllMocks();
});
describe("plugin mutation cache settlement", () => {
  it("optimistically patches every affected cache and rolls each back on a rejected toggle", async () => {
    const queryClient = client();
    const row = pluginRow();
    const keys = ["list", "installed", "read", "public-home"].map((resource) =>
      pluginManagementKeys.resource(scope, resource),
    );
    const values = [
      { rows: [row] },
      { rows: [row] },
      { row, summary: row.summary },
      { sections: [{ plugins: [row] }] },
    ];
    keys.forEach((key, i) => queryClient.setQueryData(key, values[i]));
    vi.mocked(commandPluginManagement).mockImplementation(async () => {
      for (const key of keys)
        expect(queryClient.getQueryData(key)).toEqual(
          patchPluginData(values[keys.indexOf(key)], row.nativeId, { enabled: false }),
        );
      return {
        status: "failed",
        error: { code: "config_conflict", message: "Changed", retryable: false },
      } as never;
    });
    const result = await runPluginMutation(queryClient, context, "set-enabled", {
      pluginId: row.nativeId,
      enabled: false,
    });
    expect(result.status).toBe("failed");
    keys.forEach((key, i) => expect(queryClient.getQueryData(key)).toEqual(values[i]));
  });
  it("patches shared skill paths across Project caches and rolls back a rejected skill toggle", async () => {
    const queryClient = client();
    const skill = { path: "/skills/sample/SKILL.md", name: "sample", scope: "user", enabled: true };
    const keys = [scope, { ...scope, projectId: "another" }].map((context) =>
      pluginManagementKeys.resource(context, "skills"),
    );
    for (const key of keys) queryClient.setQueryData(key, { data: [{ skills: [skill] }] });
    vi.mocked(commandPluginManagement).mockImplementation(async () => {
      for (const key of keys)
        expect(queryClient.getQueryData(key)).toMatchObject({
          data: [{ skills: [{ enabled: false }] }],
        });
      return {
        status: "protected",
        error: { code: "protected", message: "Managed skill", retryable: false },
      } as never;
    });
    await runPluginMutation(queryClient, context, "skill-enabled", {
      path: skill.path,
      enabled: false,
    });
    for (const key of keys)
      expect(queryClient.getQueryData(key)).toEqual({ data: [{ skills: [skill] }] });
  });
  it("keeps a successful installation and inserts it into the installed inventory despite refresh warnings", async () => {
    const queryClient = client();
    const row = pluginRow({
      summary: { ...pluginRow().summary, installed: false, enabled: false },
      installState: "not_installed",
      actionState: "install",
    });
    const listKey = pluginManagementKeys.resource(scope, "list");
    const installedKey = pluginManagementKeys.resource(scope, "installed");
    queryClient.setQueryData(listKey, { rows: [row] });
    queryClient.setQueryData(installedKey, { rows: [] });
    vi.mocked(commandPluginManagement).mockResolvedValue({
      status: "success-with-refresh-warning",
      value: { authPolicy: "ON_USE", appsNeedingAuth: [] },
      refreshFailures: ["skills"],
    } as never);
    const result = await runPluginMutation(queryClient, context, "install", {
      ...row.selector,
      installAttemptId: "a",
    });
    expect(result.status).toBe("success-with-refresh-warning");
    expect(queryClient.getQueryData(installedKey)).toMatchObject({
      rows: [{ summary: { installed: true }, installState: "installed" }],
    });
    expect(queryClient.getQueryData(listKey)).toMatchObject({
      rows: [{ summary: { installed: true }, actionState: "installed_menu" }],
    });
  });
  it("does not restore old account data after an in-flight mutation settles", async () => {
    const queryClient = client();
    const row = pluginRow();
    const key = pluginManagementKeys.resource(scope, "installed");
    queryClient.setQueryData(key, { rows: [row] });
    vi.mocked(commandPluginManagement).mockImplementation(async () => {
      applyPluginManagementEvent(queryClient, {
        hostId: "local",
        accountEpoch: 2,
        kind: "account",
      });
      return { status: "success", value: undefined, refreshFailures: [] } as never;
    });
    const result = await runPluginMutation(queryClient, context, "set-enabled", {
      pluginId: row.nativeId,
      enabled: false,
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "account_changed" } });
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
  it("does not claim rollback when transport delivery is unknown and never retries a mutation", async () => {
    const queryClient = client();
    const row = pluginRow();
    const key = pluginManagementKeys.resource(scope, "installed");
    queryClient.setQueryData(key, { rows: [row] });
    vi.mocked(commandPluginManagement).mockRejectedValue(new Error("window disconnected"));
    const result = await runPluginMutation(queryClient, context, "set-enabled", {
      pluginId: row.nativeId,
      enabled: false,
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "mutation_outcome_unknown" } });
    expect(commandPluginManagement).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(key)).toMatchObject({
      rows: [{ summary: { enabled: false } }],
    });
  });
  it("publishes removal progress before the caller knows its operation ID", () => {
    const queryClient = client();
    queryClient.setQueryData(pluginManagementKeys.context(context), scope);
    const progress = {
      marketplaceName: "custom",
      operationId: "removal-1",
      pluginIds: ["a", "b"],
      completedPluginIds: ["a"],
      remainingPluginIds: ["b"],
      protected: false,
      removed: false,
      outcome: { status: "success" as const, value: undefined, refreshFailures: [] },
    };
    applyPluginManagementEvent(queryClient, {
      hostId: "local",
      accountEpoch: 1,
      kind: "plugins",
      progress,
    });
    expect(
      queryClient.getQueryData(pluginManagementKeys.resource(scope, "marketplace-progress", null)),
    ).toEqual(progress);
    expect(
      queryClient.getQueryData(
        pluginManagementKeys.resource(scope, "marketplace-progress", "removal-1"),
      ),
    ).toEqual(progress);
  });
  it("invalidates only the host named by an inventory event", () => {
    const queryClient = client();
    const local = pluginManagementKeys.resource(scope, "installed");
    const remote = pluginManagementKeys.resource({ ...scope, hostId: "remote" }, "installed");
    queryClient.setQueryData(local, {});
    queryClient.setQueryData(remote, {});
    applyPluginManagementEvent(queryClient, { hostId: "local", accountEpoch: 1, kind: "plugins" });
    expect(queryClient.getQueryState(local)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(remote)?.isInvalidated).toBe(false);
  });
});
