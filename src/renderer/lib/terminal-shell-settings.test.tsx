import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  type TerminalShellSettings,
} from "../../shared/terminal-shell-settings";
import { installWindowApi } from "../test/browser-globals";
import {
  resetTerminalShellSettingsOwnersForTests,
  useTerminalShellSettings,
} from "./terminal-shell-settings";

let saved: TerminalShellSettings;
const clients: QueryClient[] = [];
const listeners = new Set<(settings: TerminalShellSettings) => void>();
const invoke = vi.fn(async (channel: string, input?: TerminalShellSettings) => {
  if (channel === "settings:terminal-shell:get") return saved;
  if (channel !== "settings:terminal-shell:update" || !input) throw new Error(channel);
  saved = input;
  for (const listener of listeners) listener(saved);
  return saved;
});
beforeEach(() => {
  saved = { ...DEFAULT_TERMINAL_SHELL_SETTINGS };
  invoke.mockClear();
  resetTerminalShellSettingsOwnersForTests();
  installWindowApi({
    invoke,
    on: (channel: string, callback: (settings: TerminalShellSettings) => void) => {
      if (channel !== "terminal-shell-settings-changed") return () => {};
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
  return renderHook(useTerminalShellSettings, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
it("synchronizes shell preference changes across independent windows", async () => {
  const first = mount();
  const second = mount();
  await waitFor(() => {
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await first.result.current.updateSettings({ windowsShell: "git-bash" });
  });
  await waitFor(() => expect(second.result.current.settings).toEqual({ windowsShell: "git-bash" }));
  expect(first.result.current.settings).toEqual({ windowsShell: "git-bash" });
  await act(async () => {
    saved = { windowsShell: "cmd" };
    // Delayed notification payloads are invalidations, not authoritative values.
    for (const listener of listeners) listener({ windowsShell: "git-bash" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(first.result.current.settings).toEqual({ windowsShell: "cmd" });
    expect(second.result.current.settings).toEqual({ windowsShell: "cmd" });
  });
});
