import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  assertBrowserRuntimeSourceClosure,
  readBrowserRuntimeSourceManifest,
} from "../stage-browser-runtime.ts";

const EVENT_PREFIX = "NODEX_REAL_RUNTIME_BENCHMARK ";
const CHECKPOINT_ACK_PREFIX = "NODEX_REAL_RUNTIME_BENCHMARK_ACK ";
const DEFAULT_WINDOW_CYCLE_COUNT = 100;
const DEFAULT_SERVICE_RECONNECT_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_DIAGNOSTIC_LINES = 100;
const RSS_SAMPLE_INTERVAL_MS = 100;

const fixturePath = fileURLToPath(
  new URL("./fixtures/remote-hosted-pip-real-runtime-main.mjs", import.meta.url),
);
const require = createRequire(import.meta.url);

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${name} must be a positive safe integer`);
}

export function parseRealRuntimeOptions(argv = process.argv.slice(2)) {
  const requested = argv.includes("--real-runtime");
  const runtimeRoot = optionValue(argv, "runtime-root");
  return {
    allowNativeUi: argv.includes("--allow-native-ui"),
    electronExecutable: optionValue(argv, "electron-executable"),
    replacementCount: positiveInteger(
      optionValue(argv, "replacement-count"),
      1_000,
      "replacement-count",
    ),
    requested,
    runtimeRoot: runtimeRoot ? path.resolve(runtimeRoot) : null,
    serviceReconnectCount: positiveInteger(
      optionValue(argv, "service-reconnect-count"),
      DEFAULT_SERVICE_RECONNECT_COUNT,
      "service-reconnect-count",
    ),
    taskCycleCount: positiveInteger(optionValue(argv, "task-cycle-count"), 100, "task-cycle-count"),
    timeoutMs: positiveInteger(optionValue(argv, "timeout-ms"), DEFAULT_TIMEOUT_MS, "timeout-ms"),
    windowCycleCount: positiveInteger(
      optionValue(argv, "window-cycle-count"),
      DEFAULT_WINDOW_CYCLE_COUNT,
      "window-cycle-count",
    ),
  };
}

function skipReport(reason, input, details = {}) {
  return {
    environment: {
      arch: process.arch,
      platform: process.platform,
      release: os.release(),
    },
    evidence: {
      grade: "unavailable",
      productionBrowserTouched: false,
      productionProfileTouched: false,
      signedNative: false,
    },
    input: {
      replacementCount: input.replacementCount,
      serviceReconnectCount: input.serviceReconnectCount,
      taskCycleCount: input.taskCycleCount,
      windowCycleCount: input.windowCycleCount,
    },
    reason,
    schemaVersion: 2,
    status: "skipped",
    timestamp: new Date().toISOString(),
    ...details,
  };
}

function sha256(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function command(commandPath, args) {
  return execFileSync(commandPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function inspectCodeSignature(filePath, deep = false) {
  try {
    command("/usr/bin/codesign", ["--verify", ...(deep ? ["--deep"] : []), "--strict", filePath]);
    const inspected = spawnSync("/usr/bin/codesign", ["-dvv", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (inspected.error) throw inspected.error;
    if (inspected.status !== 0) throw new Error(`codesign inspection exited ${inspected.status}`);
    const details = `${inspected.stdout ?? ""}\n${inspected.stderr ?? ""}`;
    return {
      authority: /^Authority=(.+)$/mu.exec(details)?.[1]?.trim() ?? null,
      status: "verified",
      teamId: /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim() ?? null,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      status: "unverified",
      teamId: null,
    };
  }
}

function defaultElectronExecutable() {
  try {
    const candidate = require("electron");
    return typeof candidate === "string" ? candidate : null;
  } catch {
    return null;
  }
}

function requireRealDirectory(directoryPath, label) {
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return fs.realpathSync(directoryPath);
}

function requireRealFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a real file`);
  return fs.realpathSync(filePath);
}

function artifactFor(manifest, artifactPath) {
  const artifact = manifest.artifacts.find((candidate) => candidate.path === artifactPath);
  if (!artifact) throw new Error(`Runtime manifest does not own ${artifactPath}`);
  return artifact;
}

