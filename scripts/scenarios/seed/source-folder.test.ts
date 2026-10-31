import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { assertSeededSourceFolder, materializeSeededSourceFolder } from "./source-folder";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const createHome = async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "ndx-seed-source-")));
  roots.push(home);
  return home;
};
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("a seed nested beneath a checkout owns its Git history and cannot commit into the parent", async () => {
  const checkout = await createHome();
  await git(checkout, "init", "--initial-branch=developer-branch", "--template=");
  const home = path.join(checkout, "runs.local", "take");
  await mkdir(path.join(home, "workspace"), { recursive: true });
  expect(
    path.resolve(await git(path.join(home, "workspace"), "rev-parse", "--show-toplevel")),
  ).toBe(checkout);

  const source = await materializeSeededSourceFolder(home, "landing/shared-pages");
  expect(source).toBe(path.join(home, "workspace", "tinyboard"));
  expect(path.resolve(await git(source, "rev-parse", "--show-toplevel"))).toBe(source);
  expect(
    path.resolve(await git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")),
  ).toBe(path.join(source, ".git"));
  expect(await git(source, "branch", "--show-current")).toBe("main");
  expect(await git(source, "remote")).toBe("");
  expect(await git(source, "status", "--porcelain")).toBe("");
  expect(await git(source, "ls-tree", "-r", "--name-only", "HEAD")).toContain("src/tasks.js");
  const parentBefore = await git(checkout, "status", "--porcelain");
  await writeFile(path.join(source, "implementation.md"), "Task implementation\n");
  await git(source, "add", "implementation.md");
  await git(source, "-c", "core.hooksPath=", "commit", "-m", "Implement the brief");
  expect(await git(source, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await git(checkout, "status", "--porcelain")).toBe(parentBefore);
  expect(await git(checkout, "branch", "--show-current")).toBe("developer-branch");
  expect(await assertSeededSourceFolder(home, "landing/shared-pages")).toBe(source);
});

test("fresh takes copy committed fixtures independently and refuse to overwrite manual work", async () => {
  const firstHome = await createHome();
  const first = await materializeSeededSourceFolder(firstHome, "landing/showcase");
  const original = await readFile(path.join(first, "src/tasks.js"), "utf8");
  await writeFile(path.join(first, "src/tasks.js"), "Edited by an Agent\n");
  const second = await materializeSeededSourceFolder(await createHome(), "landing/shared-pages");
  expect(await readFile(path.join(second, "src/tasks.js"), "utf8")).toBe(original);
  await expect(materializeSeededSourceFolder(firstHome, "landing/showcase")).rejects.toThrow();
  expect(await readFile(path.join(first, "src/tasks.js"), "utf8")).toBe("Edited by an Agent\n");
});

test("inherited Git paths cannot redirect initialization or fixture commits", async () => {
  const live = await materializeSeededSourceFolder(await createHome(), "board/dense");
  const before = await git(live, "rev-parse", "HEAD");
  vi.stubEnv("GIT_DIR", path.join(live, ".git"));
  vi.stubEnv("GIT_WORK_TREE", live);
  vi.stubEnv("GIT_INDEX_FILE", path.join(live, ".git", "index"));
  const source = await materializeSeededSourceFolder(await createHome(), "agent/cli-workflow");
  vi.unstubAllEnvs();
  expect(path.resolve(await git(source, "rev-parse", "--show-toplevel"))).toBe(source);
  expect(await git(live, "rev-parse", "HEAD")).toBe(before);
  expect(await git(live, "status", "--porcelain")).toBe("");
});

test("rejects source paths that escape through a workspace or source symlink", async () => {
  const outside = await createHome();
  const home = await createHome();
  await symlink(outside, path.join(home, "workspace"));
  await expect(materializeSeededSourceFolder(home, "board/dense")).rejects.toThrow(/symlink/u);
  await rm(path.join(home, "workspace"));
  await mkdir(path.join(home, "workspace"));
  await symlink(outside, path.join(home, "workspace", "board-dense"));
  await expect(materializeSeededSourceFolder(home, "board/dense")).rejects.toThrow();
  await expect(assertSeededSourceFolder(home, "board/dense")).rejects.toThrow(/fresh/u);
});

test("rejects old empty workspaces, shared Git metadata, and invalid source identities", async () => {
  const home = await createHome();
  await mkdir(path.join(home, "workspace"));
  await expect(assertSeededSourceFolder(home, "board/dense")).rejects.toThrow(/fresh/u);
  await expect(materializeSeededSourceFolder(home, "../live")).rejects.toThrow(/identity/u);
  const source = await materializeSeededSourceFolder(home, "board/dense");
  const external = await materializeSeededSourceFolder(await createHome(), "board/dense");
  await writeFile(path.join(source, ".git", "commondir"), path.join(external, ".git"));
  await expect(assertSeededSourceFolder(home, "board/dense")).rejects.toThrow(/fresh/u);
});
