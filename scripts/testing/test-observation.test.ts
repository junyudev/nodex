import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { localInputReader } from "./test-cache-inputs.ts";

const fixtures = "scripts/fixtures/test-observation";
const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

interface RecordForFile {
  file: string;
  pool: string;
  worker: { pid: number; threadId: number };
  reads: string[];
  probes: Record<string, string>;
  listings: { path: string; evidence: { digest?: string } }[];
  unobservable: Record<string, string[]>;
}

test.each(["forks", "vmForks", "threads"])(
  "attributes runtime calls to one test file in %s",
  async (pool) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-test-observation-"));
    try {
      await promisify(execFile)(
        process.execPath,
        [
          vitest,
          "run",
          "--config",
          fixtures + "/vitest.config.ts",
          "--pool",
          pool,
          ...(pool === "vmForks" ? ["--environment", "jsdom"] : []),
        ],
        { env: { ...process.env, NODEX_TEST_OBSERVATIONS: directory } },
      );
      const records = await Promise.all(
        (await readdir(directory)).map(
          async (name) =>
            JSON.parse(await readFile(path.join(directory, name), "utf8")) as RecordForFile,
        ),
      );
      const filesystem = records.find((record) => record.file === fixtures + "/filesystem.test.ts");
      const importOnly = records.find(
        (record) => record.file === fixtures + "/import-only.test.ts",
      );
      if (!filesystem || !importOnly)
        throw new Error("Expected one record for each fixture test file");
      expect(records).toHaveLength(2);
      expect(filesystem.pool).toBe(pool);
      expect(importOnly.pool).toBe(pool);
      expect(filesystem.reads).toContain(fixtures + "/vitest.config.ts");
      expect(filesystem.probes[fixtures + "/absent.fixture"]).toBe("absent");
      expect(filesystem.probes[fixtures + "/also-absent.fixture"]).toBe("absent");
      expect(filesystem.listings).toContainEqual({
        path: fixtures,
        kind: "readdir",
        evidence: { state: "directory", digest: expect.any(String) },
      });
      expect(
        [...filesystem.reads, ...Object.keys(filesystem.probes)].some(
          (file) => file.endsWith(".fixture") && file.includes("/created-"),
        ),
      ).toBe(false);
      expect(filesystem.unobservable).toEqual({
        subprocess: [process.platform === "win32" ? "cmd.exe" : "/bin/sh"],
      });
      expect(filesystem.reads).not.toContain(fixtures + "/import-only.test.ts");
      expect(importOnly.reads).not.toContain(fixtures + "/vitest.config.ts");
      expect(importOnly.probes[fixtures + "/absent.fixture"]).toBeUndefined();
      expect(importOnly.unobservable).toEqual({});
      // This assertion witnesses worker reuse, where file boundaries matter most.
      if (pool === "vmForks") expect(filesystem.worker).toEqual(importOnly.worker);
      else expect(filesystem.worker).not.toEqual(importOnly.worker);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("closes native lookup and child-process evidence only when every input is accounted for", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-test-observation-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fixtures + "/native-boundaries.mjs", directory],
      {
        env: {
          ...process.env,
          NODEX_TEST_OBSERVATIONS: directory,
          NODEX_TEST_OBSERVATION_RUNTIME: process.execPath,
        },
      },
    );
    const records = new Map(
      (
        JSON.parse(stdout) as (RecordForFile & {
          missingModuleCandidates: string[];
        })[]
      ).map((record) => [path.basename(record.file), record]),
    );
    const lookup = records.get("missing-module");
    if (!lookup) throw new Error("Missing native lookup observation");
    expect(lookup.unobservable).toEqual({});
    expect(lookup.probes[fixtures + "/missing-entry.mjs"]).toBe("absent");
    const candidate = path.join(
      await realpath(directory),
      "node_modules/nodex-recorder-optional.js",
    );
    expect(lookup.missingModuleCandidates).toContain(candidate);
    expect(lookup.missingModuleCandidates).toContain(
      path.join(process.cwd(), "node_modules/nodex-recorder-esm-optional"),
    );
    const misses = { root: process.cwd(), candidates: lookup.missingModuleCandidates };
    expect(await localInputReader(process.cwd()).matchesMissingModules(misses)).toBe(true);
    expect(await localInputReader(directory).matchesMissingModules(misses)).toBe(false);
    await writeFile(candidate, "module.exports = true");
    expect(await localInputReader(process.cwd()).matchesMissingModules(misses)).toBe(false);
    expect(records.get("external-module")?.unobservable).toMatchObject({
      "module resolution": ["ERR_MODULE_NOT_FOUND"],
    });
    expect(records.get("directory-module")?.unobservable).toMatchObject({
      "module resolution": ["MODULE_NOT_FOUND"],
    });

    const child = records.get("node-child");
    expect(child?.unobservable).toEqual({});
    expect(child?.reads).toEqual(
      expect.arrayContaining([fixtures + "/import-only.test.ts", fixtures + "/vitest.config.ts"]),
    );
    expect(child?.probes[fixtures + "/missing-child-input"]).toBe("absent");
    expect(records.get("grandchild")?.unobservable).toEqual({ subprocess: [process.execPath] });
    expect(records.get("abrupt-child")?.unobservable).toEqual({
      subprocess: ["missing or unreadable Node child observation"],
    });
    expect(records.get("custom-preload")?.unobservable).toEqual({ subprocess: [process.execPath] });
    for (const name of ["commonjs-child-network", "esm-child-network"]) {
      expect(records.get(name)?.unobservable).toEqual({ network: ["127.0.0.1"] });
    }
    expect(records.get("runtime-executable")?.unobservable).toEqual({});
    expect(records.get("ambient-runtime-neighbor")?.unobservable).toEqual({
      "external filesystem": [process.execPath + ".nodex-recorder-missing"],
    });
    expect(records.get("external-input")?.unobservable).toMatchObject({
      "external filesystem": [expect.stringContaining("ambient-config")],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
