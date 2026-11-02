import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  migrateLegacyCodexProjectlessWorkspace,
  repairCodexProjectlessWorkspace,
  resolveGeneratedProjectlessThreadPath,
} from "./codex-projectless-workspace-repair";

describe("Codex projectless workspace repair", () => {
  test("recognizes only exact generated thread layouts for both brands", () => {
    expect(
      resolveGeneratedProjectlessThreadPath(
        "/Users/test/Documents/Nodex/2026-07-18/example",
        "/Users/test",
      ),
    ).toMatchObject({
      brand: "Nodex",
      dateDirectoryName: "2026-07-18",
      threadDirectoryName: "example",
      workspaceRoot: "/Users/test/Documents/Nodex",
    });
    expect(
      resolveGeneratedProjectlessThreadPath(
        "C:\\Users\\test\\Documents\\Codex\\2026-07-18\\example",
        "C:\\Users\\test",
      ),
    ).toMatchObject({ brand: "Codex" });
    expect(
      resolveGeneratedProjectlessThreadPath("/Users/test/Documents/Nodex/example", "/Users/test"),
    ).toBe(null);
    expect(
      resolveGeneratedProjectlessThreadPath(
        "/Users/test/Documents/Nodex/2026-07-18/example/outputs",
        "/Users/test",
      ),
    ).toBe(null);
    expect(
      resolveGeneratedProjectlessThreadPath(
        "/Users/test/Documents/Nodex/2026-07-18/用户目录",
        "/Users/test",
      ),
    ).toBe(null);
  });

  test("migrates only the referenced legacy thread and preserves its contents", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-legacy-projectless-"));
    const legacyDateDirectory = path.join(homeDirectory, "Documents", "Codex", "2026-07-18");
    const sourceCwd = path.join(legacyDateDirectory, "example");
    const unrelatedCwd = path.join(legacyDateDirectory, "unrelated");
    const destinationCollision = path.join(
      homeDirectory,
      "Documents",
      "Nodex",
      "2026-07-18",
      "example",
    );
    try {
      await mkdir(path.join(sourceCwd, "outputs"), { recursive: true });
      await mkdir(unrelatedCwd, { recursive: true });
      await mkdir(destinationCollision, { recursive: true });
      await writeFile(path.join(sourceCwd, "outputs", "report.md"), "preserved");
      await writeFile(path.join(destinationCollision, "existing.md"), "untouched");

      const migrated = await migrateLegacyCodexProjectlessWorkspace({
        browserRoot: path.join(homeDirectory, "Documents", "Codex"),
        cwd: sourceCwd,
        homeDirectory,
        outputDirectory: path.join(sourceCwd, "outputs"),
      });

      expect(migrated).not.toBe(null);
      expect(migrated?.workspaceRoot).toBe(path.join(homeDirectory, "Documents", "Nodex"));
      expect(migrated?.cwd).toBe(
        path.join(homeDirectory, "Documents", "Nodex", "2026-07-18", "example-2"),
      );
      expect(await readFile(path.join(migrated?.cwd ?? "", "outputs", "report.md"), "utf8")).toBe(
        "preserved",
      );
      expect(await readFile(path.join(destinationCollision, "existing.md"), "utf8")).toBe(
        "untouched",
      );
      expect((await lstat(unrelatedCwd)).isDirectory()).toBe(true);
      expect(
        await migrateLegacyCodexProjectlessWorkspace({
          browserRoot: migrated?.workspaceRoot ?? null,
          cwd: migrated?.cwd ?? "",
          homeDirectory,
          outputDirectory: migrated?.outputDirectory ?? null,
        }),
      ).toBe(null);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("prefers a usable generated cwd and falls back to a saved browser root", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-repair-precedence-"));
    const current = path.join(homeDirectory, "Documents", "Nodex", "2026-07-18", "current");
    const newer = path.join(homeDirectory, "Documents", "Nodex", "2026-07-18", "newer");
    const browserRoot = path.join(homeDirectory, "saved-browser-root");
    try {
      await Promise.all([
        mkdir(path.join(current, "outputs"), { recursive: true }),
        mkdir(newer, { recursive: true }),
        mkdir(browserRoot, { recursive: true }),
      ]);

      await expect(
        repairCodexProjectlessWorkspace({
          browserRoot,
          cwd: current,
          homeDirectory,
          outputDirectory: null,
          prompt: "ignored",
          writableRoots: [newer],
        }),
      ).resolves.toStrictEqual({
        cwd: current,
        outputDirectory: path.join(current, "outputs"),
        workspaceRoot: path.join(homeDirectory, "Documents", "Nodex"),
      });
      await expect(
        repairCodexProjectlessWorkspace({
          browserRoot,
          cwd: null,
          homeDirectory,
          outputDirectory: null,
          prompt: "ignored",
          writableRoots: [path.join(homeDirectory, "not-generated")],
        }),
      ).resolves.toStrictEqual({
        cwd: browserRoot,
        outputDirectory: browserRoot,
        workspaceRoot: browserRoot,
      });
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("uses the latest generated writable root before browser root", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-repair-root-"));
    const older = path.join(homeDirectory, "Documents", "Nodex", "2026-07-17", "older");
    const latest = path.join(homeDirectory, "Documents", "Nodex", "2026-07-18", "latest");
    const browserRoot = path.join(homeDirectory, "browser");
    try {
      await Promise.all([
        mkdir(older, { recursive: true }),
        mkdir(latest, { recursive: true }),
        mkdir(browserRoot, { recursive: true }),
      ]);
      const repaired = await repairCodexProjectlessWorkspace({
        browserRoot,
        cwd: null,
        homeDirectory,
        outputDirectory: null,
        prompt: "ignored",
        writableRoots: [older, latest],
      });
      expect(repaired).toStrictEqual({
        cwd: latest,
        outputDirectory: latest,
        workspaceRoot: path.join(homeDirectory, "Documents", "Nodex"),
      });
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("allocates one unsplit workspace when no path can be recovered", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-repair-allocate-"));
    try {
      const repaired = await repairCodexProjectlessWorkspace({
        browserRoot: null,
        cwd: null,
        homeDirectory,
        outputDirectory: null,
        prompt: "Repair this missing workspace",
        writableRoots: [],
      });
      expect(repaired?.cwd).toBe(repaired?.outputDirectory);
      expect(path.relative(homeDirectory, repaired!.cwd).split(path.sep).join("/")).toMatch(
        /^Documents\/Nodex\/\d{4}-\d{2}-\d{2}\/repair-this-missing-workspace$/,
      );
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
