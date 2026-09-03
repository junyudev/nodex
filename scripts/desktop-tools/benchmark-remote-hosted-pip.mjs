#!/usr/bin/env -S node --import tsx

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  BROWSER_PIP_IMAGE_LIMITS,
  admitBrowserPipResource,
  emptyBrowserPipResourceState,
  releaseBrowserPipResources,
} from "../../src/main/browser-use/browser-pip-image-resource-governor.ts";
import {
  RemoteHostedPipRuntime,
  testLayer as remoteHostedPipTestLayer,
} from "../../src/main/host-runtime/RemoteHostedPipRuntime.ts";
import { makeRemoteHostedPipPreferences } from "../../src/main/remote-hosted-pip-preference-store.ts";
import {
  WindowRuntime,
  fromState as windowRuntimeFromState,
} from "../../src/main/window-runtime/WindowRuntime.ts";
import { WindowSessionState } from "../../src/main/window-session-state.ts";

export const DEFAULT_REPLACEMENT_COUNT = 1_000;
export const DEFAULT_TASK_CYCLE_COUNT = 100;
const LOCAL_HOST_ID = "state-evidence-local-host";

export function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? 0;
}

export function summarize(samples) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

function memorySample(stage) {
  const usage = process.memoryUsage();
  return {
    arrayBuffersBytes: usage.arrayBuffers,
    externalBytes: usage.external,
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
    stage,
  };
}

function lease(presentationId, sessionKey, taskId, updatedAt) {
  return {
    compressedBytes: 24,
    estimatedDecodedBytes: 4,
    presentationId,
    sessionKey,
    taskId,
    updatedAt,
  };
}

function requireAdmitted(admission) {
  if (!admission.admitted || admission.reason) {
    throw new Error(`Remote Hosted PiP benchmark admission failed: ${admission.reason}`);
  }
  return admission.state;
}

function resourceTotals(state) {
  let decodedBytes = 0;
  for (const candidate of state.leases.values()) {
    decodedBytes += candidate.estimatedDecodedBytes;
  }
  return { decodedBytes, presentationCount: state.leases.size };
}

function runResourceGovernorBenchmark(replacementCount, taskCycleCount) {
  const replacementSamples = [];
  const lifecycleSamples = [];
  let peakDecodedBytes = 0;
  let peakPresentationCount = 0;
  let state = emptyBrowserPipResourceState();

  const recordHighWater = () => {
    const totals = resourceTotals(state);
    peakDecodedBytes = Math.max(peakDecodedBytes, totals.decodedBytes);
    peakPresentationCount = Math.max(peakPresentationCount, totals.presentationCount);
  };

  for (let update = 1; update <= replacementCount; update += 1) {
    const startedAt = performance.now();
    state = requireAdmitted(
      admitBrowserPipResource(
        state,
        lease("current-tab", "current-session", "current-thread", update),
      ),
    );
    replacementSamples.push(performance.now() - startedAt);
    recordHighWater();
    if (state.leases.size !== 1) {
      throw new Error(`Replacement ${update} retained ${state.leases.size} presentations`);
    }
  }

  state = releaseBrowserPipResources(
    state,
    (candidate) => candidate.taskId === "current-thread",
  ).state;
  if (state.leases.size !== 0) throw new Error("Replacement teardown retained presentations");

  for (let cycle = 1; cycle <= taskCycleCount; cycle += 1) {
    const taskId = `task-${cycle}`;
    const startedAt = performance.now();
    state = requireAdmitted(
      admitBrowserPipResource(
        state,
        lease(`presentation-${cycle}`, `session-${cycle}`, taskId, cycle),
      ),
    );
    recordHighWater();
    state = releaseBrowserPipResources(state, (candidate) => candidate.taskId === taskId).state;
    lifecycleSamples.push(performance.now() - startedAt);
    if (state.leases.size !== 0) {
      throw new Error(`Task cycle ${cycle} retained ${state.leases.size} presentations`);
    }
  }

  return {
    lifecycle: summarize(lifecycleSamples),
    limits: {
      maximumDecodedBytesPerProcess: BROWSER_PIP_IMAGE_LIMITS.maximumDecodedBytesPerProcess,
      maximumPresentationsPerProcess: BROWSER_PIP_IMAGE_LIMITS.maximumPresentationsPerProcess,
    },
    replacement: summarize(replacementSamples),
    retained: {
      finalDecodedBytes: resourceTotals(state).decodedBytes,
      finalPresentationCount: state.leases.size,
      peakDecodedBytes,
      peakPresentationCount,
    },
  };
}

