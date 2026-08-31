import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import { performance } from "node:perf_hooks";

import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ScopedCallbackRuntime,
  layer as scopedCallbackRuntimeLive,
} from "../app/ScopedCallbackRuntime";
import { resolveCodexRuntime } from "../codex/codex-runtime";
import { openCodexProbeSession } from "../../../scripts/codex-probe-session";
import type {
  CodexSelectedSubagentHydrateResult,
  CodexSubagentOverviewWindow,
} from "../../shared/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexConversations } from "../codex-application/CodexConversations";
import {
  CodexThreadDirectory,
  type CodexThreadDirectoryEntry,
} from "../codex-application/CodexThreadDirectory";
import {
  CodexSubagentDirectoryError,
  make as makeCodexSubagentDirectory,
  type CodexSubagentNotificationObservation,
} from "../codex-application/CodexSubagentDirectory";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { connectOrStartCore, type CoreLaunchResult } from "./core-launcher";

const DESCENDANT_COUNTS = [10, 100, 1_000] as const;
const REAL_HISTORY_ITEM_COUNTS = [0, 100, 10_000] as const;
const REAL_HISTORY_ITEM_TEXT_BYTES = 4_096;
const REAL_HISTORY_INJECTION_BATCH_SIZE = 500;
const SAMPLE_COUNT = 15;
const WARMUP_COUNT = 3;
const STATUS_SAMPLE_COUNT = 15;
const HOT_OVERVIEW_P95_GATE_MS = 250;
const REAL_HISTORY_LIST_P95_GATE_MS = 250;
const REAL_HISTORY_RSS_NOISE_FLOOR_BYTES = 4 * 1024 * 1024;
const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const CORE_EXECUTABLE = path.resolve("target/release/nodex-core");
const EVIDENCE_PATH = path.resolve(
  "notes.local/artifacts/subagent-parity/subagent-performance-scale.json",
);
const HOST_ID = "subagent-scale-host";
const HOST_GENERATION = 1;
const SOURCE_EPOCH = "subagent-scale-host:codex-app-server/0.152.0";
const TRANSCRIPT_METHODS = new Set(["thread/resume", "thread/turns/list", "thread/items/list"]);

interface TimingSummary {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

interface GatewayMeasurement {
  currentConcurrency: number;
  maxConcurrency: number;
  metadataRequestBytes: number;
  metadataResponseBytes: number;
  requestCount: number;
  transcriptRequestBytes: number;
  transcriptResponseBytes: number;
  transcriptRpcCount: number;
}

interface DirectoryMeasurement {
  childSubscriptionDependencyReads: number;
  readonly conversationsReadThreadIds: string[];
  readonly gateway: GatewayMeasurement;
  readonly resolveCalls: Array<{ readonly fidelity: string; readonly threadId: string }>;
}

interface DirectoryHarness {
  readonly close: () => Effect.Effect<void>;
  readonly measurement: DirectoryMeasurement;
  readonly service: import("../codex-application/CodexSubagentDirectory").CodexSubagentDirectory["Service"];
}

interface RealPersistedHistoryMeasurement {
  readonly historyItemCount: number;
  readonly historyMarkerCount: number;
  readonly persistedHistoryBytes: number;
  readonly metadataListBytes: number;
  readonly metadataListLatency: TimingSummary;
  readonly rssBeforeMetadataBytes: number;
  readonly rssAfterMetadataBytes: number;
  readonly rssGrowthBytes: number;
  readonly rssGrowthGateBytes: number;
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const percentile = (samples: readonly number[], ratio: number): number => {
  if (samples.length === 0) throw new Error("Cannot summarize an empty sample set");
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]!;
};

const summarize = (samples: readonly number[]): TimingSummary => ({
  count: samples.length,
  minMs: round(Math.min(...samples)),
  p50Ms: round(percentile(samples, 0.5)),
  p95Ms: round(percentile(samples, 0.95)),
  maxMs: round(Math.max(...samples)),
});

const measured = <Value, Error, Requirements>(
  operation: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<{ readonly elapsedMs: number; readonly value: Value }, Error, Requirements> =>
  Effect.gen(function* () {
    const startedAt = performance.now();
    const value = yield* operation;
    return { elapsedMs: performance.now() - startedAt, value };
  });

const tryRemoveTemporaryProfile = (resolvedProfile: string): boolean => {
  try {
    rmSync(resolvedProfile, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EBUSY") return false;
    throw error;
  }
};

const removeTemporaryProfile = Effect.fn("SubagentScale.removeTemporaryProfile")(function* (
  profileRoot: string,
) {
  const resolvedProfile = path.resolve(profileRoot);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (
    !resolvedProfile.startsWith(temporaryRoot) ||
    !path.basename(resolvedProfile).startsWith("nodex-subagent-scale-")
  ) {
    return yield* Effect.die(
      new Error("Subagent scale cleanup accepts only its disposable Profile root"),
    );
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const removed = yield* Effect.sync(() => tryRemoveTemporaryProfile(resolvedProfile));
    if (removed) return;
    yield* Effect.sleep("25 millis");
  }
  rmSync(resolvedProfile, { recursive: true, force: true });
});

const projectHotOverview = (
  overview: CodexSubagentOverviewWindow,
): { readonly projectionBytes: number; readonly publishedRows: number } => ({
  projectionBytes: Buffer.byteLength(JSON.stringify(overview)),
  publishedRows: overview.active.rows.length + overview.done.rows.length,
});

const capability: CodexAppServerCapabilitySnapshot = {
  hostId: HOST_ID,
  generation: HOST_GENERATION,
  sourceEpoch: SOURCE_EPOCH,
  userAgent: "codex-app-server/0.152.0",
  version: "0.152.0",
  flags: {
    ephemeralFork: true,
    forkLastTurnId: true,
    multiAgentV2Protocol: true,
    paginatedHistory: true,
    searchOccurrences: true,
    sideConversation: true,
    subagentAncestorFilter: true,
    threadRevert: true,
  },
};

const makeThread = (
  rootThreadId: string,
  index: number,
  status: "active" | "idle" = index % 2 === 0 ? "active" : "idle",
): Thread => {
  const threadId = `${rootThreadId}-child-${index.toString().padStart(4, "0")}`;
  const createdAt = 1_800_000_000 + index;
  return {
    id: threadId,
    extra: null,
    sessionId: `session-${threadId}`,
    forkedFromId: null,
    parentThreadId: rootThreadId,
    preview: `Metadata-only objective ${index}`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt,
    updatedAt: createdAt,
    recencyAt: createdAt,
    status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
    path: null,
    cwd: "/subagent-scale",
    cliVersion: "0.152.0",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: rootThreadId,
          depth: 1,
          agent_path: `${rootThreadId}/Scale-${index}`,
          agent_nickname: `Scale-${index}`,
          agent_role: "explorer",
        },
      },
    },
    canAcceptDirectInput: status === "active",
    threadSource: "subAgentThreadSpawn",
    agentNickname: `Scale-${index}`,
    agentRole: "explorer",
    gitInfo: null,
    name: `Scale-${index}`,
    turns: [],
  } as Thread;
};

