import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { createUuidV7 } from "../../shared/uuid-v7";
import { connectOrStartCore, type CoreLaunchResult } from "./core-launcher";

const enabled = process.env.NODEX_MEASURE_RUST_CORE_RUNTIME === "1";
const coreExecutable = path.resolve("target/release/nodex-core");
const temporaryDirectories: string[] = [];
const runningCores: Array<{
  readonly nodexHome: string;
  readonly runtime: CoreLaunchResult;
}> = [];

const temporaryProfile = (label: string): string => {
  const directory = mkdtempSync(path.join(os.tmpdir(), `nodex-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const elapsedMilliseconds = async <Value>(
  operation: () => Promise<Value>,
): Promise<{ readonly elapsedMs: number; readonly value: Value }> => {
  const startedAt = process.hrtime.bigint();
  const value = await operation();
  return {
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    value,
  };
};

const percentile = (samples: readonly number[], ratio: number): number => {
  if (samples.length === 0) throw new Error("Cannot summarize an empty sample set");
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
  const value = ordered[index];
  if (value === undefined) throw new Error("Percentile index is out of bounds");
  return Number(value.toFixed(3));
};

const summary = (samples: readonly number[]) => ({
  count: samples.length,
  minMs: percentile(samples, 0),
  p50Ms: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  maxMs: percentile(samples, 1),
});

const benchmarkStage = async <Value>(label: string, operation: Promise<Value>): Promise<Value> => {
  try {
    return await operation;
  } catch (error) {
    throw new Error(`Gate E failed during ${label}`, { cause: error });
  }
};

const startCore = async (nodexHome: string): Promise<CoreLaunchResult> => {
  const runtime = await connectOrStartCore({
    buildId: "rust-core-gate-e-benchmark",
    environment: {
      NODEX_CORE_EXECUTABLE: coreExecutable,
      NODEX_LOG_FILE: "true",
    },
    isPackaged: false,
    nodexHome,
    requestTimeoutMs: 60_000,
  });
  runningCores.push({ nodexHome, runtime });
  return runtime;
};

const stopCore = async (runtime: CoreLaunchResult, nodexHome: string): Promise<void> => {
  const index = runningCores.findIndex((entry) => entry.runtime === runtime);
  if (index >= 0) runningCores.splice(index, 1);
  const pid = runtime.client.handshake.generation.pid;
  const socketPath = path.join(nodexHome, "run/core/core.sock");
  await runtime.client.shutdown().catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (existsSync(socketPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(socketPath)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const forcedDeadline = Date.now() + 5_000;
  while (existsSync(socketPath) && Date.now() < forcedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const removeTemporaryDirectory = async (directory: string): Promise<void> => {
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith("nodex-ndx-ge-")) {
    throw new Error("Gate E cleanup accepts only its disposable Profile roots");
  }
  const pending = [resolved];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Gate E cleanup refuses symlinked Profile entries");
    }
    if (!metadata.isDirectory()) continue;
    chmodSync(current, 0o700);
    for (const name of readdirSync(current)) pending.push(path.join(current, name));
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  rmSync(directory, { recursive: true, force: true });
};

const readCoreLogs = (nodexHome: string): string => {
  const directory = path.join(nodexHome, "logs");
  if (!existsSync(directory)) return "no Core log directory";
  return readdirSync(directory)
    .sort()
    .map((name) => readFileSync(path.join(directory, name), "utf8"))
    .join("\n")
    .slice(-8_192);
};

const residentSetBytes = (pid: number): number => {
  const kibibytes = Number.parseInt(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(),
    10,
  );
  if (!Number.isSafeInteger(kibibytes) || kibibytes <= 0) {
    throw new Error("Core RSS measurement is invalid");
  }
  return kibibytes * 1_024;
};

afterEach(async () => {
  for (const { nodexHome, runtime } of [...runningCores]) {
    await stopCore(runtime, nodexHome);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await removeTemporaryDirectory(directory);
  }
}, 30_000);

describe.runIf(enabled)("Rust Core Gate E runtime", () => {
  test("stays within the accepted end-to-end latency budgets", { timeout: 240_000 }, async () => {
    expect(existsSync(coreExecutable), "build nodex-core before measuring Gate E").toBe(true);

    const coldReadinessMs: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      const home = temporaryProfile(`ndx-ge-c${index}`);
      const measurement = await elapsedMilliseconds(() => startCore(home)).catch((error) => {
        throw new Error(`Gate E cold Core ${index} failed: ${readCoreLogs(home)}`, {
          cause: error,
        });
      });
      coldReadinessMs.push(measurement.elapsedMs);
      await stopCore(measurement.value, home);
    }

    const fixtureHome = temporaryProfile("ndx-ge-f");
    const runtime = await startCore(fixtureHome);
    const projectId = createUuidV7();
    await runtime.client.workspaceApply({
      operationId: "gate-e-create-project",
      intent: {
        kind: "create_initial_project",
        project_id: projectId,
        name: "Gate E benchmark",
        description: "Native Core runtime quality fixture",
        appearance: null,
        source_roots: [path.join(fixtureHome, "source")],
        starter_page: {
          page_id: createUuidV7(),
          document_id: createUuidV7(),
          title_markdown: "Welcome to Nodex",
          markdown: "Welcome to Nodex.",
        },
      },
    });

    const projectClient = runtime.client.forProject(projectId);
    const databaseId = createUuidV7();
    const dataSourceId = createUuidV7();
    const viewId = createUuidV7();
    await projectClient.libraryApply({
      operationId: "gate-e-create-database",
      intent: {
        kind: "create_database",
        database_id: databaseId,
        data_source_id: dataSourceId,
        view_id: viewId,
        name: "Gate E Pages",
        parent: { kind: "library", before: null },
      },
    });
    const pageIds: string[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const committed = await benchmarkStage(
        `fixture Page ${index + 1}`,
        projectClient.libraryApply({
          operationId: `gate-e-fixture-page-${index}`,
          intent: {
            kind: "create_page_from_text",
            title_markdown: `Rust Core benchmark Page ${String(index + 1).padStart(4, "0")}`,
            markdown: `Search projection body ${index + 1}\nShared benchmark token\n`,
            destination: {
              kind: "data_source",
              data_source_id: dataSourceId,
              at: null,
            },
          },
        }),
      );
      const createdPageId = committed.outcome.page_create?.page_id;
      if (!createdPageId) throw new Error("Gate E Page creation omitted its identity");
      pageIds.push(createdPageId);
    }

    const firstPageId = pageIds[0];
    if (!firstPageId) throw new Error("Gate E fixture has no Page");
    await projectClient.libraryRead({
      kind: "page_projection_file",
      page_id: firstPageId,
      file_kind: "body_markdown",
      prepare: null,
    });

    const warmPageReadMs: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const measurement = await elapsedMilliseconds(() =>
        projectClient.libraryRead({
          kind: "page_projection_file",
          page_id: firstPageId,
          file_kind: "body_markdown",
          prepare: null,
        }),
      );
      if (measurement.value.value.kind !== "page_projection_file") {
        throw new Error("Gate E Page read returned an unexpected projection");
      }
      warmPageReadMs.push(measurement.elapsedMs);
    }

    const semanticMutationMs: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const measurement = await elapsedMilliseconds(() =>
        projectClient.libraryApply({
          operationId: `gate-e-measured-page-${index}`,
          intent: {
            kind: "create_page_from_text",
            title_markdown: `Measured semantic mutation ${index + 1}`,
            markdown: "Representative transaction with Document and Database projections\n",
            destination: {
              kind: "data_source",
              data_source_id: dataSourceId,
              at: null,
            },
          },
        }),
      );
      semanticMutationMs.push(measurement.elapsedMs);
    }

    const searchAssemblyMs: number[] = [];
    const warmSearch = await benchmarkStage(
      "initial search snapshot assembly",
      projectClient.libraryRead({
        kind: "acquire_search_snapshot",
        scope: { kind: "database", database_id: databaseId },
        strict_materialization: true,
      }),
    );
    if (warmSearch.value.kind !== "search_snapshot_lease") {
      throw new Error("Gate E search warmup returned an unexpected projection");
    }
    await projectClient.libraryRead({
      kind: "release_search_snapshot",
      lease_id: warmSearch.value.value.lease_id,
    });
    for (let index = 0; index < 30; index += 1) {
      const measurement = await elapsedMilliseconds(() =>
        projectClient.libraryRead({
          kind: "acquire_search_snapshot",
          scope: { kind: "database", database_id: databaseId },
          strict_materialization: true,
        }),
      );
      if (measurement.value.value.kind !== "search_snapshot_lease") {
        throw new Error("Gate E search assembly returned an unexpected projection");
      }
      const lease = measurement.value.value.value;
      if (lease.manifest.pages.length < 1_000) {
        throw new Error("Gate E search snapshot lost fixture Pages");
      }
      searchAssemblyMs.push(measurement.elapsedMs);
      await projectClient.libraryRead({
        kind: "release_search_snapshot",
        lease_id: lease.lease_id,
      });
    }

    const health = await runtime.client.health();
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      command: "pnpm run core:benchmark:rust",
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        node: process.versions.node,
        corePid: runtime.client.handshake.generation.pid,
      },
      fixture: {
        pageCount: pageIds.length,
        measuredMutationCount: semanticMutationMs.length,
        databaseBytes: statSync(path.join(fixtureHome, "nodex.db")).size,
      },
      scenarios: {
        coldCoreReadiness: {
          budgetMs: 2_000,
          samplesMs: coldReadinessMs,
          summary: summary(coldReadinessMs),
        },
        warmOnePageRead: {
          budgetMs: 100,
          samplesMs: warmPageReadMs,
          summary: summary(warmPageReadMs),
        },
        semanticMutationCommit: {
          budgetMs: 300,
          samplesMs: semanticMutationMs,
          summary: summary(semanticMutationMs),
        },
        thousandPageSearchAssembly: {
          budgetMs: 150,
          samplesMs: searchAssemblyMs,
          summary: summary(searchAssemblyMs),
        },
      },
      process: {
        residentSetBytes: residentSetBytes(runtime.client.handshake.generation.pid),
      },
      healthMetrics: health.metrics,
    };

    const outputDirectory = path.resolve(".generated/rust-core-migration/baseline");
    mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, "rust-core-runtime.json");
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nRust Core Gate E benchmark: ${output}\n`);

    expect(report.scenarios.coldCoreReadiness.summary.p95Ms).toBeLessThan(2_000);
    expect(report.scenarios.warmOnePageRead.summary.p95Ms).toBeLessThan(100);
    expect(report.scenarios.semanticMutationCommit.summary.p95Ms).toBeLessThan(300);
    expect(report.scenarios.thousandPageSearchAssembly.summary.p95Ms).toBeLessThan(150);
  });
});