function pngDataUrl(width = 1, height = 1) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function browserNotification(threadId, browserId, surface) {
  return {
    method: "item/completed",
    params: {
      item: {
        id: `item-${browserId}`,
        result: {
          _meta: {
            "codex/toolSurface": {
              backend: "iab",
              browserId,
              kind: "browserUse",
              ...surface,
            },
          },
        },
        server: "node_repl",
        type: "mcpToolCall",
      },
      threadId,
      turnId: "turn-evidence",
    },
  };
}

function computerUseNotification(threadId) {
  return {
    method: "item/started",
    params: {
      item: { id: "computer-use-evidence", server: "computer-use", type: "mcpToolCall" },
      threadId,
      turnId: "turn-evidence",
    },
  };
}

function occurrence(notification, input = {}) {
  const token = input.occurrenceToken ?? 1;
  return {
    generation: input.generation ?? 1,
    hostId: input.hostId ?? LOCAL_HOST_ID,
    notification,
    occurrenceId: input.occurrenceId ?? `evidence-${token}`,
    occurrenceToken: token,
  };
}

const waitUntil = (predicate, label) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 256; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });

async function withRemoteHostedPipRuntime(root, native, resolveThreadHost, evaluate) {
  const preferences = makeRemoteHostedPipPreferences(path.join(root, "preferences.json"));
  const scope = await Effect.runPromise(Scope.make());
  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        remoteHostedPipTestLayer({
          browserUseStateSignals: Stream.empty,
          legacy: {
            getAlwaysHide: preferences.readAlwaysHide,
            handleBrowserUseStateSnapshot: () => undefined,
            setAlwaysHide: (value) => preferences.writeAlwaysHide(value),
          },
          localHostId: LOCAL_HOST_ID,
          native,
          preferences,
          resolveThreadHost,
        }),
        scope,
      ),
    );
    return await evaluate(Context.get(context, RemoteHostedPipRuntime));
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

function makeNativeEvidencePort() {
  const presentations = new Set();
  let invalidationCount = 0;
  let peakPresentationCount = 0;
  let upsertCount = 0;
  return {
    port: {
      invalidateBrowserPresentation: (presentationId) =>
        Effect.sync(() => {
          invalidationCount += 1;
          presentations.delete(presentationId);
          return true;
        }),
      upsertBrowserPresentation: ({ presentationId }) =>
        Effect.sync(() => {
          upsertCount += 1;
          presentations.add(presentationId);
          peakPresentationCount = Math.max(peakPresentationCount, presentations.size);
          return true;
        }),
    },
    snapshot: () => ({
      finalPresentationCount: presentations.size,
      invalidationCount,
      peakPresentationCount,
      upsertCount,
    }),
  };
}

async function runBackendIsolationEvidence(root) {
  const native = makeNativeEvidencePort();
  return await withRemoteHostedPipRuntime(
    root,
    native.port,
    (threadId) => Effect.succeed(threadId === "acp-bound-thread" ? "acp-host" : LOCAL_HOST_ID),
    async (runtime) => {
      const image = { screenshot: { tabId: "1", url: pngDataUrl() } };
      await Effect.runPromise(
        runtime.observeCodexOccurrence(
          occurrence(browserNotification("local-thread", "local-browser", image)),
        ),
      );
      await Effect.runPromise(
        runtime.observeCodexOccurrence(
          occurrence(browserNotification("remote-thread", "remote-browser", image), {
            hostId: "remote-codex-host",
            occurrenceId: "remote-codex-occurrence",
            occurrenceToken: 2,
          }),
        ),
      );
      await Effect.runPromise(
        runtime.observeCodexOccurrence(
          occurrence(browserNotification("acp-bound-thread", "acp-browser", image), {
            occurrenceId: "acp-bound-occurrence",
            occurrenceToken: 3,
          }),
        ),
      );
      await Effect.runPromise(waitUntil(() => native.snapshot().upsertCount === 1, "local upsert"));
      const snapshot = await Effect.runPromise(runtime.snapshot);
      const nativeSnapshot = native.snapshot();
      if (nativeSnapshot.upsertCount !== 1 || snapshot.activeTaskIds.length !== 1) {
        throw new Error("Backend isolation admitted a remote or non-Codex owner");
      }
      return {
        acceptedLocalCodexOccurrences: nativeSnapshot.upsertCount,
        activeTaskIds: snapshot.activeTaskIds,
        attemptedOccurrences: 3,
        rejectedNonLocalOccurrences: 2,
      };
    },
  );
}