const makeDirectoryEntry = (
  thread: Thread,
  rootThreadId: string,
  fidelity: "durable" | "tail" = "durable",
): CodexThreadDirectoryEntry =>
  ({
    fidelity,
    historyMode: "paginated",
    durable: {
      threadId: thread.id,
      projectId: "project:subagent-scale",
      sessionId: thread.sessionId,
      forkedFromId: null,
      parentThreadId: thread.id === rootThreadId ? null : rootThreadId,
      threadSource: thread.id === rootThreadId ? "user" : "subAgentThreadSpawn",
      serviceName: null,
      agentNickname: thread.agentNickname ?? null,
      agentRole: thread.agentRole ?? null,
      agentPath:
        thread.id === rootThreadId ? null : `${rootThreadId}/${thread.agentNickname ?? thread.id}`,
      threadName: thread.name ?? thread.id,
      threadPreview: thread.preview ?? "",
      executionProfile: {
        modelId: "gpt-scale",
        reasoningEffort: "high",
        serviceTier: null,
      },
      backendBinding: { kind: "codex" },
      executionHostId: HOST_ID,
      cwd: "/subagent-scale",
      writableRoots: ["/subagent-scale"],
      managedWorktreePath: null,
      projectlessOutputDirectory: null,
      projectlessWorkspaceBrowserRoot: null,
      statusType: thread.status.type,
      statusActiveFlags: thread.status.type === "active" ? thread.status.activeFlags : [],
      archived: false,
      pinnedOrder: null,
      hasUnreadTurn: false,
      createdAt: thread.createdAt * 1_000,
      updatedAt: thread.updatedAt * 1_000,
      recencyAt: (thread.recencyAt ?? thread.updatedAt) * 1_000,
      linkedAt: "2026-09-01T00:00:00.000Z",
    },
    summary: { archived: false },
    canonical: null,
    snapshot:
      fidelity === "tail"
        ? {
            conversationEntityGeneration: 1,
            historyTopologyGeneration: 1,
            historyMutationRevision: 1,
            turns: [{ id: `turn-${thread.id}`, items: [] }],
            turnPagination: {
              hasLoadedOldest: false,
              itemsView: "full",
              loadedTurnCount: 1,
            },
          }
        : null,
  }) as unknown as CodexThreadDirectoryEntry;

const rootThread = (rootThreadId: string): Thread =>
  ({
    ...makeThread(rootThreadId, 0, "active"),
    id: rootThreadId,
    sessionId: `session-${rootThreadId}`,
    parentThreadId: null,
    source: { kind: "appServer" },
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    name: `Scale root ${rootThreadId}`,
  }) as unknown as Thread;

const emptyGatewayMeasurement = (): GatewayMeasurement => ({
  currentConcurrency: 0,
  maxConcurrency: 0,
  metadataRequestBytes: 0,
  metadataResponseBytes: 0,
  requestCount: 0,
  transcriptRequestBytes: 0,
  transcriptResponseBytes: 0,
  transcriptRpcCount: 0,
});

