import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [outputArgument = ".generated/native-release-probe", expectedArch = process.arch] = process.argv.slice(2);
const output = path.resolve(outputArgument);
assert.equal(process.platform, "win32", "The probe requires native Windows");
assert.equal(process.arch, expectedArch, "The probe requires the requested native architecture");
await mkdir(output, { recursive: true });

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)("electron");
  const child = spawn(electron, [fileURLToPath(import.meta.url), output, expectedArch], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => { throw error; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  const { killChildProcessTree, terminateWindowsProcessTree } = await import("../../src/main/process-tree.ts");
  const fixture = fileURLToPath(new URL("../fixtures/windows-process-release.mjs", import.meta.url));
  const outcomes = [];
  const serializeError = (error) => ({
    name: error?.name,
    message: String(error?.message ?? error).slice(0, 65_536),
    stack: String(error?.stack ?? "").slice(0, 65_536),
    stderr: String(error?.stderr ?? "").slice(0, 65_536),
  });
  const isPresent = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const readReady = async (directory, role) => {
    const started = performance.now();
    while (performance.now() - started < 10_000) {
      try { return JSON.parse(await readFile(path.join(directory, `${role}.json`), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${role} did not become ready within the separate 10s startup budget`);
  };
  const observeExit = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owner did not observe child exit within 5s after native release")), 5_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };

  for (const mode of ["sync", "async"]) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      for (const stdio of ["pipe", "ignore"]) {
        const name = `${mode}-${signal}-${stdio}`;
        const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-native-release-"));
        const traceDirectory = path.join(output, name);
        await mkdir(traceDirectory, { recursive: true });
        process.env.NODEX_PROCESS_TREE_PROBE_DIRECTORY = traceDirectory;
        const knownPids = new Set();
        const errors = [];
        const result = { name, mode, signal, stdio, startedAt: new Date().toISOString(), cleanup: [] };
        const observePids = () => [...knownPids].map((pid) => {
          try { return { pid, present: isPresent(pid) }; }
          catch (error) {
            errors.push({ phase: "liveness-observation", pid, error: serializeError(error) });
            return { pid, present: "unknown" };
          }
        });
        const launch = (role) => {
          const child = spawn(process.execPath, [fixture, role, directory, stdio], {
            env: process.env,
            stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "ignore",
            windowsHide: true,
          });
          if (child.pid !== undefined) knownPids.add(child.pid);
          const exit = new Promise((resolve) => {
            child.once("error", (error) => resolve({ error: serializeError(error) }));
            child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
          });
          let stdoutBytes = 0;
          let stderrBytes = 0;
          child.stdout?.on("data", (chunk) => { stdoutBytes += chunk.length; });
          child.stderr?.on("data", (chunk) => { stderrBytes += chunk.length; });
          return { child, exit, bytes: () => ({ stdoutBytes, stderrBytes }) };
        };
        const leader = launch("leader");
        const unrelated = launch("unrelated");
        let heartbeat = 0;
        const timer = setInterval(() => { heartbeat += 1; }, 10);
        try {
          const [tree, sibling] = await Promise.all([readReady(directory, "leader"), readReady(directory, "unrelated")]);
          assert.equal(tree.pid, leader.child.pid);
          assert.equal(sibling.pid, unrelated.child.pid);
          assert.ok(Number.isSafeInteger(tree.descendant) && tree.descendant > 0);
          knownPids.add(tree.descendant);
          result.pids = { root: tree.pid, descendant: tree.descendant, unrelated: sibling.pid };
          const beforeHeartbeat = heartbeat;
          const started = performance.now();
          try {
            if (mode === "sync") killChildProcessTree(leader.child, signal, "win32");
            else await terminateWindowsProcessTree(tree.pid, signal);
          } finally {
            result.releaseMs = performance.now() - started;
            result.heartbeatsDuringRelease = heartbeat - beforeHeartbeat;
            result.leaderIo = leader.bytes();
            result.primaryTraceFiles = (await readdir(traceDirectory)).filter((file) => file.endsWith(".jsonl"));
          }
          const primaryRecords = (await Promise.all(result.primaryTraceFiles.map(async (file) => {
            const text = await readFile(path.join(traceDirectory, file), "utf8");
            return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
          }))).flat();
          assert.equal(primaryRecords.filter(({ phase, nativeReady }) => phase === "final-wait" && nativeReady).length, 2, "Both retained kernel handles must have final wait observations");
          result.ownerExit = await observeExit(leader.exit);
          assert.equal(result.ownerExit.error, undefined, "Owned child must have spawned successfully");
          assert.equal(isPresent(tree.descendant), false, "Captured descendant must exit");
          assert.equal(isPresent(sibling.pid), true, "Separately owned sibling must survive");
          assert.equal(unrelated.child.exitCode, null);
        } catch (error) { errors.push({ phase: "primary", error: serializeError(error) }); }
        finally {
          clearInterval(timer);
          // Recover readiness published before a partial startup failure so cleanup still owns every known fixture.
          for (const role of ["leader", "descendant", "unrelated"]) {
            try {
              const readiness = JSON.parse(await readFile(path.join(directory, `${role}.json`), "utf8"));
              if (Number.isSafeInteger(readiness.pid) && readiness.pid > 0) knownPids.add(readiness.pid);
              if (Number.isSafeInteger(readiness.descendant) && readiness.descendant > 0) knownPids.add(readiness.descendant);
            } catch (error) {
              if (error.code !== "ENOENT") errors.push({ phase: "readiness-cleanup", error: serializeError(error) });
            }
          }
          result.beforeCleanup = observePids();
          for (const pid of knownPids) {
            try {
              await terminateWindowsProcessTree(pid, "SIGKILL", 0);
              result.cleanup.push({ pid, status: "fulfilled" });
            } catch (error) {
              const failure = { pid, status: "rejected", error: serializeError(error) };
              result.cleanup.push(failure);
              errors.push({ phase: "cleanup", ...failure });
            }
          }
          result.afterCleanup = observePids();
          if (result.afterCleanup.some(({ present }) => present !== false)) errors.push({ phase: "cleanup", error: { message: "An owned fixture PID remains present or unverified" } });
          try { await rm(directory, { recursive: true, force: true }); }
          catch (error) { errors.push({ phase: "fixture-directory", error: serializeError(error) }); }
          result.kernelTraces = (await readdir(traceDirectory)).filter((file) => file.endsWith(".jsonl"));
          result.errors = errors;
          result.finishedAt = new Date().toISOString();
          outcomes.push(result);
          await writeFile(path.join(traceDirectory, "outcome.json"), `${JSON.stringify(result, null, 2)}\n`);
          console.log(JSON.stringify(result));
        }
      }
    }
  }
  const summary = {
    source: process.env.CI_SOURCE_SHA,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    nativeForceWaitMs: 5_000,
    ownerExitObservationMs: 5_000,
    cases: outcomes.length,
    failed: outcomes.filter(({ errors }) => errors.length > 0).length,
    outcomes,
  };
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  // Every release and cleanup outcome is retained before the disposable runner exits.
  process.exit(summary.failed > 0 ? 1 : 0);
}