async function runRuntimeProjectionBenchmark(root, replacementCount, taskCycleCount) {
  const native = makeNativeEvidencePort();
  return await withRemoteHostedPipRuntime(
    root,
    native.port,
    () => Effect.succeed(LOCAL_HOST_ID),
    async (runtime) => {
      const replacementSamples = [];
      const lifecycleSamples = [];
      const memorySamples = [];
      let runtimeRetainedPeak = 0;
      const replacementMemoryCheckpoints = new Set(
        [0.1, 0.25, 0.5, 0.75, 1].map((fraction) =>
          Math.max(1, Math.round(replacementCount * fraction)),
        ),
      );
      const lifecycleMemoryCheckpoints = new Set(
        [0.25, 0.5, 0.75, 1].map((fraction) => Math.max(1, Math.round(taskCycleCount * fraction))),
      );

      for (let update = 1; update <= replacementCount; update += 1) {
        const expectedUpserts = native.snapshot().upsertCount + 1;
        const startedAt = performance.now();
        await Effect.runPromise(
          runtime.observeCodexOccurrence(
            occurrence(
              browserNotification("replacement-thread", "replacement-browser", {
                screenshot: { tabId: "current-tab", url: pngDataUrl(1 + (update % 2), 1) },
              }),
              { occurrenceId: `replacement-${update}`, occurrenceToken: update },
            ),
          ),
        );
        await Effect.runPromise(
          waitUntil(
            () => native.snapshot().upsertCount === expectedUpserts,
            `replacement ${update}`,
          ),
        );
        replacementSamples.push(performance.now() - startedAt);
        const snapshot = await Effect.runPromise(runtime.snapshot);
        runtimeRetainedPeak = Math.max(runtimeRetainedPeak, snapshot.retainedPresentationCount);
        if (snapshot.retainedPresentationCount !== 1) {
          throw new Error(
            `Replacement ${update} retained ${snapshot.retainedPresentationCount} presentations`,
          );
        }
        if (replacementMemoryCheckpoints.has(update)) {
          memorySamples.push({
            ...memorySample(`replacement-${update}`),
            activeTaskCount: snapshot.activeTaskIds.length,
            fakeNativePresentationCount: native.snapshot().finalPresentationCount,
            retainedPresentationCount: snapshot.retainedPresentationCount,
          });
        }
      }

      await Effect.runPromise(
        runtime.observeCodexOccurrence(
          occurrence(
            browserNotification("replacement-thread", "replacement-browser", {
              sessionEnded: true,
            }),
            {
              occurrenceId: "replacement-session-ended",
              occurrenceToken: replacementCount + 1,
            },
          ),
        ),
      );
      await Effect.runPromise(
        waitUntil(
          () => native.snapshot().finalPresentationCount === 0,
          "replacement session teardown",
        ),
      );

      for (let cycle = 1; cycle <= taskCycleCount; cycle += 1) {
        const taskId = `lifecycle-thread-${cycle}`;
        const browserId = `lifecycle-browser-${cycle}`;
        const expectedUpserts = native.snapshot().upsertCount + 1;
        const startedAt = performance.now();
        await Effect.runPromise(
          runtime.observeCodexOccurrence(
            occurrence(
              browserNotification(taskId, browserId, {
                screenshot: { tabId: "only-tab", url: pngDataUrl() },
              }),
              { occurrenceId: `lifecycle-${cycle}`, occurrenceToken: cycle },
            ),
          ),
        );
        await Effect.runPromise(
          waitUntil(
            () => native.snapshot().upsertCount === expectedUpserts,
            `task ${cycle} upsert`,
          ),
        );
        await Effect.runPromise(
          runtime.retireCodexThreads({ action: "delete", threadIds: [taskId] }),
        );
        await Effect.runPromise(
          waitUntil(() => native.snapshot().finalPresentationCount === 0, `task ${cycle} teardown`),
        );
        lifecycleSamples.push(performance.now() - startedAt);
        const snapshot = await Effect.runPromise(runtime.snapshot);
        runtimeRetainedPeak = Math.max(runtimeRetainedPeak, snapshot.retainedPresentationCount);
        if (snapshot.retainedPresentationCount !== 0 || snapshot.activeTaskIds.length !== 0) {
          throw new Error(`Task cycle ${cycle} did not return to baseline`);
        }
        if (lifecycleMemoryCheckpoints.has(cycle)) {
          memorySamples.push({
            ...memorySample(`lifecycle-${cycle}`),
            activeTaskCount: snapshot.activeTaskIds.length,
            fakeNativePresentationCount: native.snapshot().finalPresentationCount,
            retainedPresentationCount: snapshot.retainedPresentationCount,
          });
        }
      }

      await Effect.runPromise(
        runtime.observeCodexOccurrence(
          occurrence(computerUseNotification("computer-use-retirement-thread"), {
            occurrenceId: "computer-use-retirement",
            occurrenceToken: 1,
          }),
        ),
      );
      const activeBeforeHostRetirement = (await Effect.runPromise(runtime.snapshot)).activeTaskIds
        .length;
      await Effect.runPromise(runtime.retireLocalCodexHost("connection-lost"));
      const finalSnapshot = await Effect.runPromise(runtime.snapshot);
      const nativeSnapshot = native.snapshot();
      if (
        finalSnapshot.activeTaskIds.length !== 0 ||
        finalSnapshot.retainedPresentationCount !== 0 ||
        nativeSnapshot.finalPresentationCount !== 0
      ) {
        throw new Error("Runtime teardown did not return every state projection to baseline");
      }

      return {
        lifecycle: summarize(lifecycleSamples),
        memorySamples,
        nativeFake: nativeSnapshot,
        replacement: summarize(replacementSamples),
        retained: {
          activeBeforeHostRetirement,
          finalActiveTaskCount: finalSnapshot.activeTaskIds.length,
          finalPresentationCount: finalSnapshot.retainedPresentationCount,
          peakPresentationCount: runtimeRetainedPeak,
        },
      };
    },
  );
}

