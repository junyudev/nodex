import { createElement, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
  focusManager,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useInstalledPlugins,
  usePluginCapabilities,
  usePluginSearch,
  useMcpOauthCompletion,
  usePluginDetail,
  usePluginApps,
  usePluginAppTools,
  useMcpAppDataCapabilities,
  usePluginManagement,
} from "./plugin-management";
import {
  queryPluginManagement,
  subscribePluginManagement,
} from "../../lib/plugin-management-adapter";
import { NodexQueryProvider } from "../../lib/query-client";
import { pluginManagementKeys } from "../../lib/plugin-management-query-keys";
import { installWindowApi } from "../../test/browser-globals";
import { pluginRow } from "../../../shared/test-fixtures/plugins";
vi.mock("../../lib/plugin-management-adapter", () => ({
  queryPluginManagement: vi.fn(),
  commandPluginManagement: vi.fn(),
  subscribePluginManagement: vi.fn(() => () => {}),
  subscribePluginProjectChanges: vi.fn(() => () => {}),
}));
const clients: QueryClient[] = [];
const wrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
};
const context = { hostId: "local", projectId: null } as const;
const scope = { ...context, accountEpoch: 1, hostGeneration: 1, bindingRevision: null, cwds: [] };
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});
it("keeps native inventory available when the selected ChatGPT capability feed fails", async () => {
  vi.mocked(queryPluginManagement).mockImplementation(async (name) => {
    if (name === "context") return scope as never;
    if (name === "capabilities") throw new Error("Directory unavailable");
    return {
      context: scope,
      response: { marketplaces: [], marketplaceLoadErrors: [] },
      rows: [pluginRow()],
    } as never;
  });
  const hook = renderHook(
    () => ({
      installed: useInstalledPlugins(context),
      capabilities: usePluginCapabilities(context),
    }),
    { wrapper: wrapper() },
  );
  await waitFor(() => {
    expect(hook.result.current.capabilities.isError).toBe(true);
    expect(hook.result.current.installed.data).toHaveLength(1);
  });
  expect(hook.result.current.installed.isError).toBe(false);
});
it("debounces new search terms while retaining the last settled rows", async () => {
  vi.mocked(queryPluginManagement).mockImplementation(async (name, input) => {
    if (name === "context") return scope as never;
    const term = "term" in input ? input.term : "";
    return {
      rows: [pluginRow({ nativeId: term, stableIdentity: term })],
      nextCursor: null,
    } as never;
  });
  const hook = renderHook(({ term }) => usePluginSearch(context, term), {
    initialProps: { term: "first" },
    wrapper: wrapper(),
  });
  await waitFor(() => expect(hook.result.current.rows[0]?.nativeId).toBe("first"));
  await act(async () => {
    hook.rerender({ term: "second" });
    await Promise.resolve();
  });
  expect(hook.result.current.rows[0]?.nativeId).toBe("first");
  expect(
    vi
      .mocked(queryPluginManagement)
      .mock.calls.some(
        ([name, input]) => name === "search" && "term" in input && input.term === "second",
      ),
  ).toBe(false);
  await waitFor(() => expect(hook.result.current.rows[0]?.nativeId).toBe("second"));
});

it("clears account-scoped caches while no Customize hook is mounted", async () => {
  installWindowApi({ invoke: async () => undefined, on: () => () => {} });
  let changed: Parameters<typeof subscribePluginManagement>[0] | undefined;
  vi.mocked(subscribePluginManagement).mockImplementation((listener) => {
    changed = listener;
    return () => {};
  });
  const Provider = ({ children }: { children: ReactNode }) =>
    createElement(NodexQueryProvider, null, children);
  const hook = renderHook(() => useQueryClient(), { wrapper: Provider });
  const key = pluginManagementKeys.resource(scope, "installed");
  hook.result.current.setQueryData(key, { rows: [pluginRow()] });
  await waitFor(() => expect(changed).toBeDefined());
  await act(async () => {
    changed!({ hostId: "local", accountEpoch: 2, kind: "account" });
    await Promise.resolve();
  });
  expect(hook.result.current.getQueryData(key)).toBeUndefined();
});

