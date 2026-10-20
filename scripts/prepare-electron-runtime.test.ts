import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  prepareElectronRuntime,
  type PrepareElectronRuntimeOptions,
} from "./prepare-electron-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-electron-prepare-"));
  roots.push(root);
  const archivePath = path.join(root, "electron.zip");
  writeFileSync(archivePath, "verified electron archive");
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const cachePath = path.join(root, "cache");
  let downloads = 0;
  let extractions = 0;
  let failExtraction = false;
  const installer: NonNullable<PrepareElectronRuntimeOptions["installer"]> = {
    downloadArtifact: async (input) => {
      expect(input).toMatchObject({ version: "44.4.4", platform: "darwin", arch: "arm64" });
      downloads++;
      return archivePath;
    },
    extract: async (_archive, { dir }) => {
      extractions++;
      if (failExtraction) throw new Error("extract failed");
      const executable = path.join(dir, "Electron.app/Contents/MacOS/Electron");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, "electron executable");
      chmodSync(executable, 0o755);
      writeFileSync(path.join(dir, "version"), "44.4.4");
      writeFileSync(path.join(dir, "electron.d.ts"), "upstream types");
    },
  };
  const project = (name: string): PrepareElectronRuntimeOptions => {
    const projectRoot = path.join(root, name);
    const packageRoot = path.join(projectRoot, "node_modules/electron");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { electron: "44.4.4" } }),
    );
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "electron", version: "44.4.4" }),
    );
    writeFileSync(
      path.join(packageRoot, "checksums.json"),
      JSON.stringify({ "electron-v44.4.4-darwin-arm64.zip": sha256 }),
    );
    return { projectRoot, arch: "arm64", platform: "darwin", cachePath, installer };
  };
  return {
    project,
    archivePath,
    cachedExecutable: path.join(
      cachePath,
      sha256,
      "dist-v1/content/Electron.app/Contents/MacOS/Electron",
    ),
    counters: () => ({ downloads, extractions }),
    failExtraction: () => {
      failExtraction = true;
    },
  };
}

test("concurrent worktrees extract once and own independent verified distributions", async () => {
  const setup = fixture();
  const first = setup.project("first");
  const second = setup.project("second");
  const [firstExecutable, secondExecutable] = await Promise.all([
    prepareElectronRuntime(first),
    prepareElectronRuntime(second),
  ]);
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 1 });
  expect(statSync(firstExecutable).ino).not.toBe(statSync(secondExecutable).ino);
  const before = statSync(firstExecutable).mtimeMs;
  await prepareElectronRuntime(first);
  expect(statSync(firstExecutable).mtimeMs).toBe(before);
  writeFileSync(firstExecutable, "changed by first worktree");
  expect(readFileSync(secondExecutable, "utf8")).toBe("electron executable");
  expect(readFileSync(setup.cachedExecutable, "utf8")).toBe("electron executable");
  await prepareElectronRuntime(first);
  expect(readFileSync(firstExecutable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 1 });
  const packageRoot = path.join(first.projectRoot!, "node_modules/electron");
  expect(readFileSync(path.join(packageRoot, "path.txt"), "utf8")).toBe(
    "Electron.app/Contents/MacOS/Electron",
  );
  expect(existsSync(path.join(packageRoot, "dist/electron.d.ts"))).toBe(false);
});

test("repairs damaged extraction caches before cloning to another worktree", async () => {
  const setup = fixture();
  await prepareElectronRuntime(setup.project("first"));
  writeFileSync(setup.cachedExecutable, "damaged cache");
  const executable = await prepareElectronRuntime(setup.project("second"));
  expect(readFileSync(executable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 2, extractions: 2 });
});

test("rejects an archive for another identity before extraction", async () => {
  const setup = fixture();
  const project = setup.project("first");
  writeFileSync(setup.archivePath, "unexpected archive");
  await expect(prepareElectronRuntime(project)).rejects.toThrow("checksum mismatch");
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 0 });
  await expect(prepareElectronRuntime({ ...project, arch: "x64" })).rejects.toThrow(
    "no pinned SHA-256",
  );
});

test("retains the previous complete distribution when replacement generation fails", async () => {
  const setup = fixture();
  const project = setup.project("first");
  const executable = await prepareElectronRuntime(project);
  const receipt = path.join(project.projectRoot!, "node_modules/electron/.nodex-electron.json");
  rmSync(receipt);
  writeFileSync(setup.cachedExecutable, "damaged cache");
  setup.failExtraction();
  await expect(prepareElectronRuntime(project)).rejects.toThrow("extract failed");
  expect(readFileSync(executable, "utf8")).toBe("electron executable");
});

test("requires the installed package to match the exact repository version", async () => {
  const setup = fixture();
  const project = setup.project("first");
  writeFileSync(
    path.join(project.projectRoot!, "package.json"),
    JSON.stringify({ devDependencies: { electron: "^44.4.4" } }),
  );
  await expect(prepareElectronRuntime(project)).rejects.toThrow("exact version");
  expect(setup.counters()).toEqual({ downloads: 0, extractions: 0 });
});
