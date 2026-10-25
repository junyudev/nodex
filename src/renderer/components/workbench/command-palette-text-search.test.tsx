import { useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceDirectoryEntriesResult,
} from "../../../shared/types";
import type { WorkspaceTextSearchMatch } from "../../../shared/workspace-text-search";
import { renderWithAppMaitai } from "../../test/app-maitai";
import { openNodexMenu } from "../../test/dom";
import { NodexModalHost } from "@/lib/modal-registry";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { CommandPaletteWorkspaceToolbar } from "./command-palette-workspace-toolbar";
import { CommandPaletteFolderPicker } from "./command-palette-folder-picker";
import {
  CommandPaletteTextHistoryRecorder,
  CommandPaletteTextRow,
  CommandPaletteTextStatus,
  CommandPaletteTextToolbar,
  workspaceTextSearchResultLabels,
} from "./command-palette-text-search";

const mocks = vi.hoisted(() => ({
  directory:
    vi.fn<(input: WorkspaceDirectoryEntriesInput) => Promise<WorkspaceDirectoryEntriesResult>>(),
}));
vi.mock("@/lib/command-palette-workspace-operations", () => ({
  commandPaletteDirectoryQueryOptions: (input: WorkspaceDirectoryEntriesInput) => ({
    queryKey: ["directory", input],
    queryFn: () => mocks.directory(input),
    retry: false,
  }),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const scope = { hostId: "ssh:test", roots: ["/workspace"] };
const matchingLine: WorkspaceTextSearchMatch = {
  path: "/workspace/src/a.ts",
  root: "/workspace",
  relativePath: "src/a.ts",
  line: 8,
  column: 4,
  preview: "🙂 word word",
  matchRanges: [
    { start: 3, end: 7 },
    { start: 8, end: 12 },
  ],
};

test("mask input commits on Enter, ignores composition, recalls masks and restores focus", async () => {
  const commit = vi.fn();
  const focusSearch = vi.fn();
  function Harness() {
    const [fileMask, setFileMask] = useState("*.ts");
    return (
      <CommandPaletteTextToolbar
        scope={scope}
        focusSearch={focusSearch}
        onScopeChange={vi.fn()}
        history={{
          fileMask,
          setFileMask,
          queries: [],
          masks: ["*.md", "*.ts"],
          commit: (query?: string, mask?: string) => {
            const nextMask = mask ?? fileMask;
            setFileMask(nextMask);
            commit(query, nextMask);
          },
        }}
      />
    );
  }
  const view = renderWithAppMaitai(<Harness />);
  const input = view.getByRole("textbox", { name: "File types" });
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await Promise.resolve();
  });
  expect(focusSearch).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.change(input, { target: { value: "*.tsx" } });
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(commit).toHaveBeenLastCalledWith(undefined, "*.tsx");
  expect(focusSearch).toHaveBeenCalledOnce();
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await Promise.resolve();
  });
  const previous = await view.findByRole("menuitem", { name: "*.md" });
  await act(async () => {
    fireEvent.click(previous);
    await Promise.resolve();
  });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("*.md"));
  await waitFor(() => expect(document.activeElement).toBe(input));
});

