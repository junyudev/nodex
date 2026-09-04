import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface TestFile {
  readonly path: string;
  readonly tests: readonly { readonly name: string; readonly state: string }[];
}

/** Compare identities, not counts: moving a file between runtimes must not hide lost cases. */
export function compareTestManifests(before: readonly TestFile[], after: readonly TestFile[]) {
  const identities = (files: readonly TestFile[]) =>
    files.flatMap((file) => file.tests.map((test) => file.path + " :: " + test.name));
  const oldCases = identities(before);
  const newCases = identities(after);
  const oldSet = new Set(oldCases);
  const newSet = new Set(newCases);
  const seen = new Set<string>();
  const duplicateCasesAfter = newCases.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  return {
    before: {
      files: before.length,
      uniqueFiles: new Set(before.map((file) => file.path)).size,
      cases: oldCases.length,
      uniqueCases: oldSet.size,
    },
    after: {
      files: after.length,
      uniqueFiles: new Set(after.map((file) => file.path)).size,
      cases: newCases.length,
      uniqueCases: newSet.size,
    },
    removed: [...oldSet].filter((name) => !newSet.has(name)).sort(),
    added: [...newSet].filter((name) => !oldSet.has(name)).sort(),
    duplicateCasesAfter,
    failedAfter: after.flatMap((file) =>
      file.tests
        .filter((test) => test.state === "failed")
        .map((test) => file.path + " :: " + test.name),
    ),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
async function readObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!record(value)) throw new Error("Expected an evidence object: " + file);
  return value;
}
async function sampleFiles(directory: string): Promise<readonly TestFile[]> {
  const files: TestFile[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const report = await readObject(path.join(directory, entry));
    if (typeof report.suite !== "string" || !Array.isArray(report.files)) continue;
    for (const file of report.files) {
      if (
        !record(file) ||
        typeof file.path !== "string" ||
        !Array.isArray(file.tests) ||
        !file.tests.every(
          (test) => record(test) && typeof test.name === "string" && typeof test.state === "string",
        )
      ) {
        throw new Error("Invalid test manifest in " + entry);
      }
      files.push(file as unknown as TestFile);
    }
  }
  return files;
}

/** A comparison always exposes coverage drift and failed samples beside the timing ratio. */
export async function compareBenchmarks(
  beforeDirectory: string,
  afterDirectory: string,
): Promise<void> {
  const [before, after, beforeMetadata, afterMetadata] = await Promise.all([
    readObject(path.join(beforeDirectory, "summary.json")),
    readObject(path.join(afterDirectory, "summary.json")),
    readObject(path.join(beforeDirectory, "metadata.json")),
    readObject(path.join(afterDirectory, "metadata.json")),
  ]);
  if (
    !record(beforeMetadata.options) ||
    !record(afterMetadata.options) ||
    beforeMetadata.options.scenario !== afterMetadata.options.scenario
  ) {
    throw new Error("Compare the same benchmark scenario.");
  }
  const comparisons = [];
  const samples = Math.max(Number(before.samples), Number(after.samples));
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10)
    throw new Error("Invalid sample count.");
  for (let sample = 1; sample <= samples; sample += 1) {
    const [oldFiles, newFiles] = await Promise.all([
      sampleFiles(path.join(beforeDirectory, String(Math.min(sample, Number(before.samples))))),
      sampleFiles(path.join(afterDirectory, String(Math.min(sample, Number(after.samples))))),
    ]);
    comparisons.push(compareTestManifests(oldFiles, newFiles));
  }
  const sameRecordedToolVersions =
    JSON.stringify(beforeMetadata.versions) === JSON.stringify(afterMetadata.versions);
  const sameDependencyLock =
    typeof beforeMetadata.dependencyLockSha256 === "string" &&
    typeof afterMetadata.dependencyLockSha256 === "string"
      ? beforeMetadata.dependencyLockSha256 === afterMetadata.dependencyLockSha256
      : null;
  const comparison = {
    version: 2,
    beforeDirectory: path.resolve(beforeDirectory),
    afterDirectory: path.resolve(afterDirectory),
    before: { summary: before, metadata: beforeMetadata },
    after: { summary: after, metadata: afterMetadata },
    sameRecordedToolVersions,
    sameDependencyLock,
    observedReductionPercent:
      before.passed &&
      after.passed &&
      sameRecordedToolVersions &&
      sameDependencyLock !== false &&
      typeof before.medianMs === "number" &&
      typeof after.medianMs === "number"
        ? (1 - after.medianMs / before.medianMs) * 100
        : null,
    manifests: comparisons,
    interpretation:
      "Observed wall-clock difference, not a causal estimate. A null lock comparison means legacy evidence lacks its fingerprint; verify the source revisions' dependency policy separately. Review machine load, scope changes, failures, native preparation and per-suite records before accepting a speedup.",
  };
  const output = path.join(afterDirectory, "comparison.json");
  await writeFile(output, JSON.stringify(comparison, null, 2) + "\n");
  process.stdout.write("Benchmark comparison: " + output + "\n");
}