function fakeWindow(webContentsId) {
  const events = new EventEmitter();
  let destroyed = false;
  const window = {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      events.emit("closed");
    },
    getBounds: () => ({ height: 800, width: 1_200, x: 0, y: 0 }),
    isDestroyed: () => destroyed,
    isFocused: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    webContents: { id: webContentsId },
  };
  return {
    destroyed: () => destroyed,
    listenerCount: () =>
      events.eventNames().reduce((count, name) => count + events.listenerCount(name), 0),
    window,
  };
}

async function runWindowOwnershipEvidence(root) {
  const sessions = new WindowSessionState(path.join(root, "window-runtime"));
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(windowRuntimeFromState(sessions), scope),
  );
  const runtime = Context.get(context, WindowRuntime);
  const primaryWindows = [fakeWindow(101), fakeWindow(102), fakeWindow(103)];
  const avatarWindow = fakeWindow(201);

  for (const primary of primaryWindows) {
    runtime.attach(primary.window, sessions.createFreshSession().id);
  }
  runtime.registerAuxiliary(avatarWindow.window, "avatar-overlay");
  const before = runtime.snapshot();
  const listenerCountBeforeTeardown = [...primaryWindows, avatarWindow].reduce(
    (count, candidate) => count + candidate.listenerCount(),
    0,
  );
  if (runtime.count() !== primaryWindows.length || before.windows.length !== 4) {
    throw new Error("Window ownership evidence did not register the expected windows");
  }

  await Effect.runPromise(Scope.close(scope, Exit.void));
  const after = runtime.snapshot();
  const listenerCountAfterTeardown = [...primaryWindows, avatarWindow].reduce(
    (count, candidate) => count + candidate.listenerCount(),
    0,
  );
  if (
    runtime.count() !== 0 ||
    after.windows.length !== 0 ||
    listenerCountAfterTeardown !== 0 ||
    [...primaryWindows, avatarWindow].some((candidate) => !candidate.destroyed())
  ) {
    throw new Error("Window ownership evidence did not return to its teardown baseline");
  }
  return {
    afterTeardown: {
      auxiliaryWindowCount: 0,
      listenerCount: listenerCountAfterTeardown,
      primaryWindowCount: runtime.count(),
      registryEntryCount: after.windows.length,
    },
    beforeTeardown: {
      auxiliaryWindowCount: before.windows.filter((entry) => entry.kind === "auxiliary").length,
      listenerCount: listenerCountBeforeTeardown,
      primaryWindowCount: primaryWindows.length,
      registryEntryCount: before.windows.length,
    },
  };
}