const makeDirectoryHarness = Effect.fn("SubagentScale.makeDirectoryHarness")(function* (input: {
  readonly core: CoreLaunchResult["client"];
  readonly entries: Map<string, CodexThreadDirectoryEntry>;
  readonly rootThreadId: string;
  readonly threads: Thread[];
}): Effect.fn.Return<DirectoryHarness> {
  const measurement: DirectoryMeasurement = {
    childSubscriptionDependencyReads: 0,
    conversationsReadThreadIds: [],
    gateway: emptyGatewayMeasurement(),
    resolveCalls: [],
  };
  const scope = yield* Scope.make();
  const unsupported = () => Effect.die(new Error("Unexpected Codex Gateway operation"));
  const requestOnHost = ((hostId: string, method: string, params: Record<string, unknown>) =>
    Effect.suspend(() => {
      const requestBytes = Buffer.byteLength(JSON.stringify({ hostId, method, params }));
      const isTranscript =
        TRANSCRIPT_METHODS.has(method) ||
        (method === "thread/read" && params.includeTurns === true);
      measurement.gateway.currentConcurrency += 1;
      measurement.gateway.maxConcurrency = Math.max(
        measurement.gateway.maxConcurrency,
        measurement.gateway.currentConcurrency,
      );
      measurement.gateway.requestCount += 1;
      if (isTranscript) {
        measurement.gateway.transcriptRpcCount += 1;
        measurement.gateway.transcriptRequestBytes += requestBytes;
      } else {
        measurement.gateway.metadataRequestBytes += requestBytes;
      }

      return Effect.sleep("1 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            let response: unknown;
            if (method === "thread/list") {
              const cursor = typeof params.cursor === "string" ? Number(params.cursor) : 0;
              const limit = typeof params.limit === "number" ? params.limit : 200;
              const data = input.threads.slice(cursor, cursor + limit);
              const next = cursor + data.length;
              response = {
                data,
                nextCursor: next < input.threads.length ? String(next) : null,
                backwardsCursor: null,
              };
            } else if (method === "thread/read") {
              const threadId = String(params.threadId ?? "");
              response = { thread: input.threads.find((thread) => thread.id === threadId) ?? null };
            } else if (method === "thread/turns/list" || method === "thread/items/list") {
              response = { data: [], nextCursor: null, backwardsCursor: null };
            } else {
              throw new Error(`Unexpected Codex Gateway request: ${method}`);
            }
            const responseBytes = Buffer.byteLength(JSON.stringify(response));
            if (isTranscript) measurement.gateway.transcriptResponseBytes += responseBytes;
            else measurement.gateway.metadataResponseBytes += responseBytes;
            return response;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            measurement.gateway.currentConcurrency -= 1;
          }),
        ),
      );
    })) as CodexGateway["Service"]["requestOnHost"];

  const workspace: CoreModuleClients["workspace"] = {
    read: (read, options) =>
      Effect.promise(() => input.core.workspaceRead(read, options)) as ReturnType<
        CoreModuleClients["workspace"]["read"]
      >,
    apply: (apply, options) =>
      Effect.promise(() => input.core.workspaceApply(apply, options)) as ReturnType<
        CoreModuleClients["workspace"]["apply"]
      >,
  };

  const service = yield* makeCodexSubagentDirectory.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
    ),
    Effect.provideService(CoreModules, CoreModules.of({ workspace } as CoreModuleClients)),
    Effect.provideService(
      CodexConversations,
      CodexConversations.of(
        new Proxy(
          {
            read: (threadId: string) => {
              measurement.conversationsReadThreadIds.push(threadId);
              return null;
            },
          },
          {
            get: (target, property, receiver) => {
              if (
                typeof property === "string" &&
                /subscribe|observe|watch|events/iu.test(property)
              ) {
                measurement.childSubscriptionDependencyReads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as CodexConversations["Service"],
      ),
    ),
    Effect.provideService(
      CodexGateway,
      CodexGateway.of({
        localHostId: HOST_ID,
        events: Stream.empty,
        requestOnHost,
        requestForThread: unsupported,
        requestRawOnHost: unsupported,
        requestRawForThread: unsupported,
        requestLocal: unsupported,
        notifyLocal: unsupported,
        connection: unsupported,
        connectionChanges: () => Stream.empty,
        awaitReady: () => Effect.void,
        reconcileHost: unsupported,
        removeHost: unsupported,
        restartHost: unsupported,
      } as unknown as CodexGateway["Service"]),
    ),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.succeed(true),
      }),
    ),
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        resolve: ({
          fidelity,
          threadId,
        }: Parameters<CodexThreadDirectory["Service"]["resolve"]>[0]) => {
          measurement.resolveCalls.push({ fidelity, threadId });
          const entry = input.entries.get(threadId) ?? null;
          if (!entry || fidelity !== "tail") return Effect.succeed(entry);
          const thread =
            input.threads.find((candidate) => candidate.id === threadId) ??
            (threadId === input.rootThreadId ? rootThread(input.rootThreadId) : null);
          return Effect.succeed(
            thread ? makeDirectoryEntry(thread, input.rootThreadId, "tail") : entry,
          );
        },
      } as unknown as CodexThreadDirectory["Service"]),
    ),
    Effect.provideService(Scope.Scope, scope),
  );

  return {
    close: () => Scope.close(scope, Exit.void),
    measurement,
    service,
  };
});

const resetMeasurement = (measurement: DirectoryMeasurement): void => {
  measurement.childSubscriptionDependencyReads = 0;
  measurement.conversationsReadThreadIds.length = 0;
  measurement.resolveCalls.length = 0;
  Object.assign(measurement.gateway, emptyGatewayMeasurement());
};

const seedRoot = (core: CoreLaunchResult["client"], rootThreadId: string): Effect.Effect<void> =>
  Effect.promise(() =>
    core.workspaceApply({
      operationId: `subagent-scale-root-${rootThreadId}`,
      intent: {
        kind: "upsert_thread",
        thread_id: rootThreadId,
        patch: {
          project_id: "project:subagent-scale",
          thread_name: `Scale root ${rootThreadId}`,
          thread_source: "appServer",
          thread_preview: "Scale root",
          backend_binding: { kind: "codex" },
          model_id: "gpt-scale",
          execution_host_id: HOST_ID,
          cwd: "/subagent-scale",
          status: { status_type: "active", active_flags: [] },
          created_at: 1_800_000_000_000,
          updated_at: 1_800_000_000_000,
          recency_at: 1_800_000_000_000,
          linked_at: "2026-09-01T00:00:00.000Z",
        },
      },
    }),
  ).pipe(Effect.asVoid);

