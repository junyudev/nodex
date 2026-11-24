import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { nativeBuildScratchDirectory } from "./native-build-scratch";

describe("native build scratch directory", () => {
  test("gives a checkout under a spaced path a directory that node-gyp can compile in", () => {
    const directory = nativeBuildScratchDirectory("/Users/dev/managed worktrees/abc/nodex");
    expect(directory).not.toMatch(/\s/u);
    expect(directory.startsWith(tmpdir())).toBe(true);
  });

  test("is stable for one checkout and distinct between checkouts", () => {
    const first = nativeBuildScratchDirectory("/work/one");
    expect(nativeBuildScratchDirectory("/work/one")).toBe(first);
    expect(nativeBuildScratchDirectory("/work/two")).not.toBe(first);
  });

  test("fails with the fix when the temporary directory itself has whitespace", () => {
    const parent = join(tmpdir(), "scratch parent");
    const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
    expect(() => nativeBuildScratchDirectory("/work/three", parent)).toThrow(
      `Set ${variable} to a path without spaces.`,
    );
  });
});