function verifyKeyArtifact(runtimeRoot, manifest, artifactPath, expectedTeamId) {
  const artifact = artifactFor(manifest, artifactPath);
  const absolutePath = requireRealFile(
    path.join(runtimeRoot, ...artifactPath.split("/")),
    artifactPath,
  );
  if (sha256(absolutePath) !== artifact.sha256) {
    throw new Error(`Runtime artifact checksum changed: ${artifactPath}`);
  }
  const architecture = command("/usr/bin/lipo", ["-archs", absolutePath]);
  const expectedArchitecture = manifest.targetArch === "x64" ? "x86_64" : "arm64";
  if (!architecture.split(/\s+/u).includes(expectedArchitecture)) {
    throw new Error(`Runtime artifact architecture changed: ${artifactPath}`);
  }
  const signature = inspectCodeSignature(absolutePath);
  if (signature.status !== "verified" || signature.teamId !== expectedTeamId) {
    throw new Error(`Runtime artifact signature changed: ${artifactPath}`);
  }
  return { absolutePath, architecture, artifact, signature };
}

function inspectRuntime(runtimeRoot) {
  const verifiedRoot = requireRealDirectory(runtimeRoot, "runtime-root");
  const manifest = readBrowserRuntimeSourceManifest(verifiedRoot);
  assertBrowserRuntimeSourceClosure(verifiedRoot, manifest);
  if (manifest.targetPlatform !== "darwin") {
    throw new Error(`Runtime target ${manifest.targetPlatform} is not a macOS closure`);
  }
  if (manifest.targetArch !== process.arch) {
    throw new Error(`Runtime target ${manifest.targetArch} does not match host ${process.arch}`);
  }
  const nativePip = manifest.capabilities.nativePip;
  if (nativePip.status !== "available") throw new Error("Runtime has no native PiP capability");
  const chrome = manifest.capabilities.browserUse.backends.chrome;
  if (chrome.status !== "available") throw new Error("Runtime has no Chrome capability");

  const expectedTeamId = manifest.peerAuthorization.signingTeamId;
  const sky = verifyKeyArtifact(verifiedRoot, manifest, nativePip.addon, expectedTeamId);
  const chromeHost = verifyKeyArtifact(
    verifiedRoot,
    manifest,
    chrome.nativeHost.path,
    chrome.nativeHost.signingTeamId,
  );
  const computerUse = manifest.capabilities.computerUse;
  const service =
    computerUse.status === "available"
      ? verifyKeyArtifact(
          verifiedRoot,
          manifest,
          computerUse.serviceExecutable,
          computerUse.signingTeamId,
        )
      : null;

  return {
    chromeHost,
    computerUse,
    manifest,
    manifestSha256: sha256(path.join(verifiedRoot, "browser-runtime-manifest.json")),
    runtimeRoot: verifiedRoot,
    service,
    sky,
  };
}

export function parseFootprintOutput(output) {
  const footprint = /Footprint:\s+(\d+) B/u.exec(output)?.[1];
  const physical = /^\s*phys_footprint:\s+(\d+) B$/mu.exec(output)?.[1];
  const peak = /^\s*phys_footprint_peak:\s+(\d+) B$/mu.exec(output)?.[1];
  if (!footprint && !physical && !peak) return null;
  return {
    footprintBytes: Number.parseInt(physical ?? footprint ?? "0", 10),
    footprintPeakBytes: Number.parseInt(peak ?? physical ?? footprint ?? "0", 10),
  };
}

function readFootprint(pid) {
  try {
    const output = command("/usr/bin/footprint", [
      "-p",
      String(pid),
      "--noCategories",
      "-f",
      "bytes",
    ]);
    return parseFootprintOutput(output) ?? { reason: "unparseable-output", status: "unavailable" };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      reason: "footprint-command-failed",
      status: "unavailable",
    };
  }
}

export function parseProcessTable(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line))
    .filter(Boolean)
    .map((match) => ({
      command: match[5],
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      rssBytes: Number.parseInt(match[3], 10) * 1024,
      state: match[4],
    }));
}

function readProcessTable() {
  return parseProcessTable(command("/bin/ps", ["-axo", "pid=,ppid=,rss=,state=,command="]));
}

function descendantsOf(records, rootPid) {
  const result = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (result.has(record.pid) || !result.has(record.ppid)) continue;
      result.add(record.pid);
      changed = true;
    }
  }
  return result;
}

export function classifyElectronProcess(record, mainPid) {
  if (record.pid === mainPid) return "electron-main";
  if (record.command.includes("--type=renderer")) return "electron-renderer";
  if (record.command.includes("--type=gpu-process")) return "electron-gpu";
  if (record.command.includes("--type=utility")) return "electron-utility";
  if (record.command.includes("Helper")) return "electron-helper";
  return "electron-child";
}

