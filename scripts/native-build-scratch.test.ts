import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { nativeBuildScratchDirectory } from "./native-build-scratch";

const originalTmpdir = process.env.TMPDIR;
afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
});

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
    const parent = mkdtempSync(join(tmpdir(), "scratch parent "));
    try {
      process.env.TMPDIR = parent;
      expect(() => nativeBuildScratchDirectory("/work/three")).toThrow(/Set TMPDIR/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