export async function runStateBenchmark(input = {}) {
  const replacementCount = input.replacementCount ?? DEFAULT_REPLACEMENT_COUNT;
  const taskCycleCount = input.taskCycleCount ?? DEFAULT_TASK_CYCLE_COUNT;
  if (!Number.isSafeInteger(replacementCount) || replacementCount <= 0) {
    throw new Error("replacementCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(taskCycleCount) || taskCycleCount <= 0) {
    throw new Error("taskCycleCount must be a positive safe integer");
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "nodex-remote-hosted-pip-evidence-"));
  const memorySamples = [memorySample("start")];
  try {
    const governor = runResourceGovernorBenchmark(replacementCount, taskCycleCount);
    memorySamples.push(memorySample("after-resource-governor"));
    const backendIsolation = await runBackendIsolationEvidence(path.join(root, "isolation"));
    memorySamples.push(memorySample("after-backend-isolation"));
    const runtimeProjection = await runRuntimeProjectionBenchmark(
      path.join(root, "runtime"),
      replacementCount,
      taskCycleCount,
    );
    memorySamples.push(memorySample("after-runtime-projection"));
    const windowOwnership = await runWindowOwnershipEvidence(path.join(root, "windows"));
    memorySamples.push(memorySample("after-window-ownership-teardown"));
    const firstMemory = memorySamples[0];
    const lastMemory = memorySamples.at(-1);

    return {
      benchmarks: {
        resourceGovernor: governor,
        runtimeProjection,
      },
      environment: {
        arch: process.arch,
        node: process.version,
        platform: process.platform,
        release: os.release(),
      },
      evidence: {
        doesNotProve: [
          "signed native addon ABI or native service behavior",
          "real Browser, Chrome extension, or Computer Use frame-copy latency",
          "NSPanel placement, motion, click routing, reconnect, or native RSS parity",
        ],
        grade: "state-only",
        productionBrowserTouched: false,
        productionWindowTouched: false,
        proves: [
          "Main runtime rejects remote-host and non-local backend ownership",
          "replacement and task lifecycle state remains bounded with fake native projection",
          "primary and avatar auxiliary window registry ownership tears down to baseline",
        ],
        requiredExternalGates: [
          "signed dual-architecture packaged app and helper with the exact runtime manifest",
          "real Chrome extension and native-messaging connection in a disposable browser profile",
          "real IAB and Computer Use flows against an explicitly owned test application",
          "native NSPanel motion, click, reconnect, and same-machine RSS comparison",
        ],
        signedNative: false,
      },
      isolation: backendIsolation,
      memory: {
        heapUsedDeltaBytes: lastMemory.heapUsedBytes - firstMemory.heapUsedBytes,
        peakRssBytes: Math.max(...memorySamples.map((sample) => sample.rssBytes)),
        rssDeltaBytes: lastMemory.rssBytes - firstMemory.rssBytes,
        samples: memorySamples,
      },
      replacementCount,
      schemaVersion: 1,
      status: "passed",
      taskCycleCount,
      timestamp: new Date().toISOString(),
      windowOwnership,
    };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export function resolveOutputPath(argv = process.argv.slice(2), now = new Date()) {
  const requested = argv.find((argument) => argument.startsWith("--out="));
  if (requested) return path.resolve(requested.slice("--out=".length));
  const timestamp = now.toISOString().replaceAll(/[:.]/gu, "-");
  const evidenceKind = argv.includes("--real-runtime") ? "real-runtime" : "state-evidence";
  return path.resolve(
    "runs.local",
    "remote-hosted-pip",
    `${timestamp}-${evidenceKind}-benchmark.json`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const report = argv.includes("--real-runtime")
    ? await import("./benchmark-remote-hosted-pip-real-runtime.mjs").then(
        ({ parseRealRuntimeOptions, runRealRuntimeBenchmark }) =>
          runRealRuntimeBenchmark(parseRealRuntimeOptions(argv)),
      )
    : await runStateBenchmark();
  const destination = resolveOutputPath(argv);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const output = argv.includes("--real-runtime")
    ? {
        destination,
        memory: report.memory?.summaryByRole ?? null,
        reason: report.reason ?? null,
        status: report.status,
        teardown: report.teardown ?? null,
        workloads: report.workloads ?? null,
      }
    : { destination, report };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) await main();
