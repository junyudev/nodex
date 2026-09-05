import { assert, it } from "@effect/vitest";
import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  type CodexHistoryEntity,
} from "../../shared/codex-conversation-state/codex-history-topology";
import {
  DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
  DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
  retainCodexHistoryResidency,
} from "../../shared/codex-conversation-state/codex-history-residency";
import { DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS } from "../../shared/codex-conversation-state/codex-history-item-window";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  make as makeConversationProjection,
  CodexConversationProjection,
} from "./CodexConversationProjection";
import { projectCodexConversationOlderTurns } from "./CodexConversationHistoryProjection";
import { make as makeHistoryRuntime } from "./CodexConversationHistoryRuntime";
import {
  CODEX_HISTORY_INITIAL_ITEM_BUDGET,
  CODEX_HISTORY_ITEM_BYTE_BUDGET,
  CODEX_HISTORY_TURN_PAGE_SIZE,
  CodexHistoryPageAdapter,
  make as makeHistoryPageAdapter,
} from "./CodexHistoryPageAdapter";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import { make as makeDirectory } from "./CodexThreadDirectory";
import {
  DEFAULT_RENDERER_OWNER_MAX_RETAINED,
  DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES,
  selectCodexRendererOwnerRetentionOverflow,
} from "./CodexRendererOwnerRetention";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

interface PhysicalRequest {
  readonly method: string;
  readonly params: unknown;
  readonly route: "host" | "thread";
}

interface LazyHistoryMeasurement {
  readonly logicalTurnCount: number;
  readonly cold: {
    readonly elapsedMs: number;
    readonly heapDeltaBytes: number;
    readonly physicalRequests: number;
    readonly requestMethods: Readonly<Record<string, number>>;
    readonly residentTurns: number;
    readonly residentItems: number;
    readonly residentApproximateBytes: number;
  };
  readonly oneScroll: {
    readonly elapsedMs: number;
    readonly physicalRequests: number;
    readonly requestMethods: Readonly<Record<string, number>>;
    readonly residentTurns: number;
    readonly residentItems: number;
    readonly residentApproximateBytes: number;
    readonly hasLoadedOldest: boolean;
  };
  readonly oneNewerPage: {
    readonly physicalRequests: number;
    readonly requestMethods: Readonly<Record<string, number>>;
    readonly cursor: string;
    readonly sortDirection: string;
    readonly searchIslandTurns: number;
  } | null;
}

interface GiantTurnColdMeasurement {
  readonly logicalItemCount: number;
  readonly elapsedMs: number;
  readonly physicalRequests: number;
  readonly physicalItemPages: number;
  readonly residentItems: number;
  readonly residentSegments: number;
  readonly residentApproximateBytes: number;
  readonly snapshotWindowBytes: number;
  readonly hasLoadedOldest: boolean;
  readonly olderCursor: string | null;
}

const THREAD_ID = "thread-history-performance";
const HOST_ID = "remote-history-performance";
const LARGE_ITEM_TEXT = "x".repeat(8 * 1024);
const RESIDENCY_ITEMS_PER_TURN = 100;
const COLD_RESIDENT_BYTES_BOUND = 6 * 1024 * 1024;
const ONE_SCROLL_RESIDENT_BYTES_BOUND = 12 * 1024 * 1024;

const coreThread = (): CoreThread =>
  ({
    thread_id: THREAD_ID,
    project_id: "project-performance",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: null,
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: "Long history performance fixture",
    thread_preview: "Virtual long history",
    backend_binding: { kind: "codex" },
    model_id: "gpt-test",
    reasoning_effort: "high",
    service_tier: null,
    execution_host_id: HOST_ID,
    cwd: "/repo",
    writable_roots: ["/repo"],
    managed_worktree_path: null,
    projectless_output_directory: null,
    projectless_workspace_browser_root: null,
    status: { status_type: "idle", active_flags: [] },
    archived: false,
    pinned_order: null,
    has_unread_turn: false,
    dynamic_tool_catalogs: [],
    created_at: 100_000,
    updated_at: 100_000,
    recency_at: 100_000,
    linked_at: "2026-08-31T00:00:00.000Z",
  }) satisfies CoreThread;

