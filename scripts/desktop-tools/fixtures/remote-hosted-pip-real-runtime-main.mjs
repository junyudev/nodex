import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import process from "node:process";
import readline from "node:readline";
import { app, BrowserWindow } from "electron";

const EVENT_PREFIX = "NODEX_REAL_RUNTIME_BENCHMARK ";
const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAE/wJ/lmQ6WQAAAABJRU5ErkJggg==";
const CHECKPOINT_ACK_PREFIX = "NODEX_REAL_RUNTIME_BENCHMARK_ACK ";
const CHECKPOINT_ACK_TIMEOUT_MS = 15_000;

const emit = (event) => process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const checkpointTimeouts = [];
const pendingCheckpointAcks = new Map();
const checkpointInput = readline.createInterface({ input: process.stdin });
let checkpointSequence = 0;

checkpointInput.on("line", (line) => {
  if (!line.startsWith(CHECKPOINT_ACK_PREFIX)) return;
  const checkpointId = line.slice(CHECKPOINT_ACK_PREFIX.length);
  pendingCheckpointAcks.get(checkpointId)?.();
});

async function checkpoint(stage, details = {}) {
  checkpointSequence += 1;
  const checkpointId = String(checkpointSequence);
  const acknowledged = new Promise((resolve) => {
    pendingCheckpointAcks.set(checkpointId, () => resolve(true));
  });
  emit({ ...details, checkpointId, stage, type: "checkpoint" });
  const acknowledgedBeforeTimeout = await Promise.race([
    acknowledged,
    delay(CHECKPOINT_ACK_TIMEOUT_MS).then(() => false),
  ]);
  pendingCheckpointAcks.delete(checkpointId);
  if (!acknowledgedBeforeTimeout) checkpointTimeouts.push({ checkpointId, stage });
}

function readConfig() {
  const encoded = process.env.NODEX_REAL_RUNTIME_BENCHMARK_CONFIG;
  if (!encoded) throw new Error("Missing real-runtime benchmark configuration");
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid real-runtime benchmark configuration");
  }
  return value;
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? 0;
}

function summarize(samples) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

function nativeHostRegistration(window) {
  const bounds = window.getContentBounds();
  return {
    anchors: [
      { alignment: "top-right", point: { x: bounds.width - 24, y: 24 } },
      { alignment: "bottom-right", point: { x: bounds.width - 24, y: bounds.height - 24 } },
    ],
    anchorRect: bounds,
    animated: false,
    animationSpring: null,
    contentBounds: bounds,
    id: "real-runtime-benchmark-host",
    interactionPassthroughRect: null,
    isCodexHomeAvailable: false,
    nativeWindowHandle: window.getNativeWindowHandle(),
    presentationScope: "all",
    title: "Nodex Real Runtime Benchmark",
  };
}

async function createWindow(input) {
  const window = new BrowserWindow({
    frame: input.avatar ? false : true,
    height: input.avatar ? 96 : 180,
    show: false,
    skipTaskbar: true,
    transparent: input.avatar,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
    width: input.avatar ? 96 : 260,
  });
  await window.loadURL(
    `data:text/html,<title>${input.avatar ? "Avatar" : "Window"}</title><body></body>`,
  );
  return window;
}

async function waitForProcess(addon, pid, executablePath, expectedAlive) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    const matches = alive
      ? addon.computerUseServiceProcessMatchesExecutablePath(pid, executablePath)
      : false;
    if (expectedAlive ? alive && matches : !alive || !matches) return true;
    await delay(50);
  }
  return false;
}

async function runServiceReconnect(addon, input) {
  if (!input.serviceExecutablePath) {
    return { reason: input.computerUseUnavailableReason, status: "unavailable" };
  }

  const latencies = [];
  const lifecycleLatencies = [];
  const processIds = [];
  let connectedCount = 0;
  let terminatedCount = 0;
  for (let cycle = 1; cycle <= input.serviceReconnectCount; cycle += 1) {
    await checkpoint(`service-${cycle}-bootstrap`, { samplingControl: "pause" });
    const startedAt = performance.now();
    const pid = await addon.spawnComputerUseService(input.serviceExecutablePath);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      await checkpoint(`service-${cycle}-unavailable`, { samplingControl: "resume" });
      return {
        attemptedCycles: cycle,
        reason: "native-spawn-returned-no-pid",
        status: "unavailable",
      };
    }
    const validated = await waitForProcess(addon, pid, input.serviceExecutablePath, true);
    if (!validated) {
      await checkpoint(`service-${cycle}-invalid`, { samplingControl: "resume" });
      return {
        attemptedCycles: cycle,
        pid,
        reason: "service-process-identity-mismatch",
        status: "failed",
      };
    }
    processIds.push(pid);
    if (addon.connectRemoteHostedPIPContentHost(pid)) connectedCount += 1;
    latencies.push(performance.now() - startedAt);
    // The service briefly creates a bootstrap process. Let it settle so the resource snapshot
    // describes the long-lived service rather than an exited process-table row.
    await delay(250);
    await checkpoint(`service-${cycle}-running`, {
      executablePath: input.serviceExecutablePath,
      pid,
      samplingControl: "resume",
      validatedExecutable: validated,
    });
    if (!addon.computerUseServiceProcessMatchesExecutablePath(pid, input.serviceExecutablePath)) {
      return {
        attemptedCycles: cycle,
        pid,
        reason: "service-identity-changed-before-termination",
        status: "failed",
      };
    }
    process.kill(pid, "SIGTERM");
    if (await waitForProcess(addon, pid, input.serviceExecutablePath, false)) terminatedCount += 1;
    await checkpoint(`service-${cycle}-stopped`, { pid });
    lifecycleLatencies.push(performance.now() - startedAt);
  }
  if (terminatedCount !== input.serviceReconnectCount) {
    return {
      connectedCount,
      latency: summarize(latencies),
      lifecycleLatency: summarize(lifecycleLatencies),
      processIds,
      reason: "service-did-not-terminate-within-timeout",
      status: "failed",
      terminatedCount,
    };
  }
  return {
    connectedCount,
    latency: summarize(latencies),
    lifecycleLatency: summarize(lifecycleLatencies),
    processIds,
    reason:
      connectedCount === input.serviceReconnectCount
        ? null
        : "native-service-connection-rejected",
    status: connectedCount === input.serviceReconnectCount ? "passed" : "unavailable",
    terminatedCount,
  };
}

