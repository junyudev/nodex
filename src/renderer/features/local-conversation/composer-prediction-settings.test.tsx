import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installWindowApi } from "../../test/browser-globals";
import {
  resetComposerPredictionSettingsOwnersForTests,
  useComposerPredictionSettings,
} from "./composer-prediction-settings";

const listeners = new Set<(settings: { enabled: boolean }) => void>();
const clients: QueryClient[] = [];
let saved = true;
let rejectSave = false;
const invoke = vi.fn(async (channel: string, value?: { enabled: boolean }) => {
  if (channel === "settings:composer-predictions:get") return { enabled: saved };
  if (channel !== "settings:composer-predictions:update" || !value) throw new Error(channel);
  if (rejectSave) throw new Error("Write failed");
  saved = value.enabled;
  for (const listener of listeners) listener({ enabled: saved });
  return { enabled: saved };
});

beforeEach(() => {
  saved = true;
  rejectSave = false;
  invoke.mockClear();
  resetComposerPredictionSettingsOwnersForTests();
  installWindowApi({
    invoke,
    on: (channel: string, listener: (settings: { enabled: boolean }) => void) => {
      if (channel !== "composer-prediction-settings-changed") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  expect(listeners.size).toBe(0);
});

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  if (!clients.includes(client)) clients.push(client);
  return renderHook(useComposerPredictionSettings, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

it("restores the Profile preference and synchronizes separate window owners", async () => {
  saved = false;
  const first = mount();
  const second = mount();
  await waitFor(() => {
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.settings.enabled).toBe(false);
  });
  await act(async () => {
    await first.result.current.updateSettings({ enabled: true });
  });
  expect(saved).toBe(true);
  expect(first.result.current.settings.enabled).toBe(true);
  expect(second.result.current.settings.enabled).toBe(true);
  expect(invoke).toHaveBeenCalledWith("settings:composer-predictions:update", { enabled: true });
});

it("rolls back a failed save to the last persisted preference", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  rejectSave = true;
  await act(async () => {
    await expect(hook.result.current.updateSettings({ enabled: false })).rejects.toThrow(
      "Write failed",
    );
  });
  expect(hook.result.current.settings.enabled).toBe(true);
  expect(hook.result.current.isSaving).toBe(false);
});

it("keeps a cross-window disable ahead of a stale initial read", async () => {
  let resolveRead!: (value: { enabled: boolean }) => void;
  invoke.mockImplementationOnce(
    async () =>
      await new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const hook = mount();
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  await act(async () => {
    saved = false;
    for (const listener of listeners) listener({ enabled: false });
    resolveRead({ enabled: true });
    await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.settings.enabled).toBe(false));
});

it("keeps the latest local intent when an older broadcast arrives before or after its response", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let resolveFirst!: (value: { enabled: boolean }) => void;
  let resolveSecond!: (value: { enabled: boolean }) => void;
  invoke.mockImplementationOnce(
    async () =>
      await new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  invoke.mockImplementationOnce(
    async () =>
      await new Promise((resolve) => {
        resolveSecond = resolve;
      }),
  );
  let first!: Promise<{ enabled: boolean }>;
  let second!: Promise<{ enabled: boolean }>;
  await act(async () => {
    first = hook.result.current.updateSettings({ enabled: false });
    second = hook.result.current.updateSettings({ enabled: true });
    // A's notification is late: B is already the persisted value.
    saved = true;
    for (const listener of listeners) listener({ enabled: false });
    resolveSecond({ enabled: true });
    await second;
  });
  expect(hook.result.current.settings.enabled).toBe(true);
  await act(async () => {
    resolveFirst({ enabled: false });
    await first;
    for (const listener of listeners) listener({ enabled: false });
  });
  await waitFor(() => expect(hook.result.current.isSaving).toBe(false));
  expect(hook.result.current.settings.enabled).toBe(true);
});

it("reads a newer remote write after a delayed local response", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let resolveUpdate!: (value: { enabled: boolean }) => void;
  invoke.mockImplementationOnce(
    async () =>
      await new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
  );
  let update!: Promise<{ enabled: boolean }>;
  await act(async () => {
    update = hook.result.current.updateSettings({ enabled: false });
    saved = true;
    for (const listener of listeners) listener({ enabled: true });
    resolveUpdate({ enabled: false });
    await update;
  });
  await waitFor(() => expect(hook.result.current.settings.enabled).toBe(true));
});

it("revalidates after an unsubscribed interval even with an infinite shared query stale time", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const first = mount(client);
  await waitFor(() => expect(first.result.current.isLoading).toBe(false));
  first.unmount();
  expect(listeners.size).toBe(0);
  saved = false;
  const reopened = mount(client);
  await waitFor(() => expect(reopened.result.current.settings.enabled).toBe(false));
});