function readExecutablePath(pid) {
  try {
    const output = command("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
    const candidate = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith("n/") && !line.includes(".dylib"));
    if (candidate) return fs.realpathSync(candidate.slice(1));
  } catch {
    // A just-created process can temporarily have no lsof text vnode. ps comm still comes from
    // the kernel process table and gives us an absolute executable path for identity validation.
  }
  try {
    const candidate = command("/bin/ps", ["-p", String(pid), "-o", "comm="]);
    return path.isAbsolute(candidate) && fs.existsSync(candidate)
      ? fs.realpathSync(candidate)
      : null;
  } catch {
    return null;
  }
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? 0;
}

function numericSummary(samples) {
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

export function summarizeResourceSamples(samples) {
  const roles = new Set(samples.flatMap((sample) => sample.processes.map((entry) => entry.role)));
  roles.add("total");
  return Object.fromEntries(
    [...roles].sort().map((role) => {
      const points = samples.map((sample) => {
        const processes =
          role === "total"
            ? sample.processes
            : sample.processes.filter((entry) => entry.role === role);
        const footprintValues = processes
          .map((entry) => entry.footprintBytes)
          .filter((value) => Number.isFinite(value));
        return {
          footprintBytes:
            footprintValues.length === processes.length && processes.length > 0
              ? footprintValues.reduce((sum, value) => sum + value, 0)
              : null,
          rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
          stage: sample.stage,
        };
      });
      const rss = points.map((point) => point.rssBytes);
      const rssWhenPresent = points
        .filter((point) => point.rssBytes > 0)
        .map((point) => point.rssBytes);
      const footprints = points
        .map((point) => point.footprintBytes)
        .filter((value) => Number.isFinite(value));
      const baseline = points.find((point) => point.stage === "baseline") ?? points[0];
      const recovery = [...points]
        .reverse()
        .find((point) => point.stage === "after-native-teardown");
      return [
        role,
        {
          baselineFootprintBytes: baseline?.footprintBytes ?? null,
          baselineRssBytes: baseline?.rssBytes ?? 0,
          peakFootprintBytes: footprints.length > 0 ? Math.max(...footprints) : null,
          peakRssBytes: Math.max(0, ...rss),
          recoveryFootprintBytes: recovery?.footprintBytes ?? null,
          recoveryRssBytes: recovery?.rssBytes ?? 0,
          rss: numericSummary(rss),
          rssWhenPresent: numericSummary(rssWhenPresent),
          footprintBytes: numericSummary(footprints),
        },
      ];
    }),
  );
}

export function classifyRealRuntimeStatus({ hardGatePassed, nativeHostPassed, workloadStatuses }) {
  if (
    !hardGatePassed ||
    !nativeHostPassed ||
    workloadStatuses.some((status) => status !== "passed" && status !== "unavailable")
  ) {
    return "failed";
  }
  return workloadStatuses.includes("unavailable") ? "partial" : "passed";
}

function boundedPush(target, value) {
  if (!value || target.length >= MAX_DIAGNOSTIC_LINES) return;
  target.push(value.slice(0, 2_048));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ ...result, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // The owned process group may have exited between the timeout and signal.
      }
      forceTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // The owned process group may have exited after graceful termination.
        }
        finish({ code: null, signal: "SIGKILL" });
      }, 2_000);
    }, timeoutMs);
    let forceTimer = null;
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

