import { expect, test } from "vite-plus/test";
import { areWorkspacePathsEquivalent, workspaceRootsForCwd } from "./codex-workspace-paths";

test.each([
  ["C:\\Repo\\Shared", "c:/repo/shared/", true],
  ["\\\\?\\C:\\Repo\\Shared", "/mnt/c/repo/shared", true],
  ["\\\\?\\UNC\\Server\\Share\\Folder", "//server/share/folder/", true],
  ["\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Repo", "C:/Repo", true],
  ["\\\\wsl$\\Ubuntu\\home\\User", "//wsl.localhost/ubuntu/home/User/", true],
  ["//wsl$/Ubuntu/home/User", "//wsl$/Debian/home/User", false],
  ["/mnt/c/Repo", "/mnt/c/repo", false],
  ["/home/User", "/home/user", false],
  ["/home/User", "//wsl$/Ubuntu/home/User", false],
  ["/one/../two", "/two", false],
] as const)("workspace path equivalence: %s and %s", (left, right, equivalent) => {
  expect(areWorkspacePathsEquivalent(left, right)).toBe(equivalent);
  expect(areWorkspacePathsEquivalent(right, left)).toBe(equivalent);
});

test.each([
  ["C:\\Repo", ["C:/Shared", "\\\\server\\share"]],
  ["//server/share", ["C:/Shared", "\\\\server\\share"]],
  ["/repo", ["/shared", "/mnt/c/Shared"]],
  ["relative", []],
  [null, []],
] as const)("runtime roots belong to the working directory path family: %s", (cwd, expected) => {
  expect(
    workspaceRootsForCwd(cwd, [
      "C:/Shared",
      "\\\\server\\share",
      "/shared",
      "/mnt/c/Shared",
      "relative",
      "~",
      "//incomplete",
    ]),
  ).toEqual(expected);
});