const appThread = (): Thread => ({
  model: null,
  reasoningEffort: null,
  id: THREAD_ID,
  extra: null,
  sessionId: `session-${THREAD_ID}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "Virtual long history",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 100,
  updatedAt: 120,
  recencyAt: 120,
  status: { type: "idle" },
  path: null,
  cwd: "/repo",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Long history performance fixture",
  turns: [],
});

const completedTurn = (index: number): Turn => ({
  id: `turn-${index}`,
  items: [],
  itemsView: "notLoaded",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const largeAgentItem = (turnId: string, index: number): ThreadItem => ({
  questions: null,
  type: "agentMessage",
  id: `${turnId}:item-${index}`,
  text: `${LARGE_ITEM_TEXT}:${turnId}:${index}`,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
});

const notFound = () =>
  new CoreRuntimeError({
    message: `Missing ${THREAD_ID}`,
    operation: "workspace.read",
    reason: "operation",
    retryable: false,
    cause: new CoreModuleResponseError({
      code: "not_found",
      message: `Missing ${THREAD_ID}`,
      retryable: false,
      recovery: { kind: "none" },
    }),
  });

const makeCore = (): CoreModules["Service"] => {
  const threads = new Map([[THREAD_ID, coreThread()]]);
  const read: CoreModuleClients["workspace"]["read"] = (input) => {
    if (input.kind === "execution_context") {
      const thread = threads.get(input.thread_id);
      return thread
        ? Effect.succeed({
            value: { kind: "execution_context", context: { thread, project: null } },
          } as ProjectWorkspaceReadSnapshot)
        : Effect.fail(notFound());
    }
    if (input.kind !== "thread") return Effect.die(new Error("Unexpected Core read"));
    const thread = threads.get(input.thread_id);
    return thread
      ? Effect.succeed({ value: { kind: "thread", thread } } as ProjectWorkspaceReadSnapshot)
      : Effect.fail(notFound());
  };
  const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
    Effect.sync(() => {
      const intent = input.intent;
      if (intent.kind !== "upsert_thread") {
        throw new Error(`Unexpected Core intent '${intent.kind}'`);
      }
      const existing = threads.get(intent.thread_id) ?? coreThread();
      threads.set(intent.thread_id, {
        ...existing,
        ...intent.patch,
        thread_id: intent.thread_id,
      } as CoreThread);
      return {} as never;
    });
  return CoreModules.of({ workspace: { read, apply } } as unknown as CoreModuleClients);
};

const makeConversations = (): ConversationEntityMap["Service"] => {
  const aggregates = makeConversationEntityStateRegistry();
  return ConversationEntityMap.of({
    entity: aggregates.acquire,
    current: aggregates.current,
    runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
  } as unknown as ConversationEntityMap["Service"]);
};

const cursorEnd = (cursor: unknown, logicalTurnCount: number): number => {
  if (typeof cursor !== "string") return logicalTurnCount;
  const value = Number.parseInt(cursor.replace(/^turns:/, ""), 10);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid virtual cursor '${cursor}'`);
  return Math.min(logicalTurnCount, Math.max(0, value));
};

const makeGateway = (
  logicalTurnCount: number,
  requests: PhysicalRequest[],
): CodexGateway["Service"] => {
  const requestOnHost = (hostId: string, method: string, params: unknown) =>
    Effect.sync(() => {
      requests.push({ route: "host", method, params });
      assert.strictEqual(hostId, HOST_ID);
      if (method !== "thread/resume") throw new Error(`Unexpected host request '${method}'`);
      return {
        thread: appThread(),
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/repo",
        runtimeWorkspaceRoots: ["/repo"],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: "high",
        multiAgentMode: "explicitRequestOnly",
        turnsBackwardsCursor: `turns:${logicalTurnCount}`,
        itemsBackwardsCursor: "items:tail",
      };
    }) as never;
  const requestForThread = (
    threadId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) =>
    Effect.sync(() => {
      requests.push({ route: "thread", method, params });
      assert.strictEqual(threadId, THREAD_ID);
      if (method === "thread/turns/list") {
        const limit = Number(params.limit);
        const direction = params.sortDirection === "asc" ? "asc" : "desc";
        const boundary = cursorEnd(params.cursor, logicalTurnCount);
        const start = direction === "asc" ? boundary : Math.max(0, boundary - limit);
        const end = direction === "asc" ? Math.min(logicalTurnCount, start + limit) : boundary;
        const data = Array.from({ length: end - start }, (_, offset) =>
          completedTurn(direction === "asc" ? start + offset : end - offset - 1),
        );
        return {
          data,
          nextCursor:
            direction === "asc"
              ? end === logicalTurnCount
                ? null
                : `turns:${end}`
              : start === 0
                ? null
                : `turns:${start}`,
          backwardsCursor: end === logicalTurnCount ? null : `turns:${end}`,
        };
      }
      if (method === "thread/items/list") {
        const turnId = String(params.turnId);
        const limit = Number(params.limit);
        const data = Array.from({ length: limit }, (_, index) => {
          const itemIndex = limit - index - 1;
          return { turnId, item: largeAgentItem(turnId, itemIndex) };
        });
        return { data, nextCursor: null, backwardsCursor: null };
      }
      throw new Error(`Unexpected Thread request '${method}'`);
    }) as never;
  return CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestOnHost,
    requestForThread,
  } as unknown as CodexGateway["Service"]);
};