export async function runRealRuntimeBenchmark(input) {
  if (!input.allowNativeUi) return skipReport("native-ui-opt-in-required", input);
  if (process.platform !== "darwin") return skipReport("platform-unsupported", input);
  if (!input.runtimeRoot) return skipReport("runtime-root-not-provided", input);
  if (!fs.existsSync(input.runtimeRoot)) return skipReport("runtime-root-not-found", input);

  let runtime;
  try {
    runtime = inspectRuntime(input.runtimeRoot);
  } catch (error) {
    return skipReport("runtime-verification-failed", input, {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const electronCandidate = input.electronExecutable ?? defaultElectronExecutable();
  if (!electronCandidate || !fs.existsSync(electronCandidate)) {
    return skipReport("electron-runtime-not-found", input, {
      runtime: {
        manifestSha256: runtime.manifestSha256,
        root: runtime.runtimeRoot,
        signedNative: true,
      },
    });
  }

  let electronExecutable;
  try {
    electronExecutable = requireRealFile(electronCandidate, "electron-executable");
  } catch (error) {
    return skipReport("electron-runtime-invalid", input, {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "nodex-real-runtime-benchmark-"));
  const homePath = path.join(isolatedRoot, "home");
  const userDataPath = path.join(isolatedRoot, "electron-user-data");
  await mkdir(homePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  const computerUse = runtime.manifest.capabilities.computerUse;
  const config = {
    computerUseUnavailableReason: computerUse.status === "available" ? null : computerUse.reason,
    expectedExports: runtime.manifest.capabilities.nativePip.exports.expectedExports,
    replacementCount: input.replacementCount,
    serviceExecutablePath: runtime.service?.absolutePath ?? null,
    serviceReconnectCount: input.serviceReconnectCount,
    skyNativeAddonPath: runtime.sky.absolutePath,
    taskCycleCount: input.taskCycleCount,
    userDataPath,
    windowCycleCount: input.windowCycleCount,
  };
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(isolatedRoot, "codex-home"),
    HOME: homePath,
    NODEX_HOME: path.join(isolatedRoot, "nodex-home"),
    NODEX_REAL_RUNTIME_BENCHMARK_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64url"),
  };

  const electronBundleRoot = electronExecutable.includes(".app/")
    ? electronExecutable.slice(0, electronExecutable.indexOf(".app/") + 4)
    : path.dirname(electronExecutable);
  const electronSignature = {
    ...inspectCodeSignature(electronBundleRoot, electronBundleRoot.endsWith(".app")),
    inspectedPath: electronBundleRoot,
  };
  const samples = [];
  const rejectedProcesses = [];
  const unavailableProcesses = [];
  const diagnostics = { stderr: [], stdout: [] };
  const explicitRoles = new Map();
  const inferredRoles = new Map();
  const externalProcesses = new Map();
  const executableCache = new Map();
  const ownedProcessPaths = new Map();
  const signatureCache = new Map();
  let currentStage = "launch";
  let fixtureFailure = null;
  let fixtureReport = null;
  let samplingPaused = false;

  const child = spawn(
    electronExecutable,
    [fixturePath, `--user-data-dir=${userDataPath}`, "--no-first-run"],
    {
      cwd: path.dirname(fixturePath),
      detached: true,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!child.pid) {
    await rm(isolatedRoot, { force: true, recursive: true });
    return skipReport("electron-launch-returned-no-pid", input);
  }
  const mainPid = child.pid;
  explicitRoles.set(mainPid, "electron-main");

  const captureSnapshot = (stage, includeFootprint = false) => {
    const table = readProcessTable();
    const byPid = new Map(table.map((record) => [record.pid, record]));
    const descendants = descendantsOf(table, mainPid);
    const candidatePids = new Set([...descendants, ...externalProcesses.keys()]);
    const processes = [];
    for (const pid of candidatePids) {
      const record = byPid.get(pid);
      if (!record || record.rssBytes <= 0 || record.state.startsWith("Z")) continue;
      let executablePath = executableCache.get(pid);
      if (!executablePath) {
        executablePath = readExecutablePath(pid);
        if (executablePath) executableCache.set(pid, executablePath);
      }
      let external = externalProcesses.get(pid);
      const isElectronDescendant = descendants.has(pid);
      if (!executablePath) {
        unavailableProcesses.push({
          pid,
          processCommand: record.command,
          reason: "executable-unavailable-during-sample",
          stage,
          state: record.state,
        });
        continue;
      }
      if (
        !external &&
        isElectronDescendant &&
        runtime.service &&
        executablePath === runtime.service.absolutePath
      ) {
        external = { executablePath };
        externalProcesses.set(pid, external);
        explicitRoles.set(pid, "computer-use-service");
      }
      const pathVerified = external
        ? executablePath === external.executablePath
        : isElectronDescendant &&
          executablePath !== null &&
          (pid === mainPid
            ? executablePath === electronExecutable
            : executablePath.startsWith(`${electronBundleRoot}${path.sep}`));
      if (!pathVerified) {
        rejectedProcesses.push({
          actualExecutablePath: executablePath,
          expectedExecutablePath: external?.executablePath ?? electronBundleRoot,
          pid,
          reason: "executable-or-ownership-mismatch",
          stage,
        });
        continue;
      }
      let signature = signatureCache.get(executablePath);
      if (!signature) {
        signature = inspectCodeSignature(executablePath);
        signatureCache.set(executablePath, signature);
      }
      const footprint = includeFootprint ? readFootprint(pid) : null;
      const inferredRole = external
        ? "computer-use-service"
        : classifyElectronProcess(record, mainPid);
      if (!inferredRoles.has(pid)) inferredRoles.set(pid, inferredRole);
      const role = explicitRoles.get(pid) ?? inferredRoles.get(pid);
      const ownership = external
        ? "validated-external-native-service"
        : pid === mainPid
          ? "spawned-electron-main"
          : "verified-electron-descendant";
      ownedProcessPaths.set(pid, executablePath);
      processes.push({
        executablePath,
        ...(footprint && "footprintBytes" in footprint
          ? {
              footprintBytes: footprint.footprintBytes,
              footprintPeakBytes: footprint.footprintPeakBytes,
            }
          : footprint
            ? { footprintUnavailable: footprint }
            : {}),
        pid,
        ppid: record.ppid,
        ownership,
        role,
        rssBytes: record.rssBytes,
        signature,
      });
    }
    samples.push({
      capturedAt: new Date().toISOString(),
      processes,
      stage,
    });
  };

  const footprintStages = new Set([
    "baseline",
    "after-latest-frame-replacement",
    "after-task-cycles",
    `window-avatar-churn-${input.windowCycleCount}`,
    "before-native-teardown",
    "after-native-teardown",
  ]);
  const processEvent = (event) => {
    if (event.type === "owned-process" && Number.isSafeInteger(event.pid) && event.pid > 0) {
      explicitRoles.set(event.pid, event.role);
      return;
    }
    if (event.type === "checkpoint") {
      currentStage = event.stage;
      if (event.samplingControl === "pause") samplingPaused = true;
      if (event.samplingControl === "resume") samplingPaused = false;
      if (Array.isArray(event.ownedProcesses)) {
        for (const ownedProcess of event.ownedProcesses) {
          if (
            Number.isSafeInteger(ownedProcess?.pid) &&
            ownedProcess.pid > 0 &&
            typeof ownedProcess.role === "string"
          ) {
            explicitRoles.set(ownedProcess.pid, ownedProcess.role);
          }
        }
      }
      if (
        Number.isSafeInteger(event.pid) &&
        event.pid > 0 &&
        event.validatedExecutable === true &&
        typeof event.executablePath === "string"
      ) {
        externalProcesses.set(event.pid, {
          executablePath: fs.realpathSync(event.executablePath),
        });
        explicitRoles.set(event.pid, "computer-use-service");
      }
      try {
        captureSnapshot(
          currentStage,
          footprintStages.has(currentStage) ||
            /^service-\d+-running$/u.test(currentStage) ||
            currentStage === `window-avatar-active-${input.windowCycleCount}`,
        );
      } finally {
        if (typeof event.checkpointId === "string" && child.stdin.writable) {
          child.stdin.write(`${CHECKPOINT_ACK_PREFIX}${event.checkpointId}\n`);
        }
      }
      return;
    }
    if (event.type === "result") fixtureReport = event.report;
    if (event.type === "failure") fixtureFailure = event.error;
  };

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    if (!line.startsWith(EVENT_PREFIX)) {
      boundedPush(diagnostics.stdout, line);
      return;
    }
    try {
      processEvent(JSON.parse(line.slice(EVENT_PREFIX.length)));
    } catch (error) {
      boundedPush(diagnostics.stdout, `invalid-event:${String(error)}`);
    }
  });
  const stderrLines = readline.createInterface({ input: child.stderr });
  stderrLines.on("line", (line) => boundedPush(diagnostics.stderr, line));
  child.stdin.on("error", (error) => boundedPush(diagnostics.stderr, `stdin:${String(error)}`));

  const rssSampler = setInterval(() => {
    if (samplingPaused) return;
    try {
      captureSnapshot(`interval:${currentStage}`);
    } catch (error) {
      boundedPush(diagnostics.stderr, `rss-sample:${String(error)}`);
    }
  }, RSS_SAMPLE_INTERVAL_MS);

  let exit;
  let leakedProcesses = [];
  try {
    exit = await waitForExit(child, input.timeoutMs);
    clearInterval(rssSampler);
    captureSnapshot("post-exit");
    leakedProcesses = [...ownedProcessPaths]
      .filter(
        ([pid, expectedExecutablePath]) =>
          processAlive(pid) && readExecutablePath(pid) === expectedExecutablePath,
      )
      .map(([pid, executablePath]) => ({ executablePath, pid }));
    for (const leaked of leakedProcesses) {
      try {
        process.kill(leaked.pid, "SIGTERM");
        await waitForGone(leaked.pid);
      } catch {
        // Evidence records any process that could not be safely reclaimed.
      }
    }
  } finally {
    clearInterval(rssSampler);
    stdoutLines.close();
    stderrLines.close();
    await rm(isolatedRoot, { force: true, recursive: true });
  }

  const remainingLeaks = leakedProcesses.filter((entry) => processAlive(entry.pid));
  const verifiedProcesses = [...ownedProcessPaths].map(([pid, executablePath]) => ({
    executablePath,
    ownership: externalProcesses.has(pid)
      ? "validated-external-native-service"
      : pid === mainPid
        ? "spawned-electron-main"
        : "verified-electron-descendant",
    pid,
    role: explicitRoles.get(pid) ?? inferredRoles.get(pid) ?? "unknown",
    signature: signatureCache.get(executablePath) ?? null,
  }));
  const nativeTeardownPassed =
    fixtureReport?.nativeAfterTeardown?.hasAnyPresentation === false &&
    fixtureReport?.nativeAfterTeardown?.activeTaskIds?.length === 0;
  const workloadStatuses = [
    fixtureReport?.replacement?.status,
    fixtureReport?.taskCycles?.status,
    fixtureReport?.windowAvatarChurn?.status,
    fixtureReport?.serviceReconnect?.status,
  ];
  const nativeHostPassed =
    fixtureReport?.nativeHost?.hostRegistered === true &&
    fixtureReport.nativeHost.hostStarted === true &&
    fixtureReport.nativeHost.seedAccepted === true;
  const hardGatePassed =
    exit?.code === 0 &&
    !exit?.timedOut &&
    fixtureReport !== null &&
    fixtureFailure === null &&
    fixtureReport.checkpointTimeouts?.length === 0 &&
    nativeTeardownPassed &&
    rejectedProcesses.length === 0 &&
    unavailableProcesses.length === 0 &&
    remainingLeaks.length === 0;
  const status = classifyRealRuntimeStatus({
    hardGatePassed,
    nativeHostPassed,
    workloadStatuses,
  });

  return {
    chromeNativeMessaging: {
      reason: "no-owned-disposable-extension-instance",
      status: "unavailable",
    },
    diagnostics,
    environment: {
      arch: process.arch,
      electron: electronExecutable,
      electronVersion: fixtureReport?.environment?.electron ?? null,
      node: process.version,
      platform: process.platform,
      release: os.release(),
    },
    evidence: {
      grade: electronSignature.teamId ? "signed-runtime-and-electron" : "signed-runtime-mixed-host",
      productionBrowserTouched: false,
      productionProfileTouched: false,
      signedNative: true,
    },
    input: {
      replacementCount: input.replacementCount,
      serviceReconnectCount: input.serviceReconnectCount,
      taskCycleCount: input.taskCycleCount,
      windowCycleCount: input.windowCycleCount,
    },
    memory: {
      rejectedProcesses: rejectedProcesses.slice(0, 200),
      samples,
      summaryByRole: summarizeResourceSamples(samples),
      unavailableProcesses: unavailableProcesses.slice(0, 200),
    },
    processOwnership: {
      electron: { executablePath: electronExecutable, signature: electronSignature },
      leakedAfterExit: remainingLeaks,
      mainPid,
      verifiedProcesses,
    },
    runtime: {
      browserPluginVersion: runtime.manifest.browserPlugin.version,
      chromeHost: {
        executablePath: runtime.chromeHost.absolutePath,
        sha256: runtime.chromeHost.artifact.sha256,
        signature: runtime.chromeHost.signature,
        status: "verified-not-launched",
      },
      computerUse: computerUse.status,
      manifestSha256: runtime.manifestSha256,
      root: runtime.runtimeRoot,
      runtimeVersions: runtime.manifest.runtimeVersions,
      skyNativeAddon: {
        executablePath: runtime.sky.absolutePath,
        expectedExportCount: runtime.manifest.capabilities.nativePip.exports.expectedExportCount,
        sha256: runtime.sky.artifact.sha256,
        signature: runtime.sky.signature,
      },
      targetArch: runtime.manifest.targetArch,
      targetPlatform: runtime.manifest.targetPlatform,
    },
    schemaVersion: 2,
    status,
    teardown: {
      nativeStateReturnedToBaseline: nativeTeardownPassed,
      processTreeReturnedToBaseline: remainingLeaks.length === 0,
    },
    timestamp: new Date().toISOString(),
    transport: {
      exit,
      fixtureFailure,
    },
    workloads: fixtureReport,
  };
}
