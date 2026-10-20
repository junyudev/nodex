import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  createCacheReport,
  measureDirectory,
  parseCacheReportArguments,
  parseWorktreePaths,
} from "./cache-report";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-space-report-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("measures unique file metadata without following external links or entering Profiles", async () => {
  const root = await makeRoot();
  const directory = path.join(root, "generated");
  await fs.mkdir(path.join(directory, "runtime-profiles"), { recursive: true });
  await fs.writeFile(path.join(directory, "runtime-profiles", "private"), "excluded data");
  await fs.writeFile(path.join(directory, "binary"), "runtime");
  await fs.link(path.join(directory, "binary"), path.join(directory, "alias"));
  await fs.writeFile(path.join(root, "external"), "external data");
  await fs.symlink(path.join(root, "external"), path.join(directory, "link"));
  const before = await fs.stat(path.join(directory, "binary"));

  const usage = await measureDirectory(directory);

  expect(usage.logicalBytes).toBe(Buffer.byteLength("runtime"));
  expect(usage.files).toBe(1);
  expect(usage.links).toBe(1);
  expect(usage.excludedDirectories).toBe(1);
  expect(usage.errors).toEqual([]);
  expect((await fs.stat(path.join(directory, "binary"))).mtimeMs).toBe(before.mtimeMs);
  expect(await fs.readFile(path.join(directory, "runtime-profiles", "private"), "utf8")).toBe(
    "excluded data",
  );
  expect((await measureDirectory(path.join(root, "missing"))).exists).toBe(false);
});

test("reports isolated checkout paths and the shared primary cache without visiting unrelated homes", async () => {
  const root = await makeRoot();
  const primary = path.join(root, "primary");
  const consumer = path.join(root, "consumer");
  await fs.mkdir(primary);
  execFileSync("git", ["init", "--quiet", primary]);
  execFileSync(
    "git",
    [
      "-C",
      primary,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "Initial",
    ],
    { stdio: "pipe" },
  );
  execFileSync("git", ["-C", primary, "worktree", "add", "--quiet", "--detach", consumer]);
  await fs.mkdir(path.join(primary, "cache.local"));
  await fs.writeFile(path.join(primary, "cache.local", "archive"), "shared");
  const report = await createCacheReport({
    repositoryRoot: consumer,
    globalDirectories: [],
    environment: {},
  });
  expect(report.worktrees.map((worktree) => worktree.path)).toEqual([consumer]);
  expect(report.shared[0].logicalBytes).toBe(6);
  expect(report.shared[0].path).toBe(path.join(await fs.realpath(primary), "cache.local"));
  const all = await createCacheReport({
    repositoryRoot: consumer,
    allWorktrees: true,
    globalDirectories: [],
    environment: { NODEX_BUILD_CACHE_DIR: path.join(root, "test-cache") },
  });
  expect(all.worktrees.map((worktree) => worktree.path)).toEqual([
    await fs.realpath(primary),
    await fs.realpath(consumer),
  ]);
  expect(all.shared[0].path).toBe(path.join(root, "test-cache"));
});

test("preserves whitespace in Git paths and accepts only read-only report options", () => {
  expect(
    parseWorktreePaths(
      "worktree /repo/with spaces\0HEAD abc\0\0worktree /repo/line\nbreak\0HEAD def\0",
    ),
  ).toEqual(["/repo/with spaces", "/repo/line\nbreak"]);
  expect(parseCacheReportArguments(["--all-worktrees", "--json"])).toEqual({
    allWorktrees: true,
    json: true,
  });
  expect(() => parseCacheReportArguments(["--delete"])).toThrow("Usage");
});
