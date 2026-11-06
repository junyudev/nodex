import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, type ModelPolicy } from "../../../shared/model-policy";
import { installWindowApi } from "../../test/browser-globals";
import { resetModelPolicyOwnersForTests, useModelPolicy } from "./model-policy";

let saved: ModelPolicy;
let rejectSave = false;
const clients: QueryClient[] = [];
const listeners = new Set<(settings: ModelPolicy) => void>();
const invoke = vi.fn(async (channel: string, input?: ModelPolicy) => {
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
  invoke.mockClear();
  resetModelPolicyOwnersForTests();
  installWindowApi({
    invoke,
    on: (channel: string, callback: (settings: ModelPolicy) => void) => {
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
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook(useModelPolicy, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
it("shares canonical policy across windows and does not replay delayed notification values", async () => {
  const first = mount();
  const second = mount();
  await waitFor(() => {
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
  });
  const desired: ModelPolicy = {
    providersOff: ["nodex"],
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
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  rejectSave = true;
  await act(async () => {
    await expect(
      hook.result.current.updateSettings({ ...saved, providersOff: ["nodex"] }),
    ).rejects.toThrow("Write failed");
  });
  expect(hook.result.current.settings).toEqual(DEFAULT_MODEL_POLICY);
  expect(hook.result.current.isSaving).toBe(false);
});
