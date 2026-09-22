import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DictationDictionaryDialog } from "./dictation-dictionary-dialog";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  importWords: vi.fn(),
  dispose: vi.fn(),
  activate: vi.fn(),
  danger: vi.fn(),
}));
vi.mock("./dictation-dictionary-runtime", () => ({
  createDictationDictionarySession: () => ({ id: "session-a", ...mocks }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: mocks.danger } }));
const snapshot = {
  target: { accountId: "account-a", userId: "user-a" },
  words: [
    { id: "1", text: "Nodex" },
    { id: "2", text: "Effect" },
  ],
  maxWords: 200,
  localWords: ["Alpha", "Beta"],
};
const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <DictationDictionaryDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const change = async (name: string, value: string) => {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(snapshot);
  mocks.add.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.importWords.mockResolvedValue(undefined);
});

test("adds trimmed text, refreshes words, searches case-insensitively, and deletes the chosen id", async () => {
  show();
  await screen.findByRole("button", { name: "Remove Nodex" });
  await change("Add word", "  Widget  ");
  await click("Add");
  await waitFor(() => expect(mocks.add).toHaveBeenCalledWith("Widget"));
  await waitFor(() =>
    expect((screen.getByRole("textbox", { name: "Add word" }) as HTMLInputElement).value).toBe(""),
  );
  await change("Search words", " nOd ");
  expect(screen.queryByRole("button", { name: "Remove Effect" })).toBeNull();
  await click("Remove Nodex");
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("1"));
});

test("previews local words and imports only explicitly confirmed selections", async () => {
  show();
  await screen.findByRole("button", { name: "Import words from this device…" });
  await click("Import words from this device…");
  expect(mocks.importWords).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
  });
  await click("Import words");
  await waitFor(() => expect(mocks.importWords).toHaveBeenCalledWith(["Alpha"]));
  await screen.findByRole("textbox", { name: "Add word" });
});

test("keeps the preview and selection after a partial import failure", async () => {
  mocks.importWords.mockRejectedValue(new Error("account changed"));
  show();
  await screen.findByRole("button", { name: "Import words from this device…" });
  await click("Import words from this device…");
  await click("Import words");
  await waitFor(() => expect(mocks.danger).toHaveBeenCalledTimes(1));
  expect((screen.getByRole("checkbox", { name: "Alpha" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
  expect(mocks.read.mock.calls.length).toBeGreaterThan(1);
});

test("disables adding at server capacity and allows load retry", async () => {
  mocks.read
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ...snapshot, maxWords: 2 });
  const view = show();
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  await click("Retry");
  await screen.findByRole("button", { name: "Remove Nodex" });
  expect((screen.getByRole("textbox", { name: "Add word" }) as HTMLInputElement).disabled).toBe(
    true,
  );
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
