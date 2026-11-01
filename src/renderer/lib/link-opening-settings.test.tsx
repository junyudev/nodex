import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_LINK_OPENING_SETTINGS,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import { installWindowApi } from "../test/browser-globals";
import {
  resetLinkOpeningSettingsOwnersForTests,
  useLinkOpeningSettings,
} from "./link-opening-settings";

let saved: LinkOpeningSettings;
let rejectSave = false;
const clients: QueryClient[] = [];
const listeners = new Set<(settings: LinkOpeningSettings) => void>();
const invoke = vi.fn(async (channel: string, input?: LinkOpeningSettings) => {
  if (channel === "settings:link-opening:get") return saved;
  if (channel !== "settings:link-opening:update" || !input) throw new Error(channel);
  if (rejectSave) throw new Error("Write failed");
  saved = input;
  for (const listener of listeners) listener(saved);
  return saved;
});
beforeEach(() => {
  saved = { ...DEFAULT_LINK_OPENING_SETTINGS };
  rejectSave = false;
  invoke.mockClear();
  resetLinkOpeningSettingsOwnersForTests();
  installWindowApi({
    invoke,
    on: (channel: string, callback: (settings: LinkOpeningSettings) => void) => {
      if (channel !== "link-opening-settings-changed") return () => {};
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
  return renderHook(useLinkOpeningSettings, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
it("loads effective preferences and publishes independent destination changes across windows", async () => {
  const first = mount();
  const second = mount();
  await waitFor(() => {
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
  });
  const desired = {
    ...DEFAULT_LINK_OPENING_SETTINGS,
    openLinkInTarget: "in-app-browser",
    externalBrowserLinkShortcut: "alt",
  } as const;
  await act(async () => {
    await first.result.current.updateSettings(desired);
  });
  await waitFor(() => expect(second.result.current.settings).toEqual(desired));
  expect(first.result.current.settings).toEqual(desired);
  expect(saved.openLocalUrlInTarget).toBe("in-app-browser");
  expect(invoke).toHaveBeenCalledWith("settings:link-opening:update", desired);
});
it("rolls back failed preference writes to the saved Profile values", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  rejectSave = true;
  await act(async () => {
    await expect(
      hook.result.current.updateSettings({ ...saved, openLocalUrlInTarget: "external-browser" }),
    ).rejects.toThrow("Write failed");
  });
  expect(hook.result.current.settings).toEqual(DEFAULT_LINK_OPENING_SETTINGS);
  expect(hook.result.current.isSaving).toBe(false);
});
