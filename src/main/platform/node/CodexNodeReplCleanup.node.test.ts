/* oxlint-disable effecttsgo/async-function -- Filesystem records and process ancestry are checked at the Node boundary; the application runtime owns timeout and cancellation. */
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  cleanupNodeReplExecutions,
  listNodeReplChildProcesses,
  createNodeReplWindowsProcessProviderLoader,
} from "./CodexNodeReplCleanup";

async function fixture(run: (home: string, path: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "nodex-repl-cleanup-"));
  const directory = join(home, "node_repl", "active_execs");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "exec.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      execId: "exec",
      sessionId: "session",
      turnId: "turn",
      nodeReplPid: 101,
      kernelPid: 102,
      startedAtMs: 0,
    }),
  );
  try {
    await run(home, path);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("removes stale PID records without killing an unrelated process", async () =>
  fixture(async (codexHome, path) => {
    const killed: number[] = [];
    const result = await cleanupNodeReplExecutions({
      codexHome,
      sessionId: "session",
      turnId: "turn",
      dependencies: {
        listChildProcesses: async () => [{ pid: 103, depth: 1 }],
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });
    expect(killed).toEqual([]);
    expect(result).toEqual({ failedCount: 0, killedCount: 0, scannedCount: 1, staleCount: 1 });
    await expect(access(path)).rejects.toThrow();
  }));

test("kills verified descendants deepest first, deduplicates, and removes completed record", async () =>
  fixture(async (codexHome, path) => {
    const killed: number[] = [];
    const result = await cleanupNodeReplExecutions({
      codexHome,
      sessionId: "session",
      turnId: "turn",
      dependencies: {
        listChildProcesses: async (pid) =>
          pid === 101
            ? [{ pid: 102, depth: 1 }]
            : [
                { pid: 103, depth: 1 },
                { pid: 104, depth: 2 },
                { pid: 103, depth: 1 },
              ],
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });
    expect(killed).toEqual([104, 103, 102]);
    expect(result.killedCount).toBe(1);
    await expect(access(path)).rejects.toThrow();
  }));

test("another turn's valid record survives without process inspection", async () =>
  fixture(async (codexHome, path) => {
    const result = await cleanupNodeReplExecutions({
      codexHome,
      sessionId: "session",
      turnId: "other",
      dependencies: {
        listChildProcesses: async () => {
          throw new Error("must not inspect");
        },
      },
    });
    expect(result).toEqual({ failedCount: 0, killedCount: 0, scannedCount: 1, staleCount: 0 });
    await access(path);
  }));

test("failed descendant enumeration kills only verified kernel and preserves retry record", async () =>
  fixture(async (codexHome, path) => {
    const killed: number[] = [];
    const result = await cleanupNodeReplExecutions({
      codexHome,
      sessionId: "session",
      turnId: "turn",
      dependencies: {
        listChildProcesses: async (pid) => {
          if (pid === 101) return [{ pid: 102, depth: 1 }];
          throw new Error("ps failed");
        },
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });
    expect(killed).toEqual([102]);
    expect(result.failedCount).toBe(1);
    await access(path);
  }));

test("process enumeration rechecks ancestry after selecting descendants", async () => {
  const calls: string[][] = [];
  const row = (pid: number, parent: number) =>
    `${pid} ${parent} 0.0 12 Sun Sep 13 00:00:00 2026 node`;
  const result = await listNodeReplChildProcesses(10, async (args) => {
    calls.push([...args]);
    if (args[0] === "-ax") return "11 10\n12 11\n13 10\n14 13\n999 1";
    return [row(11, 10), row(12, 11), row(13, 1), row(14, 13)].join("\n");
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[1]).toBe("11,12,13,14");
  expect(result).toEqual([
    { pid: 11, depth: 1 },
    { pid: 12, depth: 2 },
  ]);
});

test("empty descendant selection performs no second process query", async () => {
  let calls = 0;
  expect(
    await listNodeReplChildProcesses(10, async () => {
      calls += 1;
      return "11 1";
    }),
  ).toEqual([]);
  expect(calls).toBe(1);
});
test("Windows uses its native descendant snapshot and never executes POSIX commands", async () =>
  fixture(async (codexHome, path) => {
    const requests: Array<{ includeCommandLine: true; rootPid: number }> = [];
    const killed: number[] = [];
    const provider = {
      listProcesses: (request: { includeCommandLine: true; rootPid: number }) => {
        requests.push(request);
        return [
          { pid: 101, parentPid: 1 },
          { pid: 102, parentPid: 101 },
          { pid: 103, parentPid: 102 },
          { pid: 104, parentPid: 103 },
          { pid: 900, parentPid: 1 },
        ];
      },
    };
    const counts = await cleanupNodeReplExecutions({
      codexHome,
      sessionId: "session",
      turnId: "turn",
      dependencies: {
        listChildProcesses: (pid) =>
          listNodeReplChildProcesses(
            pid,
            async () => {
              throw new Error("POSIX path must not run");
            },
            { platform: "win32", loadWindowsProvider: () => provider },
          ),
        kill: (pid) => {
          killed.push(pid);
        },
      },
    });
    expect(requests).toEqual([
      { includeCommandLine: true, rootPid: 101 },
      { includeCommandLine: true, rootPid: 102 },
    ]);
    expect(killed).toEqual([104, 103, 102]);
    expect(counts).toEqual({ failedCount: 0, killedCount: 1, scannedCount: 1, staleCount: 0 });
    await expect(access(path)).rejects.toThrow();
  }));
test("native provider discovery retries an absent resource and caches an installed addon", async () => {
  let exists = false;
  const loads: string[] = [];
  const provider = { listProcesses: () => [] };
  const load = createNodeReplWindowsProcessProviderLoader({
    resourcesPath: "/bundle",
    exists: () => exists,
    load: (path) => {
      loads.push(path);
      return provider;
    },
  });
  expect(
    await listNodeReplChildProcesses(
      101,
      async () => {
        throw new Error("must not run ps");
      },
      { platform: "win32", loadWindowsProvider: load },
    ),
  ).toEqual([]);
  exists = true;
  expect(load()).toBe(provider);
  expect(load()).toBe(provider);
  expect(loads).toEqual([join("/bundle", "native", "windows-account.node")]);
});