const seedProject = (core: CoreLaunchResult["client"], profileRoot: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sourceRoot = path.join(profileRoot, "source");
    yield* Effect.sync(() => mkdirSync(sourceRoot, { recursive: true }));
    yield* Effect.promise(() =>
      core.workspaceApply({
        operationId: "subagent-scale-create-project",
        intent: {
          kind: "create_initial_project",
          project_id: "project:subagent-scale",
          name: "Subagent scale evidence",
          description: "Disposable Milestone 9 projection fixture",
          appearance: null,
          source_roots: [sourceRoot],
          starter_page: {
            page_id: "page:subagent-scale",
            document_id: "document:subagent-scale",
            title_markdown: "Subagent scale evidence",
            nfm: "Disposable scale evidence.",
          },
        },
      }),
    );
  });

const observe = (
  harness: DirectoryHarness,
  observation: CodexSubagentNotificationObservation,
): Effect.Effect<void, CodexSubagentDirectoryError> =>
  harness.service.observeNotification(observation);

const readOverview = (
  harness: DirectoryHarness,
  rootThreadId: string,
  mode: "expanded" | "initial" = "initial",
): Effect.Effect<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> =>
  harness.service.readOverview({ mode, rootThreadId });

const readKnownOverview = (
  harness: DirectoryHarness,
  rootThreadId: string,
): Effect.Effect<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> =>
  harness.service.readKnownOverview({ rootThreadId });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listJsonlFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
    }
  }
  return files;
};

