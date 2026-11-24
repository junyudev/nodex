import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

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
      expect(filesystem.unobservable).toEqual({ subprocess: [process.execPath] });
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
