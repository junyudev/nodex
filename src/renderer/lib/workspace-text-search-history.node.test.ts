import { expect, test, vi } from "vite-plus/test";
vi.mock("./maitai", () => ({
  persistedAtom: () => ({}),
  usePersistedAtomValue: vi.fn(),
  useSetPersistedAtom: vi.fn(),
}));
import {
  decodeWorkspaceTextSearchHistory,
  updateWorkspaceTextSearchHistory,
  workspaceTextSearchHistoryKey,
  workspaceTextSearchHistoryScope,
  type WorkspaceTextSearchHistory,
} from "./workspace-text-search-history";
import {
  commandPaletteDirectoryCoordinates,
  commandPaletteParentDirectory,
} from "./command-palette-workspace-paths";

test("keeps Project history while changing folders and isolates other hosts", () => {
  const context = { hostId: "local", roots: ["/repo", "/other"] };
  const selected = { hostId: "local", roots: ["/repo/src"] };
  const remote = { hostId: "remote", roots: ["/repo/src"] };
  expect(workspaceTextSearchHistoryScope(context, selected)).toEqual(context);
  expect(workspaceTextSearchHistoryScope(context, remote)).toEqual(remote);
  expect(workspaceTextSearchHistoryScope(null, selected)).toEqual(selected);
  expect(workspaceTextSearchHistoryScope({ hostId: "local", roots: [] }, selected)).toEqual(
    selected,
  );
  expect(workspaceTextSearchHistoryScope(null, null)).toBeNull();
});

test("stores raw query text, commits trimmed masks, and bounds recency independently by host/project", () => {
  let history: WorkspaceTextSearchHistory = [];
  const key = workspaceTextSearchHistoryKey("local", ["/repo"]);
  for (let index = 0; index < 35; index += 1)
    history = updateWorkspaceTextSearchHistory(history, {
      key,
      query: `q${index}`,
      fileMask: `  *.${index} `,
      commit: true,
    });
  expect(history[0]?.queries).toHaveLength(30);
  expect(history[0]?.masks).toHaveLength(20);
  history = updateWorkspaceTextSearchHistory(history, {
    key,
    query: " q34 ",
    fileMask: "*.draft",
    commit: false,
  });
  expect(history[0]).toMatchObject({
    fileMask: "*.draft",
    queries: [" q34 ", ...Array.from({ length: 29 }, (_, index) => `q${34 - index}`)],
  });
  expect(history[0]?.masks[0]).toBe("*.34");
  const remoteKey = workspaceTextSearchHistoryKey("remote", ["/repo"]);
  history = updateWorkspaceTextSearchHistory(history, {
    key: remoteKey,
    query: "bad\nquery",
    fileMask: "",
    commit: true,
  });
  expect(history[0]?.queries).toEqual([]);
  expect(history[1]?.key).toBe(key);
});

test("decodes untrusted history with deduplication, validation and bounded scopes", () => {
  const history = decodeWorkspaceTextSearchHistory([
    { key: "one", queries: ["a", "a", "bad\nquery", 3], masks: ["*.ts"] },
    { key: "one", queries: ["discard"] },
    ...Array.from({ length: 30 }, (_, index) => ({ key: String(index) })),
  ]);
  expect(history).toHaveLength(20);
  expect(history[0]).toEqual({ key: "one", fileMask: "", queries: ["a"], masks: ["*.ts"] });
});

test("splits POSIX, Windows, UNC and host-home paths without treating relative paths as local", () => {
  expect(commandPaletteDirectoryCoordinates("/repo/a")).toEqual({
    workspaceRoot: "/",
    directoryPath: "repo/a",
  });
  expect(commandPaletteDirectoryCoordinates("C:\\repo\\a")).toEqual({
    workspaceRoot: "C:/",
    directoryPath: "repo/a",
  });
  expect(commandPaletteDirectoryCoordinates("\\\\server\\share\\repo")).toEqual({
    workspaceRoot: "//server/share",
    directoryPath: "repo",
  });
  expect(commandPaletteDirectoryCoordinates("~/repo")).toEqual({
    workspaceRoot: "~",
    directoryPath: "repo",
  });
  expect(commandPaletteDirectoryCoordinates("repo")).toBeNull();
});

test("parent navigation leaves a resolved home but stops at POSIX, drive and UNC roots", () => {
  expect(commandPaletteParentDirectory("/Users/example")).toBe("/Users");
  expect(commandPaletteParentDirectory("/Users")).toBe("/");
  expect(commandPaletteParentDirectory("/")).toBeNull();
  expect(commandPaletteParentDirectory("C:\\Users\\example")).toBe("C:\\Users");
  expect(commandPaletteParentDirectory("C:\\Users")).toBe("C:\\");
  expect(commandPaletteParentDirectory("C:\\")).toBeNull();
  expect(commandPaletteParentDirectory("\\\\host\\share\\folder")).toBe("\\\\host\\share");
  expect(commandPaletteParentDirectory("\\\\host\\share")).toBeNull();
  expect(commandPaletteParentDirectory("~")).toBeNull();
});
