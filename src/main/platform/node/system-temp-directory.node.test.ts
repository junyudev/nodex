import { describe, expect, test } from "vite-plus/test";
import { isInsideSystemTempDirectory } from "./system-temp-directory";

describe("system temporary directory detection", () => {
  const macTemp = "/var/folders/aa/bb/T";
  const unixRealpaths: Record<string, string> = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
    "/stable/link": "/private/var/folders/aa/bb/T",
    "/scratch": "/volumes/cache",
  };
  const realpath = (absolutePath: string) => unixRealpaths[absolutePath] ?? null;

  test.each([
    [macTemp, true],
    ["/private/var/folders/aa/bb/T/worktrees", true],
    ["/var/folders/aa/bb/T/nested/../worktrees", true],
    ["/var/folders/aa/bb/T-backup/worktrees", false],
    ["/private/var/folders/aa/bb/C/worktrees", false],
    ["/private/tmp/worktrees", true],
    ["/tmp/worktrees", true],
    ["/tmp/../Users/person/worktrees", false],
    ["/stable/link/missing/worktrees", true],
  ])("classifies %s on macOS (temporary = %s)", (directory, expected) => {
    expect(
      isInsideSystemTempDirectory(directory, {
        tempDirectory: macTemp,
        platform: "darwin",
        realpath,
      }),
    ).toBe(expected);
  });

  test("recognizes the real location of a symlinked temporary directory", () => {
    expect(
      isInsideSystemTempDirectory("/volumes/cache/worktrees", {
        tempDirectory: "/scratch",
        platform: "linux",
        realpath,
      }),
    ).toBe(true);
  });

  test.each([
    ["c:/users/person/appdata/local/temp/worktrees", true],
    ["C:/Users/Person/AppData/Local/Temp-backup/worktrees", false],
    ["D:/Users/Person/AppData/Local/Temp/worktrees", false],
  ])("classifies %s on Windows (temporary = %s)", (directory, expected) => {
    expect(
      isInsideSystemTempDirectory(directory, {
        tempDirectory: "C:\\Users\\Person\\AppData\\Local\\Temp",
        platform: "win32",
        realpath: () => null,
      }),
    ).toBe(expected);
  });
});
