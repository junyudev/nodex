import { act, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vite-plus/test";
import { createCommandKeymapState } from "../../../shared/command-keybindings";
import { render } from "@/test/dom";
import { queryKeys } from "@/lib/query-keys";
import { click } from "./agent-instance-settings.test-fixtures";
import { KeyboardShortcutsSettingsPage } from "./keyboard-shortcuts-settings-page";

const update = vi.hoisted(() => vi.fn());
const state = createCommandKeymapState({}, "macOS");
const entry = state.entries.find((candidate) => candidate.id === "newThread")!;
const keymap = { ...state, entries: [entry] };
vi.mock("@/lib/use-command-keymap-state", () => ({
  useCommandKeymapState: () => ({ data: keymap, isLoading: false, isError: false }),
  updateCommandKeybinding: (...args: unknown[]) => update(...args),
  resetCommandKeybindings: vi.fn(),
}));
vi.mock("./link-opening-settings-controls", () => ({
  ExternalBrowserLinkShortcutSettingRow: () => null,
}));

test("keeps a failed shortcut capture editable and commits a successful retry", async () => {
  update.mockReset();
  update.mockRejectedValueOnce(new Error("Shortcut could not be saved"));
  update.mockResolvedValueOnce({ type: "applied", state: keymap });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <KeyboardShortcutsSettingsPage />
    </QueryClientProvider>,
  );
  await click(view.getAllByRole("button", { name: `Change shortcut for ${entry.title}` })[0]!);
  const capture = view.getByRole("textbox", { name: `${entry.title} hotkey capture` });
  await act(async () => {
    fireEvent.keyDown(capture, { key: "y", code: "KeyY", metaKey: true });
    await Promise.resolve();
  });
  await view.findByText("Shortcut could not be saved");
  await waitFor(() => expect(capture).toHaveProperty("disabled", false));
  expect(update).toHaveBeenCalledWith("newThread", {
    type: "replace",
    oldKeybinding: entry.keybindings[0],
    newKeybinding: { key: "CmdOrCtrl+Y" },
  });
  await act(async () => {
    fireEvent.keyDown(capture, { key: "z", code: "KeyZ", metaKey: true });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(view.queryByRole("textbox", { name: `${entry.title} hotkey capture` })).toBeNull();
    expect(view.queryByText("Shortcut could not be saved")).toBeNull();
  });
  expect(client.getQueryData(queryKeys.settings.commandKeymap())).toEqual(keymap);
  expect(update).toHaveBeenCalledTimes(2);
});
