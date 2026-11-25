import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, type ModelPolicy } from "../../../shared/model-policy";
import { providerKeyRuntimeInstanceId } from "../../../shared/provider-keys";
import { agentRuntimeProviderFixture } from "../../../shared/testing/agent-runtime-snapshot";
import { queryKeys } from "../../lib/query-keys";
import { installWindowApi } from "../../test/browser-globals";
import {
  resetModelPolicyOwnersForTests,
  useModelPolicy,
  useModelPolicyCatalog,
} from "./model-policy";

let saved: ModelPolicy;
let rejectSave = false;
const clients: QueryClient[] = [];
const listeners = new Set<(settings: ModelPolicy) => void>();
const catalogListeners = new Set<() => void>();
let providers: ReturnType<typeof agentRuntimeProviderFixture>[];
const invoke = vi.fn(async (channel: string, input?: ModelPolicy) => {
  if (channel === "agent-runtime:providers:read") return providers;
  if (channel === "agent-runtime:activity:read") return { items: [], complete: true };
  if (channel === "agent-runtime:models:running-credit") return [];
  if (channel === "app-components:read") return { components: [] };
  if (channel === "settings:model-policy:get") return saved;
  if (channel !== "settings:model-policy:update" || !input) throw new Error(channel);
  if (rejectSave) throw new Error("Write failed");
  saved = input;
  for (const listener of listeners) listener(saved);
  return saved;
});
beforeEach(() => {
  saved = { ...DEFAULT_MODEL_POLICY };
  rejectSave = false;
  providers = [agentRuntimeProviderFixture()];
  invoke.mockClear();
  resetModelPolicyOwnersForTests();
  installWindowApi({
    invoke,
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel === "agent-runtime:providers:changed") {
        catalogListeners.add(callback);
        return () => {
          catalogListeners.delete(callback);
        };
      }
      if (channel !== "model-policy-changed") return () => {};
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  expect(listeners.size).toBe(0);
  expect(catalogListeners.size).toBe(0);
});
function mount<Result>(useHook: () => Result) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const hook = renderHook(useHook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}
it("shares canonical policy across windows and does not replay delayed notification values", async () => {
  const first = mount(useModelPolicy);
  const second = mount(useModelPolicy);
  await waitFor(() => {
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
  });
  const desired: ModelPolicy = {
    nodexOff: true,
    exceptions: [],
    agentsMayChooseCredit: false,
  };
  await act(async () => {
    await first.result.current.updateSettings(desired);
  });
  await waitFor(() => expect(second.result.current.settings).toEqual(desired));
  await act(async () => {
    for (const listener of listeners) listener(DEFAULT_MODEL_POLICY);
    await Promise.resolve();
  });
  await waitFor(() => expect(second.result.current.settings).toEqual(desired));
  expect(saved).toEqual(desired);
});
it("restores the canonical policy when a write fails", async () => {
  const hook = mount(useModelPolicy);
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  rejectSave = true;
  await act(async () => {
    await expect(hook.result.current.updateSettings({ ...saved, nodexOff: true })).rejects.toThrow(
      "Write failed",
    );
  });
  expect(hook.result.current.settings).toEqual(DEFAULT_MODEL_POLICY);
  expect(hook.result.current.isSaving).toBe(false);
});

const discoveredProviders = [
  {
    instanceId: "antigravity_work",
    driver: "antigravity",
    slug: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    publish: () => {
      for (const listener of catalogListeners) listener();
    },
  },
  {
    instanceId: providerKeyRuntimeInstanceId({ preset: "deepseek", id: "work" }),
    driver: "claudeAgent",
    slug: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    publish: (client: QueryClient) =>
      client.setQueryData(queryKeys.agentRuntime.providers(), providers),
  },
] as const;

it.each(discoveredProviders)(
  "adds models advertised after Settings opens by $instanceId",
  async ({ instanceId, driver, slug, name, publish }) => {
    const provider = agentRuntimeProviderFixture({ instanceId, driver, models: [] });
    providers = [...providers, provider];
    const { client, result } = mount(useModelPolicyCatalog);
    const instanceModels = () =>
      result.current.data?.providers.find((entry) => entry.instanceId === instanceId)?.models;
    await waitFor(() => expect(instanceModels()).toEqual([]));

    const model = { slug, name, isCustom: false, capabilities: null };
    await act(async () => {
      providers = providers.map((entry) =>
        entry.instanceId === instanceId ? { ...entry, models: [model] } : entry,
      );
      publish(client);
      await Promise.resolve();
    });

    await waitFor(() => expect(instanceModels()).toEqual([model]));
  },
);
