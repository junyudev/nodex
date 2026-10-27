import { createRef, useRef, useState } from "react";
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
        contextScope={scope}
        focusSearch={focusSearch}
        onSelectionChange={vi.fn()}
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (toolbar: boolean) => (
    <QueryClientProvider client={queryClient}>
      {toolbar ? (
        <CommandPaletteWorkspaceToolbar contextScope={scope} onSelectionChange={selected} />
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
    includeHidden: true,
  });
  await act(async () => {
    fireEvent.click(nested);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Choose" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(selected).toHaveBeenCalledWith({
      kind: "directory",
      scope: { hostId: "ssh:test", roots: ["/workspace/nested"] },
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test.each([false, true])(
  "folder selection restores focus with an external control ref: %s",
  async (external) => {
    const control = createRef<HTMLButtonElement>();
    const view = renderWithAppMaitai(
      <CommandPaletteWorkspaceToolbar
        contextScope={scope}
        onSelectionChange={vi.fn()}
        firstControlRef={external ? control : undefined}
        onChooseFolder={async () => null}
      />,
    );
    const trigger = view.getByRole("button", { name: "Search folder" });
    if (external) expect(control.current).toBe(trigger);
    await openNodexMenu(trigger);
    const choose = await view.findByRole("menuitem", { name: "Choose folder" });
    await act(async () => {
      fireEvent.click(choose);
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    view.unmount();
    expect(control.current).toBeNull();
  },
);

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
        onRestoreFocus={() => undefined}
      />
    </QueryClientProvider>,
  );
  const parent = view.getByRole("button", { name: "Go to parent folder" }) as HTMLButtonElement;
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
  expect(
    (view.getByRole("combobox", { name: "Selected folder path" }) as HTMLInputElement).value,
  ).toBe("/Users");
});

function renderFolderPicker(onSelect = vi.fn(), onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...renderWithAppMaitai(
      <QueryClientProvider client={queryClient}>
        <CommandPaletteFolderPicker
          scope={scope}
          onSelect={onSelect}
          onClose={onClose}
          onRestoreFocus={() => undefined}
        />
      </QueryClientProvider>,
    ),
    onSelect,
    onClose,
  };
}

function installFolderHierarchy() {
  mocks.directory.mockImplementation(async (input) => {
    const directoryPath = input.directoryPath ?? "";
    const names = directoryPath === "workspace" ? ["Alpha", "alpine", "Beta", ".hidden"] : [];
    return {
      workspaceRoot: "/",
      directoryPath,
      parentPath: directoryPath === "" ? null : "",
      entries: names.map((name) => ({
        name,
        path: `${directoryPath}/${name}`,
        type: "directory" as const,
        isSymlink: false,
      })),
    };
  });
}

test("folder chooser requires explicit selection and can select the displayed current folder", async () => {
  installFolderHierarchy();
  const view = renderFolderPicker();
  await view.findByRole("option", { name: ".hidden" });
  const input = view.getByRole("combobox", { name: "Selected folder path" });
  const choose = view.getByRole("button", { name: "Choose" }) as HTMLButtonElement;
  expect((input as HTMLInputElement).value).toBe("/workspace");
  expect(choose.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Select current folder" }));
    await Promise.resolve();
  });
  expect(choose.disabled).toBe(false);
  expect(view.queryByRole("button", { name: "Select current folder" })).toBeNull();
  await act(async () => {
    fireEvent.click(choose);
    await Promise.resolve();
  });
  expect(view.onSelect).toHaveBeenCalledWith({ hostId: "ssh:test", roots: ["/workspace"] });
  expect(view.onClose).toHaveBeenCalledOnce();
});

