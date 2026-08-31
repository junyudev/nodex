import { assert, it } from "@effect/vitest";
import type {
  Thread,
  ThreadForkParams,
  ThreadForkResponse,
} from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexEphemeralThreadRouting,
  CodexEphemeralThreadRoutingError,
} from "../codex-runtime/CodexEphemeralThreadRouting";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { make as makePersistentFork } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import {
  CODEX_FORK_TITLE_MAX_PAGES,
  CodexForkTitlePolicy,
  make as makeForkTitlePolicy,
} from "./CodexForkTitlePolicy";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { make as makeSideChatCommands } from "./CodexSideChatCommands";
import { SIDE_CHAT_BOUNDARY_TEXT } from "./CodexSideChatPolicy";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexTurnCommands, type CodexTurnCommandsService } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";

const SOURCE_THREAD_ID = "thread-source-performance";
const PERSISTENT_CHILD_ID = "thread-fork-performance";
const SIDE_CHAT_CHILD_ID = "thread-side-performance";
const HOST_ID = "remote-performance";
const HISTORY_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
]);

interface PhysicalRequest {
  readonly hostId: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface CreationMeasurement {
  readonly logicalTurnCount: number;
  readonly elapsedMs: number;
  readonly heapDeltaBytes: number;
  readonly methods: readonly string[];
  readonly historyRequests: number;
  readonly excludeTurns: boolean;
  readonly resultResidentTurns: number;
}

const elapsedMs = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

const protocolThread = (threadId: string, overrides: Partial<Thread> = {}): Thread => ({
  id: threadId,
  extra: null,
  sessionId: `session-${threadId}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 100,
  updatedAt: 100,
  recencyAt: 100,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
  ...overrides,
});

const conversationSnapshot = (
  threadId: string,
  logicalTurnCount: number,
): CodexConversationSnapshot =>
  ({
    threadId,
    projectId: "project-performance",
    threadName: "Bounded creation fixture",
    threadPreview: `Virtual source history: ${logicalTurnCount} turns`,
    forkedFromId: null,
    source: { parentThreadId: null },
    cwd: "/workspace",
    executionProfile: {
      providerId: "openai",
      modelId: "gpt-test",
      harnessId: null,
      reasoningEffort: "high",
      serviceTier: null,
    },
    resumeState: "resumed",
    turns: [],
    turnPagination: {
      olderCursor: `turns:${logicalTurnCount}`,
      backwardsCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 0,
      itemsView: "notLoaded",
    },
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  }) as unknown as CodexConversationSnapshot;

const forkResponse = (threadId: string, ephemeral: boolean): ThreadForkResponse =>
  ({
    thread: protocolThread(threadId, {
      ephemeral,
      forkedFromId: SOURCE_THREAD_ID,
    }),
    cwd: "/workspace",
    model: "gpt-test",
    reasoningEffort: "high",
    modelProvider: "openai",
    serviceTier: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/workspace"],
    instructionSources: [],
    multiAgentMode: "explicitRequestOnly",
  }) as unknown as ThreadForkResponse;

const sourceEntry = (logicalTurnCount: number, includeMetadataOnlyCanonical = false) => {
  const summary = conversationSnapshot(SOURCE_THREAD_ID, logicalTurnCount);
  return {
    fidelity: "durable",
    historyMode: "paginated",
    durable: {
      threadId: SOURCE_THREAD_ID,
      projectId: "project-performance",
      executionHostId: HOST_ID,
      cwd: "/workspace",
      executionProfile: summary.executionProfile,
    },
    summary,
    canonical: includeMetadataOnlyCanonical
      ? ({ turns: [] } as unknown as CodexCanonicalConversationState)
      : null,
    snapshot: null,
  } as never;
};

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: HOST_ID,
  generation: 1,
  userAgent: "codex-app-server/0.147.0",
});

const capabilityService = CodexAppServerCapabilities.of({
  forHost: () => Effect.succeed(capabilitySnapshot),
  forThread: () => Effect.succeed(capabilitySnapshot),
  isCurrent: () => Effect.succeed(true),
});

const makePersistentForkHarness = (
  logicalTurnCount: number,
  options: { readonly productionForkTitlePolicy?: boolean } = {},
) => {
  const requests: PhysicalRequest[] = [];
  let titleCatalogReads = 0;
  let canonical: CodexCanonicalConversationState | null = null;
  let snapshot: CodexConversationSnapshot | null = null;
  const source = sourceEntry(logicalTurnCount, options.productionForkTitlePolicy === true);
  const childSummary = conversationSnapshot(PERSISTENT_CHILD_ID, 0);
  const childCanonical = {
    protocol: protocolThread(PERSISTENT_CHILD_ID),
    turns: [],
    requests: [],
    sidecar: {},
  } as unknown as CodexCanonicalConversationState;
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestOnHost: (hostId: string, method: string, params: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        requests.push({ hostId, method, params });
        if (method !== "thread/fork") throw new Error(`Unexpected request '${method}'`);
        return forkResponse(PERSISTENT_CHILD_ID, false);
      }) as never,
  } as unknown as CodexGateway["Service"]);
  const directory = CodexThreadDirectory.of({
    resolve: () => Effect.succeed(source),
    acceptForkResult: () =>
      Effect.succeed({
        fidelity: "metadata",
        durable: {
          threadId: PERSISTENT_CHILD_ID,
          projectId: "project-performance",
          executionHostId: HOST_ID,
          cwd: "/workspace",
        },
        summary: childSummary,
        canonical: childCanonical,
        snapshot: childSummary,
      } as never),
  } as unknown as CodexThreadDirectory["Service"]);
  const projection = CodexConversationProjection.of({
    hydrate: (input: {
      readonly canonical: CodexCanonicalConversationState;
      readonly pagination: CodexConversationSnapshot["turnPagination"];
    }) =>
      Effect.sync(() => {
        canonical = input.canonical;
        snapshot = {
          ...childSummary,
          canonicalState: input.canonical,
          turnPagination: input.pagination,
          turns: [],
        } as CodexConversationSnapshot;
        return snapshot;
      }),
    read: () => {
      if (!canonical || !snapshot) return Effect.die(new Error("Fork projection not hydrated"));
      return Effect.succeed({ canonical, snapshot });
    },
  } as unknown as CodexConversationProjection["Service"]);
  const core = CoreModules.of({
    workspace: {
      read: (input: Parameters<CoreModuleClients["workspace"]["read"]>[0]) => {
        if (input.kind === "task_window") {
          return Effect.sync(() => {
            titleCatalogReads += 1;
            return {
              value: {
                kind: "task_window",
                tasks: {
                  items: [],
                  next_cursor: `title-cursor-${titleCatalogReads}`,
                  authority: { projection_revision: 1 },
                },
              },
            } as unknown as ProjectWorkspaceReadSnapshot;
          });
        }
        if (input.kind === "thread") {
          return Effect.succeed({
            value: {
              kind: "thread",
              thread: {
                thread_id: SOURCE_THREAD_ID,
                execution_host_id: HOST_ID,
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.succeed({
          value: {
            kind: "execution_context",
            context: { thread: { writable_roots: ["/workspace"] }, project: null },
          },
        } as unknown as ProjectWorkspaceReadSnapshot);
      },
    },
  } as unknown as CoreModuleClients);
  const titlePolicy = options.productionForkTitlePolicy
    ? makeForkTitlePolicy
    : Effect.succeed(
        CodexForkTitlePolicy.of({
          derive: () => Effect.die("Unloaded source history must not derive a transcript title"),
        } as never),
      );
  const forks = titlePolicy.pipe(
    Effect.flatMap((forkTitlePolicy) =>
      makePersistentFork.pipe(
        Effect.provideService(CodexAppServerCapabilities, capabilityService),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexForkSidePanelTransfer,
          CodexForkSidePanelTransfer.of({
            stageDirect: () => Effect.void,
            promotePending: () => Effect.void,
          } as never),
        ),
        Effect.provideService(CodexForkTitlePolicy, forkTitlePolicy),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(
          CodexOwnerNotificationDrainRuntime,
          CodexOwnerNotificationDrainRuntime.of({ awaitCurrent: () => Effect.void } as never),
        ),
        Effect.provideService(
          CodexRendererConversationCoordinator,
          CodexRendererConversationCoordinator.of({
            adoptRendererOwner: () => Effect.die("No renderer owner requested"),
          } as never),
        ),
        Effect.provideService(
          CodexThreadCatalog,
          CodexThreadCatalog.of({
            ensureSession: () =>
              Effect.succeed({
                id: "session-fork-performance",
                thread: { threadId: PERSISTENT_CHILD_ID },
              } as never),
          } as never),
        ),
        Effect.provideService(CodexThreadDirectory, directory),
        Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
        Effect.provideService(
          CodexThreadTitlePersistence,
          CodexThreadTitlePersistence.of({
            set: () => Effect.die("Unloaded source history must not synthesize a child title"),
            setRequired: () =>
              Effect.die("Unloaded source history must not synthesize a child title"),
          }),
        ),
        Effect.provideService(
          ConversationEntityMap,
          ConversationEntityMap.of({
            runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) =>
              operation,
          } as unknown as ConversationEntityMap["Service"]),
        ),
      ),
    ),
    Effect.provideService(CoreModules, core),
  );
  return { forks, requests, titleCatalogReads: () => titleCatalogReads };
};

const measurePersistentFork = (logicalTurnCount: number): Effect.Effect<CreationMeasurement> =>
  Effect.gen(function* () {
    const harness = makePersistentForkHarness(logicalTurnCount);
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const forks = yield* harness.forks;
    const result = yield* forks
      .fork({
        sourceThreadId: SOURCE_THREAD_ID,
        lastTurnId: `turn-${logicalTurnCount - 1}`,
        threadSource: "user",
      })
      .pipe(Effect.orDie);
    const elapsed = elapsedMs(startedAt);
    const fork = harness.requests[0];
    if (!fork) return yield* Effect.die(new Error("Persistent fork sent no request"));
    const params = fork.params as unknown as ThreadForkParams;
    assert.strictEqual(params.lastTurnId, `turn-${logicalTurnCount - 1}`);
    assert.strictEqual(result.threadId, PERSISTENT_CHILD_ID);
    return {
      logicalTurnCount,
      elapsedMs: elapsed,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      methods: harness.requests.map((request) => request.method),
      historyRequests: harness.requests.filter((request) => HISTORY_METHODS.has(request.method))
        .length,
      excludeTurns: params.excludeTurns === true,
      resultResidentTurns: result.conversation.turns.length,
    };
  });

const makeSideChatHarness = (logicalTurnCount: number) => {
  const requests: PhysicalRequest[] = [];
  const routes = new Map<string, string>();
  const aggregates = makeConversationEntityStateRegistry();
  const conversations = ConversationEntityMap.of({
    entity: aggregates.acquire,
    current: aggregates.current,
    runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
  } as unknown as ConversationEntityMap["Service"]);
  const routing = CodexEphemeralThreadRouting.of({
    resolve: (threadId) => Effect.succeed(routes.get(threadId) ?? null),
    register: (threadId, hostId) => {
      if (!threadId.trim() || !hostId.trim()) {
        return Effect.fail(new CodexEphemeralThreadRoutingError({ threadId, hostId }));
      }
      return Effect.sync(() => {
        routes.set(threadId, hostId);
      });
    },
    remove: (threadId) =>
      Effect.sync(() => {
        routes.delete(threadId);
      }),
  });
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestOnHost: (hostId: string, method: string, params: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        requests.push({ hostId, method, params });
        if (method === "thread/fork") return forkResponse(SIDE_CHAT_CHILD_ID, true);
        if (method === "thread/inject_items") return {};
        throw new Error(`Unexpected request '${method}'`);
      }) as never,
  } as unknown as CodexGateway["Service"]);
  const directory = CodexThreadDirectory.of({
    resolve: () => Effect.succeed(sourceEntry(logicalTurnCount)),
  } as unknown as CodexThreadDirectory["Service"]);
  const projection = CodexConversationProjection.of({
    hydrate: (input: {
      readonly canonical: CodexCanonicalConversationState;
      readonly pagination: CodexConversationSnapshot["turnPagination"];
    }) =>
      Effect.succeed({
        ...conversationSnapshot(SIDE_CHAT_CHILD_ID, 0),
        canonicalState: input.canonical,
        turnPagination: input.pagination,
        source: { parentThreadId: SOURCE_THREAD_ID, sideConversation: true },
        turns: [],
      } as CodexConversationSnapshot),
  } as unknown as CodexConversationProjection["Service"]);
  const commands = makeSideChatCommands.pipe(
    Effect.provideService(CodexAppServerCapabilities, capabilityService),
    Effect.provideService(CodexConversationProjection, projection),
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(
      CodexThreadHostResolver,
      CodexThreadHostResolver.of({ resolve: () => Effect.succeed(HOST_ID) }),
    ),
    Effect.provideService(CodexEphemeralThreadRouting, routing),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
    Effect.provideService(
      CodexTurnCommands,
      CodexTurnCommands.of({
        start: () => Effect.die("Side-chat fixture has no initial prompt"),
        startAutomation: () => Effect.die("unused"),
        startRendererOwned: () => Effect.die("unused"),
        acceptPreparedRendererTurn: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        continueGoal: () => Effect.die("unused"),
      } satisfies CodexTurnCommandsService),
    ),
    Effect.provideService(ConversationEntityMap, conversations),
  );
  return { commands, requests };
};

const measureSideChat = (logicalTurnCount: number): Effect.Effect<CreationMeasurement> =>
  Effect.gen(function* () {
    const harness = makeSideChatHarness(logicalTurnCount);
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const commands = yield* harness.commands;
    const result = yield* commands.start({ parentThreadId: SOURCE_THREAD_ID }).pipe(Effect.orDie);
    const elapsed = elapsedMs(startedAt);
    const fork = harness.requests.find((request) => request.method === "thread/fork");
    const injection = harness.requests.find((request) => request.method === "thread/inject_items");
    if (!fork || !injection) {
      return yield* Effect.die(new Error("Side chat did not fork and inject its boundary"));
    }
    const params = fork.params as unknown as ThreadForkParams;
    const boundaryText = (
      injection.params as {
        readonly items?: ReadonlyArray<{
          readonly content?: ReadonlyArray<{ readonly text?: string }>;
        }>;
      }
    ).items?.[0]?.content?.[0]?.text;
    assert.strictEqual(boundaryText, SIDE_CHAT_BOUNDARY_TEXT);
    assert.strictEqual(result.threadId, SIDE_CHAT_CHILD_ID);
    return {
      logicalTurnCount,
      elapsedMs: elapsed,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      methods: harness.requests.map((request) => request.method),
      historyRequests: harness.requests.filter((request) => HISTORY_METHODS.has(request.method))
        .length,
      excludeTurns: params.excludeTurns === true,
      resultResidentTurns: result.conversation.turns.length,
    };
  });

it.effect("keeps persistent forks independent from source history length", () =>
  Effect.gen(function* () {
    const measurements = yield* Effect.forEach([10, 10_000], measurePersistentFork, {
      concurrency: 1,
    });
    for (const measurement of measurements) {
      assert.deepEqual(measurement.methods, ["thread/fork"]);
      assert.strictEqual(measurement.historyRequests, 0);
      assert.isTrue(measurement.excludeTurns);
      assert.strictEqual(measurement.resultResidentTurns, 0);
    }
    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({ kind: "persistent-fork", measurements })}\n`,
    );
  }),
);

