// @effect-diagnostics nodeBuiltinImport:off -- A Node platform adapter: a worker thread watching shared memory.
import * as NodeWorkerThreads from "node:worker_threads";

/** How often the control loop proves it ran. */
const BEAT_MS = 250;

/**
 * Reports, from its own thread, how far this process's control loop has fallen behind, so the
 * Host can tell a busy process from a stuck one even while the loop itself cannot answer anything.
 *
 * The control loop increments a shared counter every quarter second. The watchdog notes when the
 * counter last moved: the gap is how long the loop has gone without running, measured as it
 * happens rather than after the loop recovers. At the interval the Host asks for, it writes one
 * `health` line to the Host's dedicated descriptor, independent of stdout and its backpressure.
 * Gaps of two seconds or more are appended to a small rotating log with what the process and the
 * computer were doing, which tells CPU starvation, paging and long synchronous work apart.
 */
// Inline worker source also runs in bundles and single-executable builds without module files.
const watchdogSource = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const shared = new Int32Array(workerData.shared);
const FRAME_MS = workerData.intervalMs;
const CHECK_MS = Math.min(250, FRAME_MS);
const STALL_MS = 2000;
const ONGOING_STALL_MS = 60000;
const LOG_MAX_BYTES = 256 * 1024;
let healthFd = workerData.healthFd;
let beat = Atomics.load(shared, 0);
let progressedAt = performance.now();
let periodLag = 0;
let lastFrameAt = progressedAt;
let stall = null;
const usage = () => {
  const value = process.resourceUsage();
  return {
    cpuMs: Math.round((value.userCPUTime + value.systemCPUTime) / 1000),
    majorFaults: value.majorPageFault,
    involuntarySwitches: value.involuntaryContextSwitches,
  };
};
const queue = () => ({ active: Atomics.load(shared, 1), waiting: Atomics.load(shared, 2) });
const append = (record) => {
  const file = workerData.stallLogPath;
  if (!file) return;
  try {
    const line = JSON.stringify(record) + "\\n";
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size + line.length > LOG_MAX_BYTES) fs.renameSync(file, file + ".1");
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {}
};
const describe = (gapMs, phase) => {
  const now = usage();
  return {
    at: new Date(Date.now() - gapMs).toISOString(),
    phase,
    gapMs: Math.round(gapMs),
    // Low CPU with many involuntary switches is starvation; major faults are paging.
    cpuMs: now.cpuMs - stall.usage.cpuMs,
    majorFaults: now.majorFaults - stall.usage.majorFaults,
    involuntarySwitches: now.involuntarySwitches - stall.usage.involuntarySwitches,
    rssBytes: process.memoryUsage.rss(),
    loadAverage: os.platform() === "win32" ? null : os.loadavg()[0],
    cpus: os.availableParallelism(),
    ...queue(),
  };
};
const report = (lagMs) => {
  if (healthFd === null) return;
  try {
    fs.writeSync(healthFd, JSON.stringify({ type: "health", lagMs: Math.round(lagMs), ...queue() }) + "\\n");
  } catch (error) {
    // A full pipe drops one report; a closed or missing descriptor ends reporting.
    if (error && error.code !== "EAGAIN") healthFd = null;
  }
};
// The first report precedes readiness, so the Host can judge silence from the first request on.
report(0);
setInterval(() => {
  const now = performance.now();
  const current = Atomics.load(shared, 0);
  if (current !== beat) {
    beat = current;
    if (stall !== null) {
      append(describe(now - progressedAt, "ended"));
      stall = null;
    }
    progressedAt = now;
  }
  const gap = now - progressedAt;
  periodLag = Math.max(periodLag, gap);
  if (gap >= STALL_MS && stall === null) stall = { usage: usage(), ongoingLogged: false };
  if (stall !== null && gap >= ONGOING_STALL_MS && !stall.ongoingLogged) {
    stall.ongoingLogged = true;
    append(describe(gap, "ongoing"));
  }
  if (now - lastFrameAt >= FRAME_MS) {
    lastFrameAt = now;
    report(periodLag);
    // A gap still open carries into the next report, so it keeps growing until the loop runs.
    periodLag = gap;
  }
}, CHECK_MS);
`;

export interface RuntimeWatchdog {
  /** Records the request queue for health reports and stall records. */
  readonly queue: (active: number, waiting: number) => void;
  readonly stop: () => void;
}

export const startRuntimeWatchdog = (options: {
  /** The Host's health descriptor; reports are written only where the Host asked for them. */
  readonly healthFd: number | null;
  /** How often the Host wants a report. */
  readonly intervalMs: number;
  readonly stallLogPath: string | null;
}): RuntimeWatchdog => {
  // [beat, active requests, waiting requests]
  const shared = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const beat = setInterval(() => Atomics.add(shared, 0, 1), BEAT_MS);
  beat.unref();
  const worker = new NodeWorkerThreads.Worker(watchdogSource, {
    eval: true,
    name: "runtime-watchdog",
    workerData: { shared: shared.buffer, ...options },
  });
  // The watchdog never keeps the process alive, and its failure costs only its reports.
  worker.unref();
  worker.on("error", (error) => {
    process.stderr.write(`Agent Runtime watchdog stopped: ${error.message}\n`);
  });
  return {
    queue: (active, waiting) => {
      Atomics.store(shared, 1, active);
      Atomics.store(shared, 2, waiting);
    },
    stop: () => {
      clearInterval(beat);
      void worker.terminate();
    },
  };
};