const giantItemCursorEnd = (cursor: unknown, logicalItemCount: number): number => {
  if (typeof cursor !== "string") return 0;
  const value = Number.parseInt(cursor.replace(/^items:/, ""), 10);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid giant item cursor '${cursor}'`);
  return Math.min(logicalItemCount, Math.max(0, value));
};

const makeGiantTurnColdGateway = (
  logicalItemCount: number,
  requests: PhysicalRequest[],
): CodexGateway["Service"] => {
  const requestOnHost = (hostId: string, method: string, params: unknown) =>
    Effect.sync(() => {
      requests.push({ route: "host", method, params });
      assert.strictEqual(hostId, HOST_ID);
      assert.strictEqual(method, "thread/resume");
      return {
        thread: appThread(),
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/repo",
        runtimeWorkspaceRoots: ["/repo"],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: "high",
        multiAgentMode: "explicitRequestOnly",
        turnsBackwardsCursor: "turns:1",
        itemsBackwardsCursor: `items:${logicalItemCount}`,
      };
    }) as never;
  const requestForThread = (
    threadId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) =>
    Effect.sync(() => {
      requests.push({ route: "thread", method, params });
      assert.strictEqual(threadId, THREAD_ID);
      if (method === "thread/turns/list") {
        return {
          data: [completedTurn(0)],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method !== "thread/items/list") {
        throw new Error(`Unexpected giant cold request '${method}'`);
      }
      const turnId = String(params.turnId);
      const limit = Number(params.limit);
      const direction = params.sortDirection === "asc" ? "asc" : "desc";
      if (direction === "asc") {
        const start = giantItemCursorEnd(params.cursor, logicalItemCount);
        const end = Math.min(logicalItemCount, start + limit);
        return {
          data: Array.from({ length: end - start }, (_, offset) => ({
            turnId,
            item: largeAgentItem(turnId, start + offset),
          })),
          nextCursor: end === logicalItemCount ? null : `items:${end}`,
          backwardsCursor: start === 0 ? null : `items:${start}`,
        };
      }
      const end = giantItemCursorEnd(params.cursor, logicalItemCount);
      const start = Math.max(0, end - limit);
      return {
        data: Array.from({ length: end - start }, (_, offset) => ({
          turnId,
          item: largeAgentItem(turnId, end - offset - 1),
        })),
        nextCursor: start === 0 ? null : `items:${start}`,
        // The exact reverse cursor re-includes this page's oldest boundary anchor.
        backwardsCursor: end === logicalItemCount ? null : `items:${end - 1}`,
      };
    }) as never;
  return CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestOnHost,
    requestForThread,
  } as unknown as CodexGateway["Service"]);
};

const countMethods = (requests: readonly PhysicalRequest[]): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const request of requests) counts[request.method] = (counts[request.method] ?? 0) + 1;
  return counts;
};

const elapsedMs = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

const measureLazyHistory = (logicalTurnCount: number): Effect.Effect<LazyHistoryMeasurement> =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: PhysicalRequest[] = [];
      const core = makeCore();
      const conversations = makeConversations();
      const rendererRegistry = makeCodexRendererConversationRegistryState();
      const events = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const gateway = makeGateway(logicalTurnCount, requests);
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexRendererConversationRegistry, rendererRegistry),
        Effect.provideService(CodexApplicationEventHub, events),
        Effect.provideService(CoreModules, core),
      );
      const historyPages = yield* makeHistoryPageAdapter.pipe(
        Effect.provideService(CodexGateway, gateway),
      );
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, events),
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );
      const history = yield* makeHistoryRuntime.pipe(
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(CodexRendererConversationRegistry, rendererRegistry),
        Effect.provideService(ConversationEntityMap, conversations),
      );

      const heapBefore = process.memoryUsage().heapUsed;
      const coldStartedAt = process.hrtime.bigint();
      const resolved = yield* directory
        .resolve({ threadId: THREAD_ID, fidelity: "live" })
        .pipe(Effect.orDie);
      const coldElapsedMs = elapsedMs(coldStartedAt);
      const heapAfterCold = process.memoryUsage().heapUsed;
      if (!resolved) return yield* Effect.die(new Error("Cold resume returned no Thread"));
      const aggregate = conversations.current(THREAD_ID);
      if (!aggregate) return yield* Effect.die(new Error("Cold resume installed no aggregate"));
      const coldTopology = aggregate.readHistoryTopology();
      const coldRequests = [...requests];
      const olderBoundary = flattenCodexHistoryTopology(coldTopology).find(
        (row) => row.kind === "gap" && row.newerBoundary?.edge === "older",
      );
      if (olderBoundary?.kind !== "gap" || !olderBoundary.newerBoundary) {
        return yield* Effect.die(new Error("Cold tail exposes no exact older boundary"));
      }

      const scrollStartedAt = process.hrtime.bigint();
      yield* history
        .loadPage({
          threadId: THREAD_ID,
          expectedConversationGeneration: aggregate.generation,
          expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
          target: { kind: "turnBoundary", boundary: olderBoundary.newerBoundary },
        })
        .pipe(Effect.orDie);
      const scrollElapsedMs = elapsedMs(scrollStartedAt);
      const afterScroll = aggregate.readSnapshot();
      if (!afterScroll) return yield* Effect.die(new Error("History scroll returned no snapshot"));
      const scrollTopology = aggregate.readHistoryTopology();
      const scrollRequests = requests.slice(coldRequests.length);
      let oneNewerPage: LazyHistoryMeasurement["oneNewerPage"] = null;
      if (logicalTurnCount >= 10_000) {
        const current = aggregate.readCanonicalState();
        if (!current)
          return yield* Effect.die(new Error("Newer-page fixture lost canonical state"));
        const searchTurn = completedTurn(0);
        const searchState = projectCodexConversationOlderTurns({
          current,
          olderTurns: [searchTurn],
          oldestLoadedTurnId: current.turns[0]?.protocol.id ?? null,
          itemsPaginationByTurnId: {
            [searchTurn.id]: {
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: true,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "full",
            },
          },
        });
        const generation = aggregate.readHistoryTopology().generation;
        const inserted = aggregate.insertHistoryIsland({
          mutationId: "search:newer-performance",
          expectedTopologyGeneration: generation,
          index: 0,
          islandId: "search:newer-performance",
          state: searchState,
          turnIds: [searchTurn.id],
          itemsPaginationByTurnId: {
            [searchTurn.id]: {
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: true,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "full",
            },
          },
          olderBoundary: exhaustedCodexHistoryBoundary("search:newer-performance:older"),
          newerBoundary: availableCodexHistoryBoundary("search:newer-performance:newer", {
            cursor: "turns:1",
            oldestLoadedTurnId: searchTurn.id,
          }),
          observedAtMs: 1,
          projectReplica: false,
        });
        if (inserted.status !== "committed") {
          return yield* Effect.die(new Error(`Search island rejected: ${inserted.status}`));
        }
        const newerBoundary = flattenCodexHistoryTopology(aggregate.readHistoryTopology()).find(
          (row) => row.kind === "gap" && row.olderBoundary?.edge === "newer",
        );
        if (newerBoundary?.kind !== "gap" || !newerBoundary.olderBoundary) {
          return yield* Effect.die(new Error("Search island exposes no exact newer boundary"));
        }
        const beforeNewer = requests.length;
        yield* history
          .loadPage({
            threadId: THREAD_ID,
            expectedConversationGeneration: aggregate.generation,
            expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
            target: { kind: "turnBoundary", boundary: newerBoundary.olderBoundary },
          })
          .pipe(Effect.orDie);
        const newerRequests = requests.slice(beforeNewer);
        const turnRequest = newerRequests.find((request) => request.method === "thread/turns/list");
        const turnParams = turnRequest?.params as
          | { readonly cursor?: unknown; readonly sortDirection?: unknown }
          | undefined;
        oneNewerPage = {
          physicalRequests: newerRequests.length,
          requestMethods: countMethods(newerRequests),
          cursor: String(turnParams?.cursor),
          sortDirection: String(turnParams?.sortDirection),
          searchIslandTurns:
            aggregate
              .readHistoryTopology()
              .islands.find((island) => island.id === "search:newer-performance")?.entries.length ??
            0,
        };
      }

      return {
        logicalTurnCount,
        cold: {
          elapsedMs: coldElapsedMs,
          heapDeltaBytes: heapAfterCold - heapBefore,
          physicalRequests: coldRequests.length,
          requestMethods: countMethods(coldRequests),
          residentTurns: coldTopology.residency.turnCount,
          residentItems: coldTopology.residency.itemCount,
          residentApproximateBytes: coldTopology.residency.approximateBytes,
        },
        oneScroll: {
          elapsedMs: scrollElapsedMs,
          physicalRequests: scrollRequests.length,
          requestMethods: countMethods(scrollRequests),
          residentTurns: scrollTopology.residency.turnCount,
          residentItems: scrollTopology.residency.itemCount,
          residentApproximateBytes: scrollTopology.residency.approximateBytes,
          hasLoadedOldest: afterScroll.turnPagination?.hasLoadedOldest ?? true,
        },
        oneNewerPage,
      };
    }),
  );

const measureGiantTurnCold = (logicalItemCount: number): Effect.Effect<GiantTurnColdMeasurement> =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: PhysicalRequest[] = [];
      const core = makeCore();
      const conversations = makeConversations();
      const rendererRegistry = makeCodexRendererConversationRegistryState();
      const events = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const gateway = makeGiantTurnColdGateway(logicalItemCount, requests);
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexRendererConversationRegistry, rendererRegistry),
        Effect.provideService(CodexApplicationEventHub, events),
        Effect.provideService(CoreModules, core),
      );
      const historyPages = yield* makeHistoryPageAdapter.pipe(
        Effect.provideService(CodexGateway, gateway),
      );
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, events),
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const startedAt = process.hrtime.bigint();
      const resolved = yield* directory
        .resolve({ threadId: THREAD_ID, fidelity: "live" })
        .pipe(Effect.orDie);
      const elapsed = elapsedMs(startedAt);
      if (!resolved) return yield* Effect.die(new Error("Giant cold resume returned no Thread"));
      const aggregate = conversations.current(THREAD_ID);
      const snapshot = aggregate?.readSnapshot();
      const window = snapshot?.historyItemWindowsByTurnId?.["turn-0"];
      const itemPage = aggregate?.readTurnItemsPagination("turn-0");
      if (!aggregate || !snapshot || !window || !itemPage) {
        return yield* Effect.die(new Error("Giant cold resume installed no exact item window"));
      }
      const residentIds = window.segments.flatMap((segment) => [...segment.items.itemIds]);
      const residentApproximateBytes = window.segments.reduce(
        (total, segment) => total + segment.approximateBytes,
        0,
      );
      assert.isAbove(residentIds.length, 0);
      assert.isAtMost(
        residentIds.length,
        Math.min(logicalItemCount, CODEX_HISTORY_INITIAL_ITEM_BUDGET),
      );
      assert.deepEqual(
        residentIds,
        Array.from(
          { length: residentIds.length },
          (_, offset) => `turn-0:item-${logicalItemCount - residentIds.length + offset}`,
        ),
      );
      assert.strictEqual(new Set(residentIds).size, residentIds.length);
      assert.strictEqual(aggregate.readHistoryTopology().residency.itemCount, residentIds.length);

      return {
        logicalItemCount,
        elapsedMs: elapsed,
        physicalRequests: requests.length,
        physicalItemPages: requests.filter((request) => request.method === "thread/items/list")
          .length,
        residentItems: residentIds.length,
        residentSegments: window.segments.length,
        residentApproximateBytes,
        snapshotWindowBytes: new TextEncoder().encode(JSON.stringify(window)).byteLength,
        hasLoadedOldest: itemPage.hasLoadedOldest,
        olderCursor: itemPage.olderCursor,
      };
    }),
  );

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: HOST_ID,
  generation: 1,
  userAgent: "codex-app-server/0.147.0",
});

const capabilities = CodexAppServerCapabilities.of({
  forHost: () => Effect.succeed(capabilitySnapshot),
  forThread: () => Effect.succeed(capabilitySnapshot),
  isCurrent: () => Effect.succeed(true),
});

it.effect("keeps cold resume and one scroll physically bounded for a virtual 10k-Turn Thread", () =>
  Effect.gen(function* () {
    const measurements = yield* Effect.forEach([10, 10_000], measureLazyHistory, {
      concurrency: 1,
    });

    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({ kind: "cold-resume-and-scroll", measurements })}\n`,
    );

    for (const measurement of measurements) {
      // Initial hydration probes each of the five Turn shells with one item. Work remains tied
      // to the fixed Turn page even when the persisted Thread contains ten thousand Turns.
      assert.strictEqual(measurement.cold.physicalRequests, 7);
      assert.deepEqual(measurement.cold.requestMethods, {
        "thread/resume": 1,
        "thread/turns/list": 1,
        "thread/items/list": CODEX_HISTORY_TURN_PAGE_SIZE,
      });
      assert.strictEqual(measurement.cold.residentTurns, CODEX_HISTORY_TURN_PAGE_SIZE);
      assert.strictEqual(measurement.cold.residentItems, CODEX_HISTORY_TURN_PAGE_SIZE);
      assert.isAtMost(measurement.cold.residentApproximateBytes, COLD_RESIDENT_BYTES_BOUND);

      assert.strictEqual(measurement.oneScroll.physicalRequests, 6);
      assert.deepEqual(measurement.oneScroll.requestMethods, {
        "thread/turns/list": 1,
        "thread/items/list": CODEX_HISTORY_TURN_PAGE_SIZE,
      });
      assert.strictEqual(measurement.oneScroll.residentTurns, 10);
      assert.strictEqual(measurement.oneScroll.residentItems, 2 * CODEX_HISTORY_TURN_PAGE_SIZE);
      assert.isAtMost(
        measurement.oneScroll.residentApproximateBytes,
        ONE_SCROLL_RESIDENT_BYTES_BOUND,
      );
    }

    const [shortHistory, longHistory] = measurements;
    assert.isDefined(shortHistory);
    assert.isDefined(longHistory);
    assert.isAtMost(
      Math.abs(
        shortHistory.cold.residentApproximateBytes - longHistory.cold.residentApproximateBytes,
      ),
      64 * 1024,
    );
    assert.isAtMost(
      Math.abs(
        shortHistory.oneScroll.residentApproximateBytes -
          longHistory.oneScroll.residentApproximateBytes,
      ),
      128 * 1024,
    );
    assert.isTrue(shortHistory.oneScroll.hasLoadedOldest);
    assert.isFalse(longHistory.oneScroll.hasLoadedOldest);
    assert.isNull(shortHistory.oneNewerPage);
    assert.deepEqual(longHistory.oneNewerPage, {
      physicalRequests: 6,
      requestMethods: {
        "thread/turns/list": 1,
        "thread/items/list": CODEX_HISTORY_TURN_PAGE_SIZE,
      },
      cursor: "turns:1",
      sortDirection: "asc",
      searchIslandTurns: 6,
    });
  }),
);