const residentSetBytes = (pid: number): number => {
  const kibibytes = Number.parseInt(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
    10,
  );
  if (!Number.isSafeInteger(kibibytes) || kibibytes <= 0) {
    throw new Error(`Agent runtime RSS measurement is invalid for pid ${pid}`);
  }
  return kibibytes * 1_024;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const measureRealPersistedHistory = async (input: {
  readonly callbacks: ScopedCallbackRuntime["Service"];
  readonly historyItemCount: (typeof REAL_HISTORY_ITEM_COUNTS)[number];
  readonly runtime: ReturnType<typeof resolveCodexRuntime>;
}): Promise<RealPersistedHistoryMeasurement> => {
  const profileRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-subagent-real-history-"));
  const stateHome = path.join(profileRoot, "home");
  const cwd = path.join(profileRoot, "workspace");
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const marker = `NODEX_REAL_SUBAGENT_HISTORY_${input.historyItemCount}_`;
  const options = {
    additionalSearchPaths: input.runtime.additionalSearchPaths,
    binaryPath: input.runtime.binaryPath,
    expectedCodexHome: stateHome,
    requestTimeout: "180 seconds",
    env: {
      ...process.env,
      CODEX_HOME: stateHome,
    },
    clientInfo: {
      name: "nodex-subagent-real-history-performance",
      title: "Nodex Subagent Real History Performance",
      version: "1.0.0",
    },
  } as const;

  try {
    const writer = await input.callbacks.runPromise(
      openCodexProbeSession(input.callbacks, options),
    );
    let threadId = "";
    try {
      const started = await writer.request("thread/start", {
        ephemeral: false,
        historyMode: "paginated",
        threadSource: "appServer",
        cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          "features.plugins": false,
          "features.code_mode": false,
          "features.code_mode_only": false,
        },
      });
      const thread = isRecord(started) && isRecord(started.thread) ? started.thread : null;
      if (!thread || typeof thread.id !== "string") {
        throw new Error("Real-history probe received an invalid thread/start response");
      }
      threadId = thread.id;
      // This production metadata mutation creates the state-store row before the first Turn.
      await writer.request("thread/section/move", {
        threadId,
        sectionId: PINNED_THREAD_SECTION_ID,
        beforeThreadId: null,
      });
      // Keep one identical seed item in every profile so a real rollout and state-db row exist;
      // the measured 0/100/10,000-item variable remains isolated from this constant setup cost.
      await writer.request("thread/inject_items", {
        threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Nodex real-history scale seed" }],
          },
        ],
      });
      // A newly started, turn-less Thread is not guaranteed to have reached the metadata index
      // before its process exits. A real metadata mutation establishes the durable index without
      // adding transcript items, so the reader can exercise the production state-db-only path.
      await writer.request("thread/name/set", {
        threadId,
        name: `Real history ${input.historyItemCount}`,
      });
      for (
        let offset = 0;
        offset < input.historyItemCount;
        offset += REAL_HISTORY_INJECTION_BATCH_SIZE
      ) {
        const size = Math.min(REAL_HISTORY_INJECTION_BATCH_SIZE, input.historyItemCount - offset);
        const items = Array.from({ length: size }, (_, batchIndex) => ({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${marker}${offset + batchIndex}:${"x".repeat(REAL_HISTORY_ITEM_TEXT_BYTES)}`,
            },
          ],
        }));
        await writer.request("thread/inject_items", { threadId, items });
      }
    } finally {
      await writer.stop();
    }

    const rolloutFiles = listJsonlFiles(stateHome);
    const persistedHistoryBytes = rolloutFiles.reduce(
      (total, file) => total + statSync(file).size,
      0,
    );
    const historyMarkerCount = rolloutFiles.reduce((total, file) => {
      const content = readFileSync(file, "utf8");
      return total + content.split(marker).length - 1;
    }, 0);
    assert.strictEqual(historyMarkerCount, input.historyItemCount);

    // Injected side-history intentionally does not make a Thread visible in general listings.
    // This pressure fixture is explicitly about storage shape, so seed only the visibility
    // metadata after the authoritative app-server writer closes; history remains untouched.
    const stateDatabases = readdirSync(stateHome)
      .filter((entry) => /^state_\d+\.sqlite$/.test(entry))
      .map((entry) => path.join(stateHome, entry));
    if (stateDatabases.length !== 1) {
      throw new Error(`Expected one app-server state database, found ${stateDatabases.length}`);
    }
    execFileSync("sqlite3", [
      stateDatabases[0]!,
      `UPDATE threads SET preview = 'Nodex real-history scale fixture', has_user_event = 1 WHERE id = '${threadId}';`,
    ]);

    // Resume metadata-only in a separate process to establish the state index from the closed
    // rollout. The measured reader below is a third process restricted to state-db-only metadata.
    const indexer = await input.callbacks.runPromise(
      openCodexProbeSession(input.callbacks, options),
    );
    try {
      const resumed = await indexer.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      if (JSON.stringify(resumed).includes(marker)) {
        throw new Error("Metadata-only resume leaked persisted history");
      }
      await indexer.request("thread/name/set", {
        threadId,
        name: `Indexed real history ${input.historyItemCount}`,
      });
      const response = await indexer.request("thread/list", {
        archived: false,
        limit: 10,
        modelProviders: [],
        sortDirection: "desc",
        sortKey: "created_at",
        sourceKinds: ["vscode"],
        useStateDbOnly: true,
      });
      const data = isRecord(response) && Array.isArray(response.data) ? response.data : null;
      if (!data?.some((candidate) => isRecord(candidate) && candidate.id === threadId)) {
        throw new Error("Real-history metadata resume did not index its Thread");
      }
    } finally {
      await indexer.stop();
    }

    if (typeof globalThis.gc === "function") globalThis.gc();
    const reader = await input.callbacks.runPromise(
      openCodexProbeSession(input.callbacks, options),
    );
    try {
      await delay(100);
      const rssBeforeMetadataBytes = residentSetBytes(reader.pid);
      const latencySamples: number[] = [];
      let metadataListBytes = 0;
      for (let sampleIndex = 0; sampleIndex < WARMUP_COUNT + SAMPLE_COUNT; sampleIndex += 1) {
        const startedAt = performance.now();
        const response = await reader.request("thread/list", {
          archived: false,
          limit: 10,
          modelProviders: [],
          sortDirection: "desc",
          sortKey: "created_at",
          sourceKinds: ["vscode"],
          useStateDbOnly: true,
        });
        const elapsedMs = performance.now() - startedAt;
        const data = isRecord(response) && Array.isArray(response.data) ? response.data : null;
        if (!data) throw new Error("Real-history probe received an invalid thread/list response");
        const listed = data.find((candidate) => isRecord(candidate) && candidate.id === threadId);
        if (!isRecord(listed)) throw new Error("Real-history probe did not list its Thread");
        if (!Array.isArray(listed.turns) || listed.turns.length !== 0) {
          throw new Error("Metadata-only list returned inline history");
        }
        const encoded = JSON.stringify(response);
        if (encoded.includes(marker))
          throw new Error("Metadata-only list leaked persisted history");
        metadataListBytes = Buffer.byteLength(encoded);
        if (sampleIndex >= WARMUP_COUNT) latencySamples.push(elapsedMs);
      }
      await delay(100);
      const rssAfterMetadataBytes = residentSetBytes(reader.pid);
      const rssGrowthBytes = Math.max(0, rssAfterMetadataBytes - rssBeforeMetadataBytes);
      const rssGrowthGateBytes = Math.max(
        REAL_HISTORY_RSS_NOISE_FLOOR_BYTES,
        Math.floor(persistedHistoryBytes * 0.1),
      );
      const metadataListLatency = summarize(latencySamples);
      assert.isAtMost(metadataListLatency.p95Ms, REAL_HISTORY_LIST_P95_GATE_MS);
      assert.isAtMost(metadataListBytes, 64 * 1024);
      assert.isAtMost(rssGrowthBytes, rssGrowthGateBytes);
      return {
        historyItemCount: input.historyItemCount,
        historyMarkerCount,
        persistedHistoryBytes,
        metadataListBytes,
        metadataListLatency,
        rssBeforeMetadataBytes,
        rssAfterMetadataBytes,
        rssGrowthBytes,
        rssGrowthGateBytes,
      };
    } finally {
      await reader.stop();
    }
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
};

it.live(
  "measures real Core/Main scale seams and emits layered renderer evidence",
  () =>
    Effect.gen(function* () {
      assert.isTrue(existsSync(CORE_EXECUTABLE), "build the release Core before running the gate");
      const callbacks = yield* ScopedCallbackRuntime;
      const stagedRuntime = yield* Effect.sync(() =>
        resolveCodexRuntime({ isPackaged: false, projectRootPath: path.resolve(".") }),
      );

      const profileRoot = yield* Effect.sync(() =>
        mkdtempSync(path.join(os.tmpdir(), "nodex-subagent-scale-")),
      );
      const runtime = yield* Effect.acquireRelease(
        Effect.promise(() =>
          connectOrStartCore({
            buildId: "subagent-milestone-9-scale-evidence",
            environment: {
              NODEX_CORE_EXECUTABLE: CORE_EXECUTABLE,
              NODEX_LOG_FILE: "true",
            },
            isPackaged: false,
            nodexHome: profileRoot,
            requestTimeoutMs: 60_000,
          }),
        ),
        (ownedRuntime) =>
          Effect.promise(async () => {
            await ownedRuntime.client.shutdown().catch(() => undefined);
          }).pipe(
            Effect.andThen(Effect.sleep("100 millis")),
            Effect.andThen(removeTemporaryProfile(profileRoot)),
          ),
      );
      yield* seedProject(runtime.client, profileRoot);

      const fixtures = new Map<
        number,
        {
          readonly entries: Map<string, CodexThreadDirectoryEntry>;
          readonly rootThreadId: string;
          readonly threads: Thread[];
        }
      >();
      const discoveryEvidence: unknown[] = [];

      for (const descendantCount of DESCENDANT_COUNTS) {
        const rootThreadId = `subagent-scale-root-${descendantCount}`;
        const threads = Array.from({ length: descendantCount }, (_, index) =>
          makeThread(rootThreadId, index),
        );
        const entries = new Map<string, CodexThreadDirectoryEntry>([
          [rootThreadId, makeDirectoryEntry(rootThread(rootThreadId), rootThreadId)],
          ...threads.map(
            (thread) => [thread.id, makeDirectoryEntry(thread, rootThreadId)] as const,
          ),
        ]);
        fixtures.set(descendantCount, { entries, rootThreadId, threads });
        yield* seedRoot(runtime.client, rootThreadId);

        const harness = yield* makeDirectoryHarness({
          core: runtime.client,
          entries,
          rootThreadId,
          threads,
        });
        try {
          const cold = yield* measured(readOverview(harness, rootThreadId, "expanded"));
          assert.strictEqual(cold.value.completeness, "complete");
          assert.strictEqual(
            cold.value.active.knownCount + cold.value.done.knownCount,
            descendantCount,
          );
          assert.strictEqual(harness.measurement.gateway.transcriptRpcCount, 0);
          assert.strictEqual(harness.measurement.gateway.transcriptRequestBytes, 0);
          assert.strictEqual(harness.measurement.gateway.transcriptResponseBytes, 0);
          assert.isAtMost(harness.measurement.gateway.maxConcurrency, 2);
          discoveryEvidence.push({
            descendantCount,
            elapsedMs: round(cold.elapsedMs),
            metadataPhysicalConcurrencyMax: harness.measurement.gateway.maxConcurrency,
            metadataRequestBytes: harness.measurement.gateway.metadataRequestBytes,
            metadataResponseBytes: harness.measurement.gateway.metadataResponseBytes,
            metadataRpcCount: harness.measurement.gateway.requestCount,
            transcriptBytes: 0,
            transcriptRpcCount: 0,
          });
        } finally {
          yield* harness.close();
        }
      }

      const matrixEvidence: unknown[] = [];
      const mainHotProjectionEvidence: unknown[] = [];
      for (const descendantCount of DESCENDANT_COUNTS) {
        const fixture = fixtures.get(descendantCount)!;
        const harness = yield* makeDirectoryHarness({
          core: runtime.client,
          ...fixture,
        });
        try {
          for (let index = 0; index < WARMUP_COUNT; index += 1) {
            const overview = yield* readOverview(harness, fixture.rootThreadId);
            projectHotOverview(overview);
          }
          resetMeasurement(harness.measurement);
          const latencySamples: number[] = [];
          let lastOverview: CodexSubagentOverviewWindow | null = null;
          let lastProjection: ReturnType<typeof projectHotOverview> | null = null;
          for (let index = 0; index < SAMPLE_COUNT; index += 1) {
            const sample = yield* measured(
              Effect.gen(function* () {
                const overview = yield* readOverview(harness, fixture.rootThreadId);
                const projection = projectHotOverview(overview);
                return { overview, projection };
              }),
            );
            latencySamples.push(sample.elapsedMs);
            lastOverview = sample.value.overview;
            lastProjection = sample.value.projection;
          }
          assert.isNotNull(lastOverview);
          assert.isNotNull(lastProjection);
          assert.isAtMost(lastOverview!.active.rows.length, 4);
          assert.isAtMost(lastOverview!.done.rows.length, 10);
          assert.isAtMost(lastProjection!.publishedRows, 14);
          assert.strictEqual(harness.measurement.gateway.transcriptRpcCount, 0);
          assert.strictEqual(harness.measurement.gateway.transcriptRequestBytes, 0);
          assert.strictEqual(harness.measurement.gateway.transcriptResponseBytes, 0);
          assert.strictEqual(harness.measurement.gateway.requestCount, 0);
          assert.strictEqual(harness.measurement.childSubscriptionDependencyReads, 0);
          assert.deepEqual(harness.measurement.conversationsReadThreadIds, []);

          const latency = summarize(latencySamples);
          assert.isAtMost(latency.p95Ms, HOT_OVERVIEW_P95_GATE_MS);
          matrixEvidence.push({
            descendantCount,
            latency,
            steadyOverview: {
              childConversationReads: harness.measurement.conversationsReadThreadIds.length,
              childSubscriptionDependencyReads:
                harness.measurement.childSubscriptionDependencyReads,
              childTranscriptBytes: 0,
              childTranscriptRpcCount: 0,
              metadataPhysicalRpcCount: harness.measurement.gateway.requestCount,
            },
          });
          mainHotProjectionEvidence.push({
            descendantCount,
            activeRows: lastOverview!.active.rows.length,
            doneRows: lastOverview!.done.rows.length,
            mainProjectionBytes: lastProjection!.projectionBytes,
            publishedHotRows: lastProjection!.publishedRows,
          });
        } finally {
          yield* harness.close();
        }
      }

      const realPersistedHistory: RealPersistedHistoryMeasurement[] = [];
      for (const historyItemCount of REAL_HISTORY_ITEM_COUNTS) {
        realPersistedHistory.push(
          yield* Effect.tryPromise(() =>
            measureRealPersistedHistory({ callbacks, historyItemCount, runtime: stagedRuntime }),
          ),
        );
      }
      const zeroHistory = realPersistedHistory.find(
        ({ historyItemCount }) => historyItemCount === 0,
      );
      const tenThousandHistory = realPersistedHistory.find(
        ({ historyItemCount }) => historyItemCount === 10_000,
      );
      assert.isDefined(zeroHistory);
      assert.isDefined(tenThousandHistory);
      assert.isAbove(tenThousandHistory!.persistedHistoryBytes, 32 * 1024 * 1024);
      assert.isAtMost(
        tenThousandHistory!.metadataListBytes,
        zeroHistory!.metadataListBytes + 4 * 1024,
      );
      const crossProfileRssGateBytes = Math.max(
        REAL_HISTORY_RSS_NOISE_FLOOR_BYTES,
        Math.floor(tenThousandHistory!.persistedHistoryBytes * 0.1),
      );
      const startupRssDeltaBytes = Math.max(
        0,
        tenThousandHistory!.rssBeforeMetadataBytes - zeroHistory!.rssBeforeMetadataBytes,
      );
      const retainedRssDeltaBytes = Math.max(
        0,
        tenThousandHistory!.rssAfterMetadataBytes - zeroHistory!.rssAfterMetadataBytes,
      );
      assert.isAtMost(startupRssDeltaBytes, crossProfileRssGateBytes);
      assert.isAtMost(retainedRssDeltaBytes, crossProfileRssGateBytes);

      const thousandFixture = fixtures.get(1_000)!;
      const selectedHarness = yield* makeDirectoryHarness({
        core: runtime.client,
        ...thousandFixture,
      });
      let selectedResult: CodexSelectedSubagentHydrateResult;
      try {
        resetMeasurement(selectedHarness.measurement);
        const selectedThreadId = thousandFixture.threads.at(-1)!.id;
        selectedResult = yield* selectedHarness.service.hydrateSelected({
          rootThreadId: thousandFixture.rootThreadId,
          threadId: selectedThreadId,
        });
        assert.strictEqual(selectedResult.outcome, "ready");
        assert.deepEqual(
          [
            ...new Set(
              selectedHarness.measurement.resolveCalls
                .map(({ threadId }) => threadId)
                .filter((threadId) => threadId !== thousandFixture.rootThreadId),
            ),
          ],
          [selectedThreadId],
        );
      } finally {
        yield* selectedHarness.close();
      }

      const tenFixture = fixtures.get(10)!;
      const statusThreads = [...tenFixture.threads];
      const statusEntries = new Map(tenFixture.entries);
      const statusHarness = yield* makeDirectoryHarness({
        core: runtime.client,
        entries: statusEntries,
        rootThreadId: tenFixture.rootThreadId,
        threads: statusThreads,
      });
      const knownStatusSamples: number[] = [];
      const unknownStatusSamples: number[] = [];
      try {
        const knownThread = tenFixture.threads.at(-2)!;
        for (let index = 0; index < STATUS_SAMPLE_COUNT; index += 1) {
          const waiting = index % 2 === 0;
          const sample = yield* measured(
            Effect.gen(function* () {
              yield* observe(statusHarness, {
                generation: HOST_GENERATION,
                hostId: HOST_ID,
                notification: {
                  method: "thread/status/changed",
                  params: {
                    status: {
                      type: "active",
                      activeFlags: waiting ? ["waitingOnUserInput"] : [],
                    },
                    threadId: knownThread.id,
                  },
                },
                observedAtMs: 2_000_000_000_000 + index,
                occurrenceToken: 2_000_000_000 + index,
              });
              const overview = yield* readKnownOverview(statusHarness, tenFixture.rootThreadId);
              projectHotOverview(overview);
              const row = overview.active.rows.find(({ threadId }) => threadId === knownThread.id);
              assert.strictEqual(row?.status, waiting ? "waiting" : "active");
            }),
          );
          knownStatusSamples.push(sample.elapsedMs);
        }

        for (let index = 0; index < STATUS_SAMPLE_COUNT; index += 1) {
          const unknownThread = makeThread(tenFixture.rootThreadId, 10_000 + index, "active");
          const sample = yield* measured(
            Effect.gen(function* () {
              yield* observe(statusHarness, {
                generation: HOST_GENERATION,
                hostId: HOST_ID,
                notification: {
                  method: "thread/status/changed",
                  params: {
                    status: { type: "active", activeFlags: [] },
                    threadId: unknownThread.id,
                  },
                },
                observedAtMs: 2_100_000_000_000 + index,
                occurrenceToken: 2_100_000_000 + index,
              });
              statusThreads.push(unknownThread);
              statusEntries.set(
                unknownThread.id,
                makeDirectoryEntry(unknownThread, tenFixture.rootThreadId),
              );
              yield* observe(statusHarness, {
                generation: HOST_GENERATION,
                hostId: HOST_ID,
                notification: {
                  method: "thread/started",
                  params: { thread: unknownThread },
                },
                observedAtMs: 2_100_000_000_000 + index,
                occurrenceToken: 2_100_000_000 + index,
              });
              const overview = yield* readOverview(statusHarness, tenFixture.rootThreadId);
              const projected = projectHotOverview(overview);
              assert.isAtMost(projected.publishedRows, 14);
              assert.isAtLeast(overview.active.knownCount, 6 + index);
            }),
          );
          unknownStatusSamples.push(sample.elapsedMs);
        }
      } finally {
        yield* statusHarness.close();
      }
      const knownStatus = summarize(knownStatusSamples);
      const unknownStatus = summarize(unknownStatusSamples);
      assert.isAtMost(knownStatus.p95Ms, 250);
      assert.isAtMost(unknownStatus.p95Ms, 2_000);

      const evidence = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        source: {
          gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          coreExecutable: CORE_EXECUTABLE,
          corePid: runtime.client.handshake.generation.pid,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          appServerVersion: capability.version,
          appServerUserAgent: capability.userAgent,
          sourceEpoch: capability.sourceEpoch,
          stagedRuntimeBinary: stagedRuntime.binaryPath,
          stagedRuntimeVersion: stagedRuntime.version,
          stagedAppServerRuntimeVersion: stagedRuntime.appServerRuntimeVersion,
        },
        methodology: {
          samplesPerMatrixCell: SAMPLE_COUNT,
          warmupsPerMatrixCell: WARMUP_COUNT,
          realHistoryMethod:
            "three disposable real app-server Profiles with one constant seed plus 0/100/10000 measured persisted Responses items; after the writer closes, visibility-only metadata is seeded, metadata-only resume is verified in a second process, and only thread/list useStateDbOnly is sampled in a third process",
          realHistoryItemTextBytes: REAL_HISTORY_ITEM_TEXT_BYTES,
          realHistoryInjectionBatchSize: REAL_HISTORY_INJECTION_BATCH_SIZE,
          transcriptMethods: [...TRANSCRIPT_METHODS, "thread/read(includeTurns:true)"],
        },
        discovery: discoveryEvidence,
        matrix: matrixEvidence,
        mainHotProjection: mainHotProjectionEvidence,
        realPersistedHistory,
        realPersistedHistoryComparison: {
          zeroVsTenThousandGateBytes: crossProfileRssGateBytes,
          startupRssDeltaBytes,
          retainedRssDeltaBytes,
        },
        selectedOnly: {
          result: selectedResult!,
          boundaryResolveCalls: selectedHarness.measurement.resolveCalls,
          childTranscriptRpcCountAtGateway: selectedHarness.measurement.gateway.transcriptRpcCount,
        },
        statusConvergence: {
          knownChild: { gateP95Ms: 250, ...knownStatus },
          unknownActiveChildWithMetadataMaterialization: {
            gateP95Ms: 2_000,
            ...unknownStatus,
          },
        },
        layeredAuthoritativeEvidence: {
          childConversationSubscriptions:
            "The injected CodexConversations dependency is a measured Proxy; overview reads assert zero subscribe/observe/watch/events property access, while renderer/E2E gates verify selection-only attachment",
          hostWideMetadataConcurrency:
            "src/main/codex-application/CodexConversationRelationships.node.test.ts :: caps concurrent metadata repairs across parents",
          rendererHotRows:
            "src/renderer/features/local-conversation/view/subagents-panel/subagents-panel.test.tsx :: mounts 4 active and 10 done rows, then expands all and collapses again",
          selectedOnlyPhysicalReads:
            "tests/e2e/subagents.spec.ts :: keeps overview metadata-only, expands bounded windows, and hydrates only the selection",
          stopConvergence:
            "tests/e2e/subagents.spec.ts :: stops the root, interrupts only a still-running child, and converges through invalidation",
        },
        gates: {
          initialMountedRowsAtMost: 14,
          hotOverviewP95MsAtMost: HOT_OVERVIEW_P95_GATE_MS,
          steadyChildConversationReads: 0,
          steadyChildConversationSubscriptions: 0,
          steadyChildTranscriptBytes: 0,
          steadyChildTranscriptRpcCount: 0,
          metadataPhysicalConcurrencyAtMost: 2,
          realPersistedHistoryItems: REAL_HISTORY_ITEM_COUNTS,
          realHistoryMetadataListP95MsAtMost: REAL_HISTORY_LIST_P95_GATE_MS,
          realHistoryMetadataResponseBytesAtMost: 64 * 1024,
          realHistoryRssGrowth:
            "at most max(4 MiB measurement noise, 10% of the actual persisted JSONL bytes)",
          zeroVsTenThousandStartupAndRetainedRssDelta:
            "at most max(4 MiB measurement noise, 10% of the 10,000-item persisted JSONL bytes)",
          knownStatusP95MsAtMost: 250,
          unknownStatusP95MsAtMost: 2_000,
        },
      };
      yield* Effect.sync(() => {
        mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
        writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      });
      assert.isTrue(existsSync(EVIDENCE_PATH));
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This live stress test is the Effect application entry point for its probe process tree.
    }).pipe(Effect.provide(scopedCallbackRuntimeLive)),
  { timeout: 300_000 },
);