it("updates the MCP OAuth observation from the scoped subscription after the hook settles", async () => {
  vi.mocked(queryPluginManagement).mockResolvedValue(scope as never);
  const hook = renderHook(() => useMcpOauthCompletion(context), { wrapper: wrapper() });
  await waitFor(() => expect(queryPluginManagement).toHaveBeenCalledWith("context", context));
  await waitFor(() => expect(subscribePluginManagement).toHaveBeenCalled());
  const listener = vi.mocked(subscribePluginManagement).mock.calls[0]?.[0];
  await waitFor(() =>
    expect(clients.at(-1)?.getQueryData(pluginManagementKeys.context(context))).toEqual(scope),
  );
  await act(async () => {
    listener?.({
      hostId: "local",
      hostGeneration: 1,
      accountEpoch: 1,
      kind: "mcp",
      mcpOauthCompletion: { name: "server", threadId: null, success: true },
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(hook.result.current.data).toEqual({ name: "server", threadId: null, success: true }),
  );
});

it("refreshes detail and app connections on focus after an external browser flow", async () => {
  vi.mocked(queryPluginManagement).mockImplementation(
    async (name) => (name === "context" ? scope : {}) as never,
  );
  const hook = renderHook(
    () => ({
      detail: usePluginDetail(
        context,
        { marketplacePath: "/catalog", pluginName: "test" },
        { refreshAppConnectionsOnFocus: true },
      ),
      apps: usePluginApps(context, { refreshOnFocus: true }),
    }),
    { wrapper: wrapper() },
  );
  await waitFor(() =>
    expect(hook.result.current.detail.isSuccess && hook.result.current.apps.isSuccess).toBe(true),
  );
  const reads = () =>
    vi.mocked(queryPluginManagement).mock.calls.filter(([name]) => name === "read");
  const before = reads().length;
  try {
    await act(async () => {
      focusManager.setFocused(false);
      await Promise.resolve();
    });
    await act(async () => {
      focusManager.setFocused(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(reads().length).toBeGreaterThan(before));
    expect(reads().at(-1)?.[1]).toMatchObject({ forceRefreshApps: true });
    expect(
      vi
        .mocked(queryPluginManagement)
        .mock.calls.filter(([name]) => name === "apps")
        .at(-1)?.[1],
    ).toMatchObject({ forceRefresh: true });
    await waitFor(() =>
      expect(hook.result.current.detail.isFetching || hook.result.current.apps.isFetching).toBe(
        false,
      ),
    );
  } finally {
    await act(async () => {
      focusManager.setFocused(undefined);
      await Promise.resolve();
    });
  }
});

it("loads the selected app's native tool view through its scoped query", async () => {
  const view = {
    appId: "connector_test",
    tools: [{ name: "read", description: "Read", isReadOnly: true }],
    available: true,
    error: null,
    events: [],
    eventsAvailable: false,
  };
  vi.mocked(queryPluginManagement).mockImplementation(
    async (name) => (name === "context" ? scope : view) as never,
  );
  const hook = renderHook(() => usePluginAppTools(context, "connector_test"), {
    wrapper: wrapper(),
  });
  await waitFor(() => expect(hook.result.current.data).toEqual(view));
  expect(
    vi.mocked(queryPluginManagement).mock.calls.filter(([name]) => name === "app-tools"),
  ).toEqual([["app-tools", { ...context, appId: "connector_test" }]]);
});

it("exposes sandbox data clearing independently of native agent readiness and returns typed transport uncertainty", async () => {
  vi.mocked(queryPluginManagement).mockRejectedValue(new Error("Agent offline"));
  let fail = false;
  const success = { status: "success", value: undefined, refreshFailures: [] };
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "mcp-app:data:capabilities") return { available: true };
    if (channel === "mcp-app:data:clear") {
      if (fail) throw new Error("Transport stopped");
      return success;
    }
    throw new Error(`Unexpected channel: ${channel}`);
  });
  installWindowApi({ invoke, on: () => () => {} });
  const hook = renderHook(
    () => ({
      capability: useMcpAppDataCapabilities(context),
      management: usePluginManagement(context),
    }),
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(hook.result.current.capability.data?.available).toBe(true));
  await act(async () => {
    expect(await hook.result.current.management.clearMcpAppData()).toEqual(success);
  });
  expect(invoke).toHaveBeenCalledWith("mcp-app:data:clear", context);
  fail = true;
  await act(async () => {
    expect(await hook.result.current.management.clearMcpAppData()).toMatchObject({
      status: "failed",
      error: { code: "mutation_outcome_unknown" },
    });
  });
});