test("folder chooser survives toolbar removal and selects a directory on its original host", async () => {
  mocks.directory.mockResolvedValue({
    directoryPath: "workspace",
    parentPath: "",
    entries: [{ name: "nested", path: "workspace/nested", type: "directory", isSymlink: false }],
  });
  const selected = vi.fn();
  const focusSearch = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (toolbar: boolean) => (
    <QueryClientProvider client={queryClient}>
      {toolbar ? (
        <CommandPaletteWorkspaceToolbar
          scope={scope}
          onScopeChange={selected}
          focusSearch={focusSearch}
        />
      ) : null}
      <NodexModalHost />
    </QueryClientProvider>
  );
  const view = renderWithAppMaitai(content(true));
  await openNodexMenu(view.getByRole("button", { name: "Search folder" }));
  const chooseFolder = await view.findByRole("menuitem", { name: "Choose folder" });
  await act(async () => {
    fireEvent.click(chooseFolder);
    await Promise.resolve();
  });
  await view.findByRole("dialog", { name: "Choose search folder" });
  view.rerender(content(false));
  const nested = await view.findByRole("option", { name: "nested" });
  expect(mocks.directory).toHaveBeenCalledWith({
    hostId: "ssh:test",
    workspaceRoot: "/",
    directoryPath: "workspace",
    directoriesOnly: true,
    includeHidden: false,
  });
  await act(async () => {
    fireEvent.click(nested);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Choose folder" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(selected).toHaveBeenCalledWith({ hostId: "ssh:test", roots: ["/workspace/nested"] }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test("folder chooser can navigate above the resolved host home", async () => {
  mocks.directory.mockImplementation(async (input) => ({
    workspaceRoot: input.workspaceRoot === "~" ? "/Users/example" : input.workspaceRoot,
    directoryPath: input.directoryPath ?? "",
    parentPath: null,
    entries: [],
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithAppMaitai(
    <QueryClientProvider client={queryClient}>
      <CommandPaletteFolderPicker
        scope={null}
        onSelect={() => undefined}
        onClose={() => undefined}
        focusSearch={() => undefined}
      />
    </QueryClientProvider>,
  );
  const parent = view.getByRole("button", { name: "Parent folder" }) as HTMLButtonElement;
  await waitFor(() => expect(parent.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(parent);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(mocks.directory).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "local", workspaceRoot: "/", directoryPath: "Users" }),
    ),
  );
  expect((view.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement).value).toBe(
    "/Users",
  );
});

test("renders UTF16 match ranges and disambiguates only colliding filenames", () => {
  const matches = [
    matchingLine,
    { ...matchingLine, path: "/workspace/tests/a.ts", relativePath: "tests/a.ts" },
    { ...matchingLine, path: "/workspace/b.ts", relativePath: "b.ts" },
  ];
  const labels = workspaceTextSearchResultLabels(matches, ["/workspace"]);
  expect([...labels.values()]).toEqual(["src/a.ts", "tests/a.ts", "b.ts"]);
  const view = renderWithAppMaitai(
    <CommandPaletteTextRow match={matchingLine} pathLabel={labels.get(matchingLine.path)} />,
  );
  expect([...view.container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
    "word",
    "word",
  ]);
});

test("shows delayed progress and a terminal limit status without selectable rows", async () => {
  vi.useFakeTimers();
  const result = {
    matches: [],
    matchesCurrent: false,
    loading: true,
    refreshing: false,
    limited: false,
    error: null,
    queryValid: true,
    requestKey: "query",
  };
  const view = renderWithAppMaitai(
    <CommandPaletteTextStatus result={result} mode="text" query="word" hasScope />,
  );
  expect(view.queryByRole("progressbar")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(view.getByRole("progressbar", { name: "Find in files" })).toBeTruthy();
  view.rerender(
    <CommandPaletteTextStatus
      result={{
        ...result,
        loading: false,
        limited: true,
        matchesCurrent: true,
        matches: [matchingLine],
      }}
      mode="text"
      query="word"
      hasScope
    />,
  );
  expect(view.getByRole("status").textContent).toBe("Showing first 100 matching lines");
  expect(view.queryByRole("option")).toBeNull();
});

test("records only the latest query and mask when leaving the mounted Text scope", () => {
  const commit = vi.fn();
  const history = { fileMask: "*.ts", queries: [], masks: [], setFileMask: vi.fn(), commit };
  const view = renderWithAppMaitai(
    <CommandPaletteTextHistoryRecorder query="w" history={history} />,
  );
  view.rerender(
    <CommandPaletteTextHistoryRecorder query="word" history={{ ...history, fileMask: "*.md" }} />,
  );
  expect(commit).not.toHaveBeenCalled();
  view.unmount();
  expect(commit.mock.calls).toEqual([["word", "*.md"]]);
});

test("Escape dismisses only the mask menu or folder chooser and restores the owning input", async () => {
  mocks.directory.mockResolvedValue({ directoryPath: "workspace", parentPath: "", entries: [] });
  const closePalette = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const search = useRef<HTMLInputElement>(null);
    return (
      <QueryClientProvider client={queryClient}>
        <NodexDialog
          open
          onOpenChange={(open) => {
            if (!open) closePalette();
          }}
        >
          <NodexDialogContent>
            <NodexDialogTitle>Command palette</NodexDialogTitle>
            <input ref={search} aria-label="Command palette search" />
            <CommandPaletteTextToolbar
              scope={scope}
              onScopeChange={vi.fn()}
              focusSearch={() => search.current?.focus()}
              history={{
                fileMask: "*.ts",
                queries: [],
                masks: ["*.md"],
                setFileMask: vi.fn(),
                commit: vi.fn(),
              }}
            />
          </NodexDialogContent>
        </NodexDialog>
        <NodexModalHost />
      </QueryClientProvider>
    );
  }
  const view = renderWithAppMaitai(<Harness />);
  const palette = await view.findByRole("dialog", { name: "Command palette" });
  const maskInput = within(palette).getByRole("textbox", { name: "File types" });
  await openNodexMenu(within(palette).getByRole("button", { name: "Previous file types" }));
  const mask = await view.findByRole("menuitem", { name: "*.md" });
  await act(async () => {
    fireEvent.keyDown(mask, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(maskInput));
  expect(closePalette).not.toHaveBeenCalled();
  await openNodexMenu(within(palette).getByRole("button", { name: "Search folder" }));
  const choose = await view.findByRole("menuitem", { name: "Choose folder" });
  await act(async () => {
    fireEvent.click(choose);
    await Promise.resolve();
  });
  const picker = await view.findByRole("dialog", { name: "Choose search folder" });
  await act(async () => {
    fireEvent.keyDown(within(picker).getByRole("textbox", { name: "Folder path" }), {
      key: "Escape",
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Choose search folder" })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(palette).getByRole("textbox", { name: "Command palette search" }),
    ),
  );
  expect(view.getByRole("dialog", { name: "Command palette" })).toBe(palette);
  expect(closePalette).not.toHaveBeenCalled();
});
