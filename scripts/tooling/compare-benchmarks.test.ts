import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareBenchmarks, compareTestManifests } from "./compare-benchmarks";

test("exposes removed and failed cases even when total counts stay equal", () => {
  const comparison = compareTestManifests(
    [
      {
        path: "a.test.ts",
        tests: [
          { name: "retained", state: "passed" },
          { name: "lost", state: "passed" },
        ],
      },
    ],
    [
      {
        path: "a.test.ts",
        tests: [
          { name: "retained", state: "failed" },
          { name: "new", state: "passed" },
        ],
      },
    ],
  );
  expect(comparison.removed).toEqual(["a.test.ts :: lost"]);
  expect(comparison.added).toEqual(["a.test.ts :: new"]);
  expect(comparison.failedAfter).toEqual(["a.test.ts :: retained"]);
});

test("does not report a speedup across different dependency locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex-benchmark-comparison-"));
  const before = path.join(root, "before");
  const after = path.join(root, "after");
  try {
    for (const directory of [before, after]) {
      await mkdir(path.join(directory, "1"), { recursive: true });
      await writeFile(
        path.join(directory, "summary.json"),
        JSON.stringify({ samples: 1, passed: true, medianMs: directory === before ? 100 : 50 }),
      );
      await writeFile(
        path.join(directory, "metadata.json"),
        JSON.stringify({
          options: { scenario: "semantic-execute" },
          versions: { node: "24", vitePlus: "0.2.9" },
          dependencyLockSha256: directory === before ? "old-lock" : "new-lock",
        }),
      );
    }
    await compareBenchmarks(before, after);
    expect(JSON.parse(await readFile(path.join(after, "comparison.json"), "utf8"))).toMatchObject({
      sameRecordedToolVersions: true,
      sameDependencyLock: false,
      observedReductionPercent: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinguishes removed duplicate executions from lost unique coverage", () => {
  const file = { path: "a.test.ts", tests: [{ name: "retained", state: "passed" }] };
  const comparison = compareTestManifests([file, file], [file]);
  expect(comparison.before.files).toBe(2);
  expect(comparison.before.uniqueFiles).toBe(1);
  expect(comparison.removed).toEqual([]);
  expect(comparison.duplicateCasesAfter).toEqual([]);
  expect(compareTestManifests([file], [file, file]).duplicateCasesAfter).toEqual([
    "a.test.ts :: retained",
  ]);
});