test("folder path completion wraps candidates and Enter selects without entering or closing", async () => {
  installFolderHierarchy();
  const view = renderFolderPicker();
  await view.findByRole("option", { name: "Beta" });
  const input = view.getByRole("combobox", { name: "Selected folder path" });
  await act(async () => {
    fireEvent.change(input, { target: { value: "/workspace/AL" } });
    await Promise.resolve();
  });
  const alpha = await view.findByRole("option", { name: "Alpha" });
  const alpine = view.getByRole("option", { name: "alpine" });
  expect(view.queryByRole("option", { name: "Beta" })).toBeNull();
  expect(input.getAttribute("aria-autocomplete")).toBe("list");
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await Promise.resolve();
  });
  expect(input.getAttribute("aria-activedescendant")).toBe(alpine.id);
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await Promise.resolve();
  });
  expect(input.getAttribute("aria-activedescendant")).toBe(alpha.id);
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await Promise.resolve();
  });
  expect((input as HTMLInputElement).value).toBe("/workspace/AL");
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect((input as HTMLInputElement).value).toBe("/workspace/Alpha");
  expect(view.getByRole("option", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
  expect(view.getByRole("option", { name: "Beta" })).toBeTruthy();
  expect(view.onSelect).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Choose" }));
    await Promise.resolve();
  });
  expect(view.onSelect).toHaveBeenCalledWith({ hostId: "ssh:test", roots: ["/workspace/Alpha"] });
});

test("single-click enters a directory and trailing-separator input browses it directly", async () => {
  installFolderHierarchy();
  const view = renderFolderPicker();
  const alpha = await view.findByRole("option", { name: "Alpha" });
  await act(async () => {
    fireEvent.click(alpha);
    await Promise.resolve();
  });
  await view.findByText("No folders found in this directory.");
  const input = view.getByRole("combobox", { name: "Selected folder path" });
  expect((input as HTMLInputElement).value).toBe("/workspace/Alpha");
  await act(async () => {
    fireEvent.change(input, { target: { value: "relative" } });
    await Promise.resolve();
  });
  expect(view.getByText("Enter a full folder path to browse")).toBeTruthy();
  expect(view.queryByRole("listbox")).toBeNull();
  await act(async () => {
    fireEvent.change(input, { target: { value: "/workspace/" } });
    await Promise.resolve();
  });
  await view.findByRole("option", { name: "Beta" });
  await act(async () => {
    fireEvent.blur(input, { relatedTarget: view.getByRole("button", { name: "Cancel" }) });
    await Promise.resolve();
  });
  expect((input as HTMLInputElement).value).toBe("/workspace/");
  expect(view.onSelect).not.toHaveBeenCalled();
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

test("Escape dismisses one focused layer at a time and Cancel restores owning focus", async () => {
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
              contextScope={scope}
              onSelectionChange={vi.fn()}
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
  const path = within(picker).getByRole("combobox", { name: "Selected folder path" });
  // Dialog mount precedes its scheduled initial focus and the focused path hint.
  await waitFor(() => expect(document.activeElement).toBe(path));
  await view.findByRole("tooltip", { name: "/workspace" });
  await act(async () => {
    fireEvent.keyDown(path, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("tooltip")).toBeNull());
  expect(view.getByRole("dialog", { name: "Choose search folder" })).toBe(picker);
  expect(document.activeElement).toBe(path);
  expect(closePalette).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.keyDown(path, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Choose search folder" })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(palette).getByRole("button", { name: "Search folder" }),
    ),
  );
  expect(view.getByRole("dialog", { name: "Command palette" })).toBe(palette);
  expect(closePalette).not.toHaveBeenCalled();
  await openNodexMenu(within(palette).getByRole("button", { name: "Search folder" }));
  const chooseAgain = await view.findByRole("menuitem", { name: "Choose folder" });
  await act(async () => {
    fireEvent.click(chooseAgain);
    await Promise.resolve();
  });
  const pickerAgain = await view.findByRole("dialog", { name: "Choose search folder" });
  const pathAgain = within(pickerAgain).getByRole("combobox", { name: "Selected folder path" });
  await waitFor(() => expect(document.activeElement).toBe(pathAgain));
  await view.findByRole("tooltip", { name: "/workspace" });
  await act(async () => {
    fireEvent.click(within(pickerAgain).getByRole("button", { name: "Cancel" }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "Choose search folder" })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(palette).getByRole("button", { name: "Search folder" }),
    ),
  );
  expect(closePalette).not.toHaveBeenCalled();
});