it.effect("bounds cold work and bytes for 5, 500, and 5k-item giant Turns", () =>
  Effect.gen(function* () {
    const measurements = yield* Effect.forEach([5, 500, 5_000], measureGiantTurnCold, {
      concurrency: 1,
    });
    // One single-item probe bounds the first decode. With the conservative three-projection heap
    // charge, one 100-item page fits and the next whole cursor page is rejected without residency.
    // Persisted item cardinality never changes the number of physical reads.
    const expectedItemPages = [2, 3, 3];
    const expectedPhysicalRequests = [4, 5, 5];
    for (let index = 0; index < measurements.length; index += 1) {
      const measurement = measurements[index]!;
      assert.strictEqual(measurement.physicalItemPages, expectedItemPages[index]);
      assert.strictEqual(measurement.physicalRequests, expectedPhysicalRequests[index]);
      assert.isAtMost(measurement.residentItems, CODEX_HISTORY_INITIAL_ITEM_BUDGET);
      assert.isAtMost(measurement.residentSegments, 5);
      assert.isAtMost(
        measurement.residentApproximateBytes,
        DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes,
      );
      assert.isAtMost(
        measurement.snapshotWindowBytes,
        DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes + 512 * 1024,
      );
    }
    assert.strictEqual(measurements[0]?.residentItems, 5);
    assert.strictEqual(measurements[1]?.residentItems, 101);
    assert.strictEqual(measurements[2]?.residentItems, 101);
    assert.isTrue(measurements[0]?.hasLoadedOldest);
    assert.isFalse(measurements[1]?.hasLoadedOldest);
    assert.isFalse(measurements[2]?.hasLoadedOldest);
    assert.isNull(measurements[0]?.olderCursor);
    assert.strictEqual(measurements[1]?.olderCursor, "items:399");
    assert.strictEqual(measurements[2]?.olderCursor, "items:4899");
    assert.isAtMost(
      Math.abs(
        measurements[1]!.residentApproximateBytes - measurements[2]!.residentApproximateBytes,
      ),
      64 * 1024,
    );

    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
        kind: "giant-turn-cold-window",
        itemWindowLimits: DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
        measurements,
      })}\n`,
    );
  }),
);

const residencyEntity = (index: number): CodexHistoryEntity<Turn> => {
  const turn = completedTurn(index);
  return {
    key: turn.id,
    turn,
    itemCount: RESIDENCY_ITEMS_PER_TURN,
    approximateBytes: 256 * 1024,
    itemsPagination: {
      olderCursor: null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView: "full",
    },
    authority: "history",
    revision: 1,
  };
};

it("releases a 10k-Turn topology independently by count and bytes", () => {
  const startedAt = process.hrtime.bigint();
  const entities = Array.from({ length: 10_000 }, (_, index) => residencyEntity(index));
  const created = createCodexHistoryIslandTopology({
    generation: 1,
    islandId: "tail:performance",
    entries: entities.map((entity) => ({ key: `turn:${entity.key}`, entityKey: entity.key })),
    entities,
    olderBoundary: availableCodexHistoryBoundary("older:performance", {
      cursor: "turns:older",
      oldestLoadedTurnId: entities[0]?.key ?? null,
    }),
    newerBoundary: exhaustedCodexHistoryBoundary("newer:performance"),
  });
  if (!created.ok) throw new Error(created.error.message);

  const countRetained = retainCodexHistoryResidency(created.topology, {
    limits: {
      maxTurns: DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
      maxApproximateBytes: Number.MAX_SAFE_INTEGER,
    },
  });
  const byteRetained = retainCodexHistoryResidency(created.topology, {
    limits: {
      maxTurns: entities.length,
      maxApproximateBytes: DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
    },
  });
  const simultaneousRetained = retainCodexHistoryResidency(created.topology);
  const elapsed = elapsedMs(startedAt);

  assert.strictEqual(
    countRetained.topology.residency.turnCount,
    DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
  );
  assert.strictEqual(countRetained.evictedEntityKeys.length, 9_900);
  assert.strictEqual(Object.keys(countRetained.topology.entitiesByKey).length, 100);
  assert.isTrue(countRetained.limitsSatisfied);
  assert.strictEqual(byteRetained.topology.residency.turnCount, 64);
  assert.strictEqual(
    byteRetained.topology.residency.approximateBytes,
    DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
  );
  assert.strictEqual(byteRetained.evictedEntityKeys.length, 9_936);
  assert.strictEqual(Object.keys(byteRetained.topology.entitiesByKey).length, 64);
  assert.isTrue(byteRetained.limitsSatisfied);

  assert.isAtMost(
    simultaneousRetained.topology.residency.turnCount,
    DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
  );
  assert.isAtMost(
    simultaneousRetained.topology.residency.approximateBytes,
    DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
  );
  assert.strictEqual(simultaneousRetained.topology.residency.turnCount, 64);
  assert.strictEqual(simultaneousRetained.retainedEntityKeys.length, 64);
  assert.strictEqual(simultaneousRetained.evictedEntityKeys.length, 9_936);
  assert.strictEqual(Object.keys(simultaneousRetained.topology.entitiesByKey).length, 64);
  assert.isTrue(simultaneousRetained.limitsSatisfied);
  assert.isFalse(simultaneousRetained.protectedResidencyExceedsLimits);

  process.stdout.write(
    `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
      kind: "resident-graph-retention",
      logicalTurnCount: 10_000,
      elapsedMs: elapsed,
      countPressure: {
        residentTurns: countRetained.topology.residency.turnCount,
        residentApproximateBytes: countRetained.topology.residency.approximateBytes,
        evictedTurns: countRetained.evictedEntityKeys.length,
      },
      bytePressure: {
        residentTurns: byteRetained.topology.residency.turnCount,
        residentApproximateBytes: byteRetained.topology.residency.approximateBytes,
        evictedTurns: byteRetained.evictedEntityKeys.length,
      },
      simultaneousPressure: {
        residentTurns: simultaneousRetained.topology.residency.turnCount,
        residentApproximateBytes: simultaneousRetained.topology.residency.approximateBytes,
        evictedTurns: simultaneousRetained.evictedEntityKeys.length,
      },
    })}\n`,
  );
});

it("bounds passive conversation owners independently by count and resident bytes", () => {
  const mib = 1024 * 1024;
  const countCandidates = Array.from({ length: 5 }, (_, index) => ({
    conversationId: `count-${index}`,
    candidateSince: index,
    generation: index + 1,
    approximateBytes: 4 * mib,
  }));
  const countOverflow = selectCodexRendererOwnerRetentionOverflow({
    candidates: countCandidates,
    maxRetained: DEFAULT_RENDERER_OWNER_MAX_RETAINED,
    maxRetainedApproximateBytes: DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES,
  });
  assert.deepEqual(countOverflow, [
    {
      conversationId: "count-0",
      generation: 1,
      reason: "inactive-owner-retained-limit",
    },
  ]);

  const byteCandidates = Array.from({ length: 4 }, (_, index) => ({
    conversationId: `bytes-${index}`,
    candidateSince: index,
    generation: index + 1,
    approximateBytes: 10 * mib,
  }));
  const byteOverflow = selectCodexRendererOwnerRetentionOverflow({
    candidates: byteCandidates,
    maxRetained: DEFAULT_RENDERER_OWNER_MAX_RETAINED,
    maxRetainedApproximateBytes: DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES,
  });
  assert.deepEqual(byteOverflow, [
    {
      conversationId: "bytes-0",
      generation: 1,
      reason: "inactive-owner-retained-byte-limit",
    },
  ]);

  process.stdout.write(
    `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
      kind: "passive-owner-retention",
      maxRetained: DEFAULT_RENDERER_OWNER_MAX_RETAINED,
      maxRetainedApproximateBytes: DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES,
      countPressure: {
        candidates: countCandidates.length,
        evicted: countOverflow.length,
        retained: countCandidates.length - countOverflow.length,
        retainedApproximateBytes: 16 * mib,
        reason: countOverflow[0]?.reason,
      },
      bytePressure: {
        candidates: byteCandidates.length,
        evicted: byteOverflow.length,
        retained: byteCandidates.length - byteOverflow.length,
        retainedApproximateBytes: 30 * mib,
        reason: byteOverflow[0]?.reason,
      },
    })}\n`,
  );
});

it.effect("rejects one oversized partial-Turn item page at its exact cursor boundary", () =>
  Effect.gen(function* () {
    const requests: PhysicalRequest[] = [];
    const cursor = "items:oversized-boundary";
    const oversizedText = "z".repeat(CODEX_HISTORY_ITEM_BYTE_BUDGET + 1_024);
    const gateway = CodexGateway.of({
      localHostId: "local",
      events: Stream.empty,
      requestForThread: (
        threadId: string,
        method: string,
        params: Readonly<Record<string, unknown>>,
      ) =>
        Effect.sync(() => {
          requests.push({ route: "thread", method, params });
          assert.strictEqual(threadId, THREAD_ID);
          assert.strictEqual(method, "thread/items/list");
          assert.strictEqual(params.cursor, cursor);
          return {
            data: [
              {
                turnId: "turn-oversized",
                item: {
                  questions: null,
                  type: "agentMessage",
                  id: "item-oversized",
                  text: oversizedText,
                  phase: "final_answer",
                  memoryCitation: null,
                  delivery: null,
                },
              },
            ],
            nextCursor: "items:next",
            backwardsCursor: null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* makeHistoryPageAdapter.pipe(
      Effect.provideService(CodexGateway, gateway),
    );
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const failure = yield* adapter
      .loadTurnItemsPage({
        capability: capabilitySnapshot,
        threadId: THREAD_ID,
        turnId: "turn-oversized",
        cursor,
        purpose: "older",
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "item-byte-limit");
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0]?.method, "thread/items/list");
    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
        kind: "partial-item-byte-cap",
        elapsedMs: elapsedMs(startedAt),
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        physicalRequests: requests.length,
        cursorPreserved: (requests[0]?.params as { readonly cursor?: unknown }).cursor === cursor,
        byteBudget: CODEX_HISTORY_ITEM_BYTE_BUDGET,
        rejectedApproximateBytes: Buffer.byteLength(
          JSON.stringify([{ text: oversizedText }]),
          "utf8",
        ),
        reason: failure.reason,
      })}\n`,
    );
  }),
);
