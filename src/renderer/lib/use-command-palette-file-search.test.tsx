import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { WorkspaceFileMetadata } from "../../shared/types";
import { invokeRendererQuery } from "./renderer-command";
import { readWorkspaceFileMetadata } from "./workspace-file-operations";
import { useFileSearch } from "./use-file-search";
import { useCommandPaletteFileSearch } from "./use-command-palette-file-search";

vi.mock("./renderer-command", () => ({
  defineRendererCommand: vi.fn(),
  invokePlainCommand: vi.fn(),
  invokeRendererQuery: vi.fn(),
}));
vi.mock("./query-options", () => ({ workspaceDirectoryQueryOptions: vi.fn() }));
vi.mock("./workspace-file-operations", () => ({ readWorkspaceFileMetadata: vi.fn() }));
vi.mock("./use-file-search", () => ({ useFileSearch: vi.fn() }));

const metadata = (isFile = true): WorkspaceFileMetadata => ({
  isFile,
  sizeBytes: 1,
  mtimeMs: null,
  createdAtMs: null,
});
const initial = {
  enabled: true,
  query: "/outside/file.ts",
  scope: { hostId: "remote", roots: ["/work"] },
  showRecent: false,
  restrictToRoots: false,
};

beforeEach(() => {
  vi.mocked(useFileSearch).mockReturnValue({ matches: [], loading: false, error: null });
  vi.mocked(readWorkspaceFileMetadata).mockResolvedValue(metadata());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

test("explicit paths bypass filename matching and preserve canonical host file/directory targets", async () => {
  const { result, rerender } = renderHook(useCommandPaletteFileSearch, { initialProps: initial });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.matches[0]).toMatchObject({ fsPath: "/outside/file.ts", kind: "file" });
  expect(useFileSearch).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  vi.mocked(readWorkspaceFileMetadata).mockResolvedValue(metadata(false));
  rerender({ ...initial, query: "/work/old/../src/" });
  await waitFor(() => expect(result.current.matches[0]?.fsPath).toBe("/work/src"));
  expect(readWorkspaceFileMetadata).toHaveBeenLastCalledWith({
    hostId: "remote",
    path: "/work/src",
  });
  expect(result.current.matches[0]?.kind).toBe("directory");
});

test("home paths resolve on their execution host before canonicalization and folder restrictions", async () => {
  vi.mocked(invokeRendererQuery).mockResolvedValue({
    workspaceRoot: "/remote/home",
    directoryPath: "",
    parentPath: null,
    entries: [],
  });
  const { result } = renderHook(useCommandPaletteFileSearch, {
    initialProps: {
      ...initial,
      query: "~/docs/../note.md",
      scope: { hostId: "remote", roots: ["/remote/home"] },
      restrictToRoots: true,
    },
  });
  await waitFor(() => expect(result.current.matches[0]?.fsPath).toBe("/remote/home/note.md"));
  expect(invokeRendererQuery).toHaveBeenCalledWith("workspace-directory-entries", {
    hostId: "remote",
    workspaceRoot: "~",
    directoriesOnly: true,
  });
  expect(readWorkspaceFileMetadata).toHaveBeenCalledWith({
    hostId: "remote",
    path: "/remote/home/note.md",
  });
});

test("changed roots clear stale lookup results and enforce containment before reading metadata", async () => {
  let resolveOld!: (value: WorkspaceFileMetadata) => void;
  vi.mocked(readWorkspaceFileMetadata).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { result, rerender } = renderHook(useCommandPaletteFileSearch, {
    initialProps: { ...initial, query: "/work/file.ts", restrictToRoots: true },
  });
  await waitFor(() => expect(readWorkspaceFileMetadata).toHaveBeenCalledTimes(1));
  rerender({
    ...initial,
    query: "/work/file.ts",
    scope: { hostId: "remote", roots: ["/work-other"] },
    restrictToRoots: true,
  });
  expect(result.current.matches).toEqual([]);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(readWorkspaceFileMetadata).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveOld(metadata());
  });
  expect(result.current.matches).toEqual([]);
  expect(result.current.error).toBeNull();
  rerender({ ...initial, query: "/work/../outside/file.ts", restrictToRoots: true });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(readWorkspaceFileMetadata).toHaveBeenCalledTimes(1);
  expect(result.current.matches).toEqual([]);
});

test("missing paths are empty results while real lookup failures can be retried", async () => {
  vi.mocked(readWorkspaceFileMetadata).mockRejectedValueOnce(
    Object.assign(new Error("Path missing"), { code: "not_found" }),
  );
  const { result, rerender } = renderHook(useCommandPaletteFileSearch, { initialProps: initial });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current).toEqual({ matches: [], loading: false, error: null, retry: null });
  vi.mocked(readWorkspaceFileMetadata).mockRejectedValueOnce(new Error("Host unavailable"));
  rerender({ ...initial, query: "/outside/other.ts" });
  await waitFor(() => expect(result.current.error).toBe("Host unavailable"));
  await act(async () => {
    result.current.retry?.();
  });
  await waitFor(() => expect(result.current.matches[0]?.fsPath).toBe("/outside/other.ts"));
  expect(result.current.error).toBeNull();
});

test.each([
  { root: "C:\\Repo", query: "c:\\repo\\Src\\File.ts", outside: "c:\\repository\\File.ts" },
  {
    root: "\\\\Server\\Share",
    query: "\\\\server\\share\\Src\\File.ts",
    outside: "\\\\server\\shared\\File.ts",
  },
])(
  "Windows folder restrictions compare case-insensitively but preserve the lookup target ($root)",
  async ({ root, query, outside }) => {
    const props = {
      ...initial,
      query,
      scope: { hostId: "local", roots: [root] },
      restrictToRoots: true,
    };
    const { result, rerender } = renderHook(useCommandPaletteFileSearch, { initialProps: props });
    await waitFor(() => expect(result.current.matches[0]?.fsPath).toBe(query));
    expect(readWorkspaceFileMetadata).toHaveBeenCalledWith({ hostId: "local", path: query });
    rerender({ ...props, query: outside });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.matches).toEqual([]);
    expect(readWorkspaceFileMetadata).toHaveBeenCalledTimes(1);
  },
);
