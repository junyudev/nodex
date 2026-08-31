import type { Thread, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  createCodexHistoryItemWindow,
  DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
  type CodexHistoryItemSegment,
} from "../../shared/codex-conversation-state/codex-history-item-window";
import {
  flattenCodexHistoryTopology,
  type CodexHistoryTurnItemsPagination,
} from "../../shared/codex-conversation-state/codex-history-topology";
import {
  applyCodexConversationHistoryMutation,
  createCodexConversationHistoryTurnItemsRef,
  snapshotCodexConversationHistoryItemWindow,
  type CodexConversationHistoryPageRequest,
  type CodexConversationHistoryPageResult,
} from "../../shared/codex-conversation-history-page";
import {
  applyCodexThreadOwnerPublication,
  buildCodexThreadStreamCheckpoint,
  hashCodexConversationReplica,
} from "../../shared/codex-owner-follower-replication";
import type {
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
} from "../../shared/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  projectCodexConversationSnapshot,
  projectCodexConversationTurn,
} from "./CodexConversationSnapshotProjection";
import { make as makeHistoryRuntime } from "./CodexConversationHistoryRuntime";
import { CodexHistoryPageAdapter, make as makeHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const THREAD_ID = "thread-giant-turn-production-performance";
const TURN_ID = "turn-giant";
const RESIDENT_SEGMENTS = 5;
const ITEMS_PER_PAGE = 100;
const RESIDENT_ITEMS = RESIDENT_SEGMENTS * ITEMS_PER_PAGE;
const ITEM_TEXT = "g".repeat(512);
const MUTATION_MAX_BYTES = 256 * 1024;

interface PayloadReads {
  canonical: number;
  renderer: number;
}

interface PhysicalItemRequest {
  readonly cursor: string | null;
  readonly limit: number;
  readonly sortDirection: "asc" | "desc";
}

interface PageMeasurement {
  readonly edge: "older" | "newer";
  readonly request: PhysicalItemRequest;
  readonly mutationBytes: number;
  readonly wireItems: number;
  readonly releasedSegmentIds: readonly string[];
  readonly residentItems: number;
  readonly residentApproximateBytes: number;
  readonly unchangedCanonicalPayloadReads: number;
  readonly unchangedRendererPayloadReads: number;
  readonly ownerFollowerAccepted: true;
  readonly elapsedMs: number;
}

interface GiantTurnMeasurement {
  readonly logicalItemCount: number;
  readonly physicalRequests: number;
  readonly pages: readonly PageMeasurement[];
  readonly finalResidentItems: number;
  readonly finalResidentApproximateBytes: number;
  readonly finalOlderCursor: string | null;
  readonly finalNewerBoundary: "available" | "exhausted" | "opaque";
  readonly duplicateItems: number;
  readonly skippedItems: number;
}

const itemId = (index: number): string => `item-${index.toString().padStart(5, "0")}`;
const olderCursor = (index: number): string => `items:older:${index}`;
const newerCursor = (index: number): string => `items:newer:${index}`;

const trackedAgentItem = (index: number, onPayloadRead: () => void): ThreadItem => {
  const value = {
    type: "agentMessage",
    id: itemId(index),
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
  } as Record<string, unknown>;
  Object.defineProperty(value, "text", {
    enumerable: true,
    get: () => {
      onPayloadRead();
      return `${ITEM_TEXT}:${itemId(index)}`;
    },
  });
  return value as unknown as ThreadItem;
};

const pageAgentItem = (index: number): ThreadItem => ({
  type: "agentMessage",
  id: itemId(index),
  text: `${ITEM_TEXT}:${itemId(index)}`,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
});

const appThread = (items: readonly ThreadItem[]): Thread => ({
  id: THREAD_ID,
  extra: null,
  sessionId: `session-${THREAD_ID}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "Virtual giant Turn",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
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
  name: "Giant Turn performance fixture",
  turns: [
    {
      id: TURN_ID,
      items: [...items],
      itemsView: "summary",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  ],
});

const hydration = {
  model: "gpt-test",
  reasoningEffort: "high" as const,
  cwd: "/workspace",
  approvalPolicy: "on-request" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/workspace"],
};

const turnPagination = (): CodexConversationTurnPagination => ({
  olderCursor: null,
  backwardsCursor: null,
  oldestLoadedTurnId: TURN_ID,
  isLoadingOlder: false,
  hasLoadedOldest: true,
  loadedTurnCount: 1,
  itemsView: "summary",
});

const itemPagination = (start: number): CodexHistoryTurnItemsPagination => ({
  olderCursor: olderCursor(start),
  isLoadingOlder: false,
  hasLoadedOldest: false,
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: "summary",
});

const trackedRendererTurn = (
  canonical: CodexCanonicalConversationState,
  reads: PayloadReads,
): CodexConversationTurn => {
  const projected = projectCodexConversationTurn({
    threadId: THREAD_ID,
    turnIndex: 0,
    beforeTurn: null,
    afterTurn: canonical.turns[0]!,
    current: null,
    observedAtMs: 1,
  });
  return {
    ...projected,
    items: projected.items.map((item) => {
      const copy = { ...item } as Record<string, unknown>;
      const text = copy.text;
      if (typeof text !== "string") return item;
      Object.defineProperty(copy, "text", {
        enumerable: true,
        get: () => {
          reads.renderer += 1;
          return text;
        },
      });
      return copy as unknown as CodexConversationItem;
    }),
  };
};

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const initialSegments = (input: {
  readonly logicalItemCount: number;
  readonly canonical: CodexCanonicalConversationState;
  readonly rendererTurn: CodexConversationTurn;
}): readonly CodexHistoryItemSegment<
  CodexCanonicalConversationState["turns"][number]["items"][number],
  CodexConversationItem
>[] => {
  const residentStart = input.logicalItemCount - RESIDENT_ITEMS;
  const rendererById = new Map(
    input.rendererTurn.items.map((item) => [item.itemId, item] as const),
  );
  return Array.from({ length: RESIDENT_SEGMENTS }, (_, segmentIndex) => {
    const start = residentStart + segmentIndex * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE - 1;
    const canonicalItems = input.canonical.turns[0]!.items.slice(
      segmentIndex * ITEMS_PER_PAGE,
      (segmentIndex + 1) * ITEMS_PER_PAGE,
    );
    const itemIds = canonicalItems.map((item) => item.id);
    const rendererItems = itemIds.map((id) => rendererById.get(id)!);
    return {
      segmentId: `resident:${start}-${end}`,
      turnId: TURN_ID,
      olderCursor: olderCursor(start),
      newerCursor: segmentIndex === RESIDENT_SEGMENTS - 1 ? null : newerCursor(end),
      items: { itemIds, canonicalItems, rendererItems },
      approximateBytes: serializedBytes({ canonicalItems, rendererItems }),
    };
  });
};

const baseSnapshot = (input: {
  readonly canonical: CodexCanonicalConversationState;
  readonly rendererTurn: CodexConversationTurn;
  readonly pagination: CodexHistoryTurnItemsPagination;
  readonly itemWindow: ReturnType<typeof snapshotCodexConversationHistoryItemWindow>;
  readonly aggregate: ReturnType<typeof makeConversationEntityStateRegistry>["acquire"] extends (
    threadId: string,
  ) => infer Entity
    ? Entity
    : never;
}): CodexConversationSnapshot => {
  const topology = input.aggregate.readHistoryTopology();
  const conversation = {
    threadId: THREAD_ID,
    projectId: "project-performance",
    source: null,
    threadName: "Giant Turn performance fixture",
    threadPreview: "Virtual giant Turn",
    modelProvider: "openai",
    cwd: "/workspace",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-08-31T00:00:00.000Z",
    resumeState: "resumed",
    turns: [input.rendererTurn],
    canonicalState: input.canonical,
    canonicalRequests: [],
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
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditLastUserTurn: false,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    conversationEntityGeneration: input.aggregate.generation,
    historyTopologyGeneration: topology.generation,
    historyMutationRevision: input.aggregate.read().historyMutationRevision,
    historyRows: flattenCodexHistoryTopology(topology),
    turnPagination: turnPagination(),
    turnItemsPaginationById: { [TURN_ID]: input.pagination },
    historyItemWindowsByTurnId: { [TURN_ID]: input.itemWindow },
  } as CodexConversationSnapshot;
  return {
    ...projectCodexConversationSnapshot({
      conversation,
      before: null,
      after: input.canonical,
      observedAtMs: 1,
    }),
    turns: [input.rendererTurn],
    canonicalState: input.canonical,
    historyItemWindowsByTurnId: { [TURN_ID]: input.itemWindow },
  };
};

const snapshotResidency = (snapshot: CodexConversationSnapshot) => {
  const window = snapshot.historyItemWindowsByTurnId?.[TURN_ID];
  if (!window) throw new Error("Giant Turn has no resident item window");
  return {
    ids: window.segments.flatMap((segment) => [...segment.items.itemIds]),
    approximateBytes: window.segments.reduce(
      (total, segment) => total + segment.approximateBytes,
      0,
    ),
    olderCursor: window.olderBoundary.status === "available" ? window.olderBoundary.cursor : null,
    newerBoundary: window.newerBoundary.status,
  };
};

const assertContiguous = (
  snapshot: CodexConversationSnapshot,
  start: number,
  end: number,
): { readonly duplicateItems: number; readonly skippedItems: number } => {
  const expected = Array.from({ length: end - start + 1 }, (_, offset) => itemId(start + offset));
  const residency = snapshotResidency(snapshot);
  const unique = new Set(residency.ids);
  const duplicateItems = residency.ids.length - unique.size;
  const skippedItems = expected.filter((id) => !unique.has(id)).length;
  assert.deepEqual(residency.ids, expected);
  assert.strictEqual(duplicateItems, 0);
  assert.strictEqual(skippedItems, 0);
  assert.deepEqual(
    snapshot.canonicalState?.turns[0]?.items.map((item) => item.id),
    expected,
  );
  assert.deepEqual(snapshot.turns[0]?.itemIds, expected);
  return { duplicateItems, skippedItems };
};

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.147.0",
});

const capabilities = CodexAppServerCapabilities.of({
  forHost: () => Effect.succeed(capabilitySnapshot),
  forThread: () => Effect.succeed(capabilitySnapshot),
  isCurrent: () => Effect.succeed(true),
});

const makeGateway = (
  logicalItemCount: number,
  requests: PhysicalItemRequest[],
): CodexGateway["Service"] => {
  const residentStart = logicalItemCount - RESIDENT_ITEMS;
  const olderStart = residentStart - ITEMS_PER_PAGE;
  const olderEnd = residentStart - 1;
  const retainedNewest = logicalItemCount - ITEMS_PER_PAGE - 1;
  const firstNewerEnd = logicalItemCount - 2;
  return CodexGateway.of({
    requestForThread: (
      threadId: string,
      method: string,
      params: Readonly<Record<string, unknown>>,
    ) =>
      Effect.sync(() => {
        assert.strictEqual(threadId, THREAD_ID);
        assert.strictEqual(method, "thread/items/list");
        assert.strictEqual(params.turnId, TURN_ID);
        const request = {
          cursor: params.cursor === null ? null : String(params.cursor),
          limit: Number(params.limit),
          sortDirection: params.sortDirection === "asc" ? "asc" : "desc",
        } satisfies PhysicalItemRequest;
        requests.push(request);

        if (request.cursor === olderCursor(residentStart) && request.sortDirection === "desc") {
          return {
            data: Array.from({ length: ITEMS_PER_PAGE }, (_, offset) => {
              const index = olderEnd - offset;
              return { turnId: TURN_ID, item: pageAgentItem(index) };
            }),
            nextCursor: olderCursor(olderStart),
            backwardsCursor: newerCursor(olderEnd),
          };
        }
        if (request.cursor === newerCursor(retainedNewest) && request.sortDirection === "asc") {
          return {
            // App-server reverse cursors include the retained boundary anchor.
            data: Array.from({ length: ITEMS_PER_PAGE }, (_, offset) => {
              const index = retainedNewest + offset;
              return { turnId: TURN_ID, item: pageAgentItem(index) };
            }),
            nextCursor: newerCursor(firstNewerEnd),
            backwardsCursor: olderCursor(retainedNewest),
          };
        }
        if (request.cursor === newerCursor(firstNewerEnd) && request.sortDirection === "asc") {
          return {
            data: [
              { turnId: TURN_ID, item: pageAgentItem(firstNewerEnd) },
              { turnId: TURN_ID, item: pageAgentItem(logicalItemCount - 1) },
            ],
            nextCursor: null,
            backwardsCursor: olderCursor(firstNewerEnd),
          };
        }
        throw new Error(`Unexpected item page ${JSON.stringify(request)}`);
      }) as never,
  } as unknown as CodexGateway["Service"]);
};

const measure = (logicalItemCount: number): Effect.Effect<GiantTurnMeasurement> =>
  Effect.scoped(
    Effect.gen(function* () {
      const residentStart = logicalItemCount - RESIDENT_ITEMS;
      const olderStart = residentStart - ITEMS_PER_PAGE;
      const reads: PayloadReads = { canonical: 0, renderer: 0 };
      const residentItems = Array.from({ length: RESIDENT_ITEMS }, (_, offset) =>
        trackedAgentItem(residentStart + offset, () => {
          reads.canonical += 1;
        }),
      );
      const pagination = itemPagination(residentStart);
      const canonical = createCodexCanonicalHydratedConversationState(appThread(residentItems), {
        ...hydration,
        turnItemsPaginationById: { [TURN_ID]: pagination },
      });
      const rendererTurn = trackedRendererTurn(canonical, reads);
      const segments = initialSegments({ logicalItemCount, canonical, rendererTurn });
      const created = createCodexHistoryItemWindow({
        turnId: TURN_ID,
        olderBoundary: { status: "available", cursor: olderCursor(residentStart) },
        newerBoundary: { status: "exhausted" },
        seedSegments: segments,
      });
      if (!created.ok) return yield* Effect.die(new Error(created.error.message));

      const aggregates = makeConversationEntityStateRegistry();
      const aggregate = aggregates.acquire(THREAD_ID);
      aggregate.acceptCanonicalState(canonical);
      aggregate.initializeHistory(turnPagination(), 1, { [TURN_ID]: pagination });
      aggregate.installSnapshot(
        baseSnapshot({
          canonical,
          rendererTurn,
          pagination,
          itemWindow: snapshotCodexConversationHistoryItemWindow(created.window),
          aggregate,
        }),
      );
      const conversations = ConversationEntityMap.of({
        entity: aggregates.acquire,
        current: aggregates.current,
        runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
      } as unknown as ConversationEntityMap["Service"]);
      const requests: PhysicalItemRequest[] = [];
      const historyPages = yield* makeHistoryPageAdapter.pipe(
        Effect.provideService(CodexGateway, makeGateway(logicalItemCount, requests)),
      );
      const history = yield* makeHistoryRuntime.pipe(
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
      );

      let receiver = aggregate.readSnapshot();
      if (!receiver) return yield* Effect.die(new Error("Initial giant Turn snapshot is absent"));
      hashCodexConversationReplica(receiver);
      let follower = {
        checkpoint: buildCodexThreadStreamCheckpoint({
          ownerEpoch: 7,
          revision: 0,
          conversation: receiver,
        }),
        conversation: receiver,
      };
      reads.canonical = 0;
      reads.renderer = 0;
      const pages: PageMeasurement[] = [];

      const load = (edge: "older" | "newer") =>
        Effect.gen(function* () {
          const source = aggregate.readSnapshot();
          if (!source) return yield* Effect.die(new Error("Giant Turn source snapshot vanished"));
          const currentPagination = aggregate.readTurnItemsPagination(TURN_ID);
          if (!currentPagination) {
            return yield* Effect.die(new Error("Giant Turn pagination vanished"));
          }
          const ref = createCodexConversationHistoryTurnItemsRef({
            turnId: TURN_ID,
            expectedTopologyGeneration: aggregate.readHistoryTopology().generation,
            pagination: currentPagination,
            edge,
            window: source.historyItemWindowsByTurnId?.[TURN_ID],
          });
          if (!ref) return yield* Effect.die(new Error(`Missing ${edge} item boundary`));
          const request: CodexConversationHistoryPageRequest = {
            threadId: THREAD_ID,
            expectedConversationGeneration: aggregate.generation,
            expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
            target: { kind: "turnItems", items: ref },
          };
          const beforeRequests = requests.length;
          const canonicalReadsBefore = reads.canonical;
          const rendererReadsBefore = reads.renderer;
          const startedAt = process.hrtime.bigint();
          const result: CodexConversationHistoryPageResult = yield* history
            .loadPage(request)
            .pipe(Effect.orDie);
          assert.strictEqual(requests.length, beforeRequests + 1);
          const physicalRequest = requests.at(-1)!;
          const mutationBytes = serializedBytes(result.mutation);
          const applied = applyCodexConversationHistoryMutation(receiver!, result.mutation);
          if (!applied.ok) {
            return yield* Effect.die(new Error(`Receiver rejected item page: ${applied.reason}`));
          }
          const sourceAfter = aggregate.readSnapshot();
          if (!sourceAfter) {
            return yield* Effect.die(new Error("Giant Turn source snapshot vanished after page"));
          }
          const sourceHash = hashCodexConversationReplica(sourceAfter);
          const receiverHash = hashCodexConversationReplica(applied.conversation);
          assert.strictEqual(receiverHash, sourceHash);
          const checkpoint = buildCodexThreadStreamCheckpoint({
            ownerEpoch: 7,
            revision: follower.checkpoint.revision + 1,
            conversation: applied.conversation,
          });
          const published = applyCodexThreadOwnerPublication({
            current: follower,
            expectedOwnerEpoch: 7,
            publication: {
              conversationId: THREAD_ID,
              baseCheckpoint: follower.checkpoint,
              checkpoint,
              change: {
                type: "historyMutation",
                baseRevision: follower.checkpoint.revision,
                revision: checkpoint.revision,
                mutation: result.mutation,
              },
            },
          });
          if (!published.accepted) {
            return yield* Effect.die(
              new Error(`Owner/follower rejected item page: ${published.reason}`),
            );
          }
          follower = published.replica;
          receiver = published.replica.conversation;
          const residency = snapshotResidency(receiver);
          const itemMutation = result.mutation.turnItems[0];
          if (!itemMutation) {
            return yield* Effect.die(new Error("Item page emitted no item-window mutation"));
          }
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
          const page: PageMeasurement = {
            edge,
            request: physicalRequest,
            mutationBytes,
            wireItems: itemMutation.windowMutation.wireSegment.items.itemIds.length,
            releasedSegmentIds: itemMutation.windowMutation.releasedSegmentIds,
            residentItems: residency.ids.length,
            residentApproximateBytes: residency.approximateBytes,
            unchangedCanonicalPayloadReads: reads.canonical - canonicalReadsBefore,
            unchangedRendererPayloadReads: reads.renderer - rendererReadsBefore,
            ownerFollowerAccepted: true,
            elapsedMs,
          };
          assert.strictEqual(result.mutation.upsertTurns.length, 0);
          assert.strictEqual(result.mutation.upsertCanonicalTurns.length, 0);
          assert.strictEqual(result.mutation.turnItems.length, 1);
          assert.isTrue(page.ownerFollowerAccepted);
          assert.isAtMost(page.mutationBytes, MUTATION_MAX_BYTES);
          assert.isAtMost(page.residentItems, DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxItems);
          assert.isAtMost(
            page.residentApproximateBytes,
            DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes,
          );
          pages.push(page);
          return result;
        });

      const older = yield* load("older");
      const olderSegmentId = older.mutation.turnItems[0]!.windowMutation.wireSegment.segmentId;
      assert.deepEqual(requests, [
        {
          cursor: olderCursor(residentStart),
          limit: ITEMS_PER_PAGE,
          sortDirection: "desc",
        },
      ]);
      assert.deepEqual(pages[0]?.releasedSegmentIds, [
        `resident:${logicalItemCount - ITEMS_PER_PAGE}-${logicalItemCount - 1}`,
      ]);
      assert.strictEqual(pages[0]?.wireItems, ITEMS_PER_PAGE);
      assertContiguous(receiver, olderStart, logicalItemCount - ITEMS_PER_PAGE - 1);
      assert.deepEqual(receiver.historyItemWindowsByTurnId?.[TURN_ID]?.newerBoundary, {
        status: "available",
        cursor: newerCursor(logicalItemCount - ITEMS_PER_PAGE - 1),
      });

      yield* load("newer");
      assert.deepEqual(requests[1], {
        cursor: newerCursor(logicalItemCount - ITEMS_PER_PAGE - 1),
        limit: ITEMS_PER_PAGE,
        sortDirection: "asc",
      });
      assert.strictEqual(pages[1]?.wireItems, ITEMS_PER_PAGE - 1);
      assert.deepEqual(pages[1]?.releasedSegmentIds, [olderSegmentId]);
      assertContiguous(receiver, residentStart, logicalItemCount - 2);
      assert.strictEqual(
        snapshotResidency(receiver).ids.filter(
          (id) => id === itemId(logicalItemCount - ITEMS_PER_PAGE - 1),
        ).length,
        1,
      );
      assert.deepEqual(receiver.historyItemWindowsByTurnId?.[TURN_ID]?.newerBoundary, {
        status: "available",
        cursor: newerCursor(logicalItemCount - 2),
      });

      yield* load("newer");
      assert.deepEqual(requests[2], {
        cursor: newerCursor(logicalItemCount - 2),
        limit: ITEMS_PER_PAGE,
        sortDirection: "asc",
      });
      assert.strictEqual(pages[2]?.wireItems, 1);
      assert.deepEqual(pages[2]?.releasedSegmentIds, []);
      const continuity = assertContiguous(receiver, residentStart, logicalItemCount - 1);
      assert.strictEqual(
        snapshotResidency(receiver).ids.filter((id) => id === itemId(logicalItemCount - 2)).length,
        1,
      );
      const final = snapshotResidency(receiver);
      assert.strictEqual(final.olderCursor, olderCursor(residentStart));
      assert.strictEqual(final.newerBoundary, "exhausted");

      return {
        logicalItemCount,
        physicalRequests: requests.length,
        pages,
        finalResidentItems: final.ids.length,
        finalResidentApproximateBytes: final.approximateBytes,
        finalOlderCursor: final.olderCursor,
        finalNewerBoundary: final.newerBoundary,
        ...continuity,
      };
    }),
  );

it.effect(
  "keeps a production giant Turn bounded through older eviction and exact inclusive-anchor reload",
  () =>
    Effect.gen(function* () {
      const measurements = yield* Effect.forEach([700, 10_000], measure, { concurrency: 1 });
      for (const measurement of measurements) {
        assert.strictEqual(measurement.physicalRequests, 3);
        assert.strictEqual(measurement.pages.length, 3);
        assert.strictEqual(measurement.finalResidentItems, RESIDENT_ITEMS);
        assert.isAtMost(
          measurement.finalResidentApproximateBytes,
          DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes,
        );
        assert.strictEqual(measurement.finalNewerBoundary, "exhausted");
        assert.strictEqual(measurement.duplicateItems, 0);
        assert.strictEqual(measurement.skippedItems, 0);
        for (const page of measurement.pages) {
          assert.strictEqual(page.unchangedCanonicalPayloadReads, 0);
          assert.strictEqual(page.unchangedRendererPayloadReads, 0);
        }
      }
      const [small, large] = measurements;
      if (!small || !large) return yield* Effect.die(new Error("Missing scale measurement"));
      for (let index = 0; index < small.pages.length; index += 1) {
        assert.isAtMost(
          Math.abs(small.pages[index]!.mutationBytes - large.pages[index]!.mutationBytes),
          8 * 1024,
        );
      }

      process.stdout.write(
        `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
          kind: "production-giant-turn-cycle",
          itemWindowLimits: DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
          mutationMaxBytes: MUTATION_MAX_BYTES,
          measurements,
        })}\n`,
      );
    }),
);
