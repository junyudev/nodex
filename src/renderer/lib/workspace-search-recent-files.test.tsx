import { afterEach, expect, test } from "vite-plus/test";
import {
  getRecentWorkspaceSearchFiles,
  getWorkspaceSearchPriorityFolders,
  recordWorkspaceSearchFile,
} from "./workspace-search-recent-files";

afterEach(() => localStorage.clear());

test("recent files retain newest canonical identity within their host and exact root boundary", () => {
  recordWorkspaceSearchFile("local", "/work/src/a.ts");
  recordWorkspaceSearchFile("remote", "/work/src/a.ts");
  recordWorkspaceSearchFile("local", "/work-other/outside.ts");
  recordWorkspaceSearchFile("local", "/work/src/b.ts");
  recordWorkspaceSearchFile("local", "/work/src/old/../a.ts");
  const files = getRecentWorkspaceSearchFiles({ hostId: "local", roots: ["/work/"] });
  expect(files.map((file) => [file.relativePath, file.label])).toEqual([
    ["src/a.ts", "a.ts"],
    ["src/b.ts", "b.ts"],
  ]);
  expect(files.map((file) => file.fsPath)).toEqual(["/work/src/a.ts", "/work/src/b.ts"]);
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "remote", roots: ["/work"] }).map(
      (file) => file.fsPath,
    ),
  ).toEqual(["/work/src/a.ts"]);
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "local", roots: [] }).map((file) => file.label),
  ).toEqual(["a.ts", "b.ts", "outside.ts"]);
});

test("priority folders follow recent host-local navigation and collapse duplicate parents", () => {
  recordWorkspaceSearchFile("remote", "/unrelated/file");
  recordWorkspaceSearchFile("local", "/first/a.ts");
  recordWorkspaceSearchFile("local", "/second/a.ts");
  recordWorkspaceSearchFile("local", "/first/b.ts");
  expect(getWorkspaceSearchPriorityFolders("local")).toEqual(["/first", "/second"]);
  expect(getWorkspaceSearchPriorityFolders("remote")).toEqual(["/unrelated"]);
  for (let index = 0; index < 25; index += 1)
    recordWorkspaceSearchFile("local", `/folder-${index}/file`);
  expect(getWorkspaceSearchPriorityFolders("local")).toHaveLength(20);
  expect(getRecentWorkspaceSearchFiles({ hostId: "local", roots: [] })).toHaveLength(10);
});

test("Windows roots use host separators without treating a prefix sibling as contained", () => {
  recordWorkspaceSearchFile("windows", "C:\\work-other\\outside.ts");
  recordWorkspaceSearchFile("windows", "C:\\work\\src\\inside.ts");
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "windows", roots: ["C:\\work"] }).map(
      (file) => file.relativePath,
    ),
  ).toEqual(["src/inside.ts"]);
});

test("Windows recent paths compare case-insensitively while retaining the newest spelling and Host", () => {
  recordWorkspaceSearchFile("local", "C:\\Repo\\src\\FILE.ts");
  recordWorkspaceSearchFile("local", "c:\\repo\\src\\Other.ts");
  recordWorkspaceSearchFile("remote", "C:\\Repo\\src\\FILE.ts");
  recordWorkspaceSearchFile("local", "C:\\REPO\\src\\file.ts");
  recordWorkspaceSearchFile("local", "C:\\repository\\outside.ts");
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "local", roots: ["c:/Repo"] }).map((file) => [
      file.relativePath,
      file.fsPath,
    ]),
  ).toEqual([
    ["src/file.ts", "C:\\REPO\\src\\file.ts"],
    ["src/Other.ts", "c:\\repo\\src\\Other.ts"],
  ]);
  expect(getWorkspaceSearchPriorityFolders("local")).toEqual(["C:\\repository", "C:\\REPO\\src"]);
  expect(getRecentWorkspaceSearchFiles({ hostId: "remote", roots: ["c:/repo"] })[0]?.fsPath).toBe(
    "C:\\Repo\\src\\FILE.ts",
  );
});

test("recent UNC shares follow Windows comparison rules while POSIX file case remains distinct", () => {
  recordWorkspaceSearchFile("local", "\\\\Server\\Share\\File.ts");
  recordWorkspaceSearchFile("local", "\\\\server\\share\\file.ts");
  recordWorkspaceSearchFile("local", "/repo/File.ts");
  recordWorkspaceSearchFile("local", "/repo/file.ts");
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "local", roots: ["//SERVER/SHARE"] }).map(
      (file) => file.fsPath,
    ),
  ).toEqual(["\\\\server\\share\\file.ts"]);
  expect(
    getRecentWorkspaceSearchFiles({ hostId: "local", roots: ["/repo"] }).map((file) => file.fsPath),
  ).toEqual(["/repo/file.ts", "/repo/File.ts"]);
});