it.effect(
  "keeps the production fork-title catalog scan bounded without reading parent history",
  () =>
    Effect.gen(function* () {
      const measurements = yield* Effect.forEach(
        [10, 10_000],
        (logicalTurnCount) =>
          Effect.gen(function* () {
            const harness = makePersistentForkHarness(logicalTurnCount, {
              productionForkTitlePolicy: true,
            });
            const forks = yield* harness.forks;
            const result = yield* forks
              .fork({
                sourceThreadId: SOURCE_THREAD_ID,
                lastTurnId: `turn-${logicalTurnCount - 1}`,
                threadSource: "user",
              })
              .pipe(Effect.orDie);
            return {
              logicalTurnCount,
              titleCatalogReads: harness.titleCatalogReads(),
              methods: harness.requests.map((request) => request.method),
              historyRequests: harness.requests.filter((request) =>
                HISTORY_METHODS.has(request.method),
              ).length,
              residentTurns: result.conversation.turns.length,
            };
          }),
        { concurrency: 1 },
      );

      for (const measurement of measurements) {
        assert.strictEqual(measurement.titleCatalogReads, CODEX_FORK_TITLE_MAX_PAGES);
        assert.deepEqual(measurement.methods, ["thread/fork"]);
        assert.strictEqual(measurement.historyRequests, 0);
        assert.strictEqual(measurement.residentTurns, 0);
      }
      assert.deepEqual(
        measurements.map((measurement) => measurement.titleCatalogReads),
        [CODEX_FORK_TITLE_MAX_PAGES, CODEX_FORK_TITLE_MAX_PAGES],
      );
    }),
);

it.effect("keeps side-chat creation independent from parent history length", () =>
  Effect.gen(function* () {
    const measurements = yield* Effect.forEach([10, 10_000], measureSideChat, {
      concurrency: 1,
    });
    for (const measurement of measurements) {
      assert.deepEqual(measurement.methods, ["thread/fork", "thread/inject_items"]);
      assert.strictEqual(measurement.historyRequests, 0);
      assert.isTrue(measurement.excludeTurns);
      assert.strictEqual(measurement.resultResidentTurns, 0);
    }
    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({ kind: "side-chat", measurements })}\n`,
    );
  }),
);