async function runNativeBenchmark(config) {
  const require = createRequire(import.meta.url);
  const addon = require(config.skyNativeAddonPath);
  const actualExports = Object.keys(addon).sort();
  const expectedExports = [...config.expectedExports].sort();
  if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
    throw new Error("Signed sky.node export contract does not match the verified manifest");
  }

  const hostWindow = await createWindow({ avatar: false });
  hostWindow.setBounds({ height: 480, width: 720, x: 80, y: 80 });
  const hostRendererPid = hostWindow.webContents.getOSProcessId();
  emit({ pid: hostRendererPid, role: "renderer-host", type: "owned-process" });
  await checkpoint("baseline", { pid: process.pid });

  let serviceConnectionLostCount = 0;
  addon.setBrowserUsePIPContentClickHandler(() => undefined);
  addon.setRemoteHostedPIPContentComputerUseCursorLocationHandler(() => undefined);
  addon.setRemoteHostedPIPContentLayoutStateChangedHandler(() => undefined);
  addon.setRemoteHostedPIPContentMaxDisplaySizeChangedHandler(() => undefined);
  addon.setRemoteHostedPIPContentPetWakeRequestHandler(() => undefined);
  addon.setRemoteHostedPIPContentShouldShowTaskHandler(() => true);
  addon.setRemoteHostedPIPContentVisibilityRequestHandler(() => undefined);

  const hostStarted = addon.startRemoteHostedPIPContentHost(
    {
      closeTooltip: "Close Picture-in-Picture",
      hide: "Hide Picture-in-Picture",
      hideForAllActiveTasks: "Hide for all active tasks",
      hideForTask: "Hide for this task",
      placementTooltip: "Move Picture-in-Picture",
    },
    () => void (serviceConnectionLostCount += 1),
  );
  const hostRegistered = addon.registerRemoteHostedPIPContentHost(
    nativeHostRegistration(hostWindow),
  );
  const seedAccepted = addon.upsertBrowserUsePIPContent(
    "latest-frame",
    "latest-frame-thread",
    TRANSPARENT_PIXEL,
    null,
  );
  await checkpoint("native-host-ready", { hostRegistered, hostStarted, seedAccepted });

  const replacementLatencies = [];
  let replacementAcceptedCount = 0;
  if (seedAccepted || hostStarted || hostRegistered) {
    for (let update = 1; update <= config.replacementCount; update += 1) {
      const startedAt = performance.now();
      const accepted = addon.upsertBrowserUsePIPContent(
        "latest-frame",
        "latest-frame-thread",
        TRANSPARENT_PIXEL,
        null,
      );
      replacementLatencies.push(performance.now() - startedAt);
      if (accepted) replacementAcceptedCount += 1;
      if (update % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await checkpoint("after-latest-frame-replacement");

  const taskCycleLatencies = [];
  let taskCycleAcceptedCount = 0;
  for (let cycle = 1; cycle <= config.taskCycleCount; cycle += 1) {
    const presentationId = `task-presentation-${cycle}`;
    const threadId = `task-thread-${cycle}`;
    const startedAt = performance.now();
    const accepted = addon.upsertBrowserUsePIPContent(
      presentationId,
      threadId,
      TRANSPARENT_PIXEL,
      null,
    );
    const invalidated = addon.invalidateBrowserUsePIPContent(presentationId);
    addon.completeRemoteHostedPIPContentThread(threadId);
    taskCycleLatencies.push(performance.now() - startedAt);
    if (accepted && invalidated) taskCycleAcceptedCount += 1;
    if (cycle % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  await checkpoint("after-task-cycles");

  const windowCycleLatencies = [];
  const observedRendererPids = new Set([hostRendererPid]);
  for (let cycle = 1; cycle <= config.windowCycleCount; cycle += 1) {
    const startedAt = performance.now();
    const primary = await createWindow({ avatar: false });
    const avatar = await createWindow({ avatar: true });
    const primaryRendererPid = primary.webContents.getOSProcessId();
    const avatarRendererPid = avatar.webContents.getOSProcessId();
    observedRendererPids.add(primaryRendererPid);
    observedRendererPids.add(avatarRendererPid);
    hostWindow.setBounds({
      height: 480,
      width: 720,
      x: 80 + (cycle % 5) * 16,
      y: 80 + (cycle % 3) * 16,
    });
    const creationLatencyMs = performance.now() - startedAt;
    await checkpoint(`window-avatar-active-${cycle}`, {
      ownedProcesses: [
        { pid: primaryRendererPid, role: "renderer-primary-churn" },
        { pid: avatarRendererPid, role: "renderer-avatar-churn" },
      ],
    });
    const teardownStartedAt = performance.now();
    primary.destroy();
    avatar.destroy();
    windowCycleLatencies.push(creationLatencyMs + performance.now() - teardownStartedAt);
    if (cycle % 10 === 0 || cycle === config.windowCycleCount) {
      await checkpoint(`window-avatar-churn-${cycle}`, {
        observedRendererPidCount: observedRendererPids.size,
      });
      if (cycle !== config.windowCycleCount) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  const serviceReconnect = await runServiceReconnect(addon, config);
  await checkpoint("before-native-teardown");

  addon.invalidateBrowserUsePIPContent("latest-frame");
  addon.completeRemoteHostedPIPContentThread("latest-frame-thread");
  addon.unregisterRemoteHostedPIPContentHost("real-runtime-benchmark-host");
  addon.stopRemoteHostedPIPContentHost();
  addon.setBrowserUsePIPContentClickHandler(null);
  addon.setRemoteHostedPIPContentComputerUseCursorLocationHandler(null);
  addon.setRemoteHostedPIPContentLayoutStateChangedHandler(null);
  addon.setRemoteHostedPIPContentMaxDisplaySizeChangedHandler(null);
  addon.setRemoteHostedPIPContentPetWakeRequestHandler(null);
  addon.setRemoteHostedPIPContentShouldShowTaskHandler(null);
  addon.setRemoteHostedPIPContentVisibilityRequestHandler(null);
  hostWindow.destroy();
  await delay(500);

  const nativeAfterTeardown = {
    activeTaskIds: addon.getRemoteHostedPIPContentActiveTaskIDs(),
    hasAnyPresentation: addon.hasRemoteHostedPIPContentAnyPresentation(),
  };
  await checkpoint("after-native-teardown");
  return {
    checkpointTimeouts,
    environment: {
      electron: process.versions.electron ?? null,
      node: process.version,
    },
    nativeHost: { hostRegistered, hostStarted, seedAccepted },
    nativeAfterTeardown,
    replacement: {
      acceptedCount: replacementAcceptedCount,
      attemptedCount: replacementLatencies.length,
      latency: summarize(replacementLatencies),
      status:
        replacementLatencies.length === config.replacementCount &&
        replacementAcceptedCount === config.replacementCount
          ? "passed"
          : "unavailable",
      unavailableReason:
        replacementLatencies.length === config.replacementCount &&
        replacementAcceptedCount === config.replacementCount
          ? null
          : seedAccepted || hostStarted || hostRegistered
            ? "native-upsert-rejected"
            : "native-host-unavailable",
    },
    serviceConnectionLostCount,
    serviceReconnect,
    taskCycles: {
      acceptedCount: taskCycleAcceptedCount,
      attemptedCount: taskCycleLatencies.length,
      latency: summarize(taskCycleLatencies),
      status: taskCycleAcceptedCount === config.taskCycleCount ? "passed" : "unavailable",
      unavailableReason:
        taskCycleAcceptedCount === config.taskCycleCount ? null : "native-task-cycle-rejected",
    },
    windowAvatarChurn: {
      attemptedCount: windowCycleLatencies.length,
      latency: summarize(windowCycleLatencies),
      observedRendererPidCount: observedRendererPids.size,
      status: windowCycleLatencies.length === config.windowCycleCount ? "passed" : "failed",
    },
  };
}

const config = readConfig();
app.setName("Nodex Real Runtime Benchmark");
app.setPath("userData", config.userDataPath);
app.on("window-all-closed", () => undefined);

// Electron does not emit ready until the ESM main entrypoint has finished evaluating. Keeping
// app.whenReady() as a top-level await therefore deadlocks startup before the fixture can run.
void app
  .whenReady()
  .then(async () => {
    const report = await runNativeBenchmark(config);
    emit({ report, type: "result" });
    checkpointInput.close();
    app.quit();
  })
  .catch((error) => {
    emit({
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      type: "failure",
    });
    checkpointInput.close();
    app.exit(1);
  });
