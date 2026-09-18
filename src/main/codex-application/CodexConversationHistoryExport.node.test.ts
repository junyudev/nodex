import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import type { CodexHydratedHistoryTurnPage } from "./CodexHistoryPageAdapter";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { CODEX_HISTORY_EXPORT_MAX_ACTIVE_JOBS, make } from "./CodexConversationHistoryExport";

const turn = (
  id: string,
  items: ThreadItem[] = [],
  itemsView: Turn["itemsView"] = "full",
): Turn => ({
  id,
  items,
  itemsView,
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const thread = (turns: Turn[]): Thread => ({
  model: null,
  reasoningEffort: null,
  id: "thread-export",
  environments: null,
  extra: null,
  sessionId: "session-export",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  originator: null,
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  turns,
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

const capability: CodexAppServerCapabilitySnapshot = {
  hostId: "local",
  generation: 7,
  userAgent: "codex-app-server/0.150.0-alpha.12",
  version: "0.150.0-alpha.12",
  nativeAppTools: false,
  flags: {
    turnApprovalsReviewer: false,

    turnToolOutput: false,
    forkLastTurnId: true,
    paginatedFork: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: true,
    multiAgentV2Protocol: false,
    sideConversation: true,
    subagentAncestorFilter: false,
    threadRevert: true,
    threadQueue: true,
  },
};

const makeFixture = (
  options: {
    canonicalOnly?: boolean;
    complete?: boolean;
    historyMode?: Thread["historyMode"];
  } = {},
) => {
  const canonical = produce(
    createCodexCanonicalHydratedConversationState(
      { ...thread([turn("resident-tail")]), historyMode: options.historyMode ?? "paginated" },
      { hostId: "local", ...hydration },
    ),
    (draft) => {
      const complete = options.complete === true;
      replaceCanonicalHistoryDraft(
        draft,
        draft.turns,
        complete,
        complete
          ? null
          : {
              cursor: "resident-older",
              oldestLoadedTurnId: "resident-tail",
            },
      );
      draft.turnsPagination = {
        olderCursor: complete ? null : "resident-older",
        oldestLoadedTurnId: "resident-tail",
        isLoadingOlder: false,
        hasLoadedOldest: complete,
      };
    },
  );
  const aggregates = makeConversationEntityStateRegistry();
  const aggregate = aggregates.acquire("thread-export");
  aggregate.installFollowerCanonicalState(canonical);
  const snapshot = {
    threadId: "thread-export",
    cwd: "/workspace",
    resumeState: "resumed",
    canonicalState: canonical,
    turns: [
      {
        threadId: "thread-export",
        turnId: "resident-tail",
        status: "completed",
        itemIds: [],
        items: [],
      },
    ],
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
  } as unknown as CodexConversationSnapshot;
  if (!options.canonicalOnly) aggregate.installSnapshot(snapshot);
  return {
    aggregate,
    canonical,
    snapshot,
    conversations: ConversationEntityMap.of({
      registerThreadMetadata: aggregates.registerThreadMetadata,
      readThreadMetadata: aggregates.readThreadMetadata,
      entity: aggregates.acquire,
      current: aggregates.current,
    } as unknown as ConversationEntityMap["Service"]),
  };
};

const capabilityService = (isCurrent: () => boolean = () => true) =>
  CodexAppServerCapabilities.of({
    forHost: () => Effect.succeed(capability),
    forThread: () => Effect.succeed(capability),
    isCurrent: () => Effect.succeed(isCurrent()),
  });

it.effect.each([false, true])(
  "exports the requested page independently of resident topology, canonical-only %s",
  (canonicalOnly) =>
    Effect.gen(function* () {
      const fixture = makeFixture({ canonicalOnly });
      const before = fixture.aggregate.readCanonicalState();
      const presentation = fixture.aggregate.readSnapshot();
      const pages = CodexHistoryPageAdapter.of({
        loadTurnPage: () =>
          Effect.succeed({
            turns: [
              turn("exported-page", [
                {
                  type: "agentMessage",
                  id: "exported-answer",
                  text: "Exported answer",
                  questions: null,
                  phase: "final_answer",
                  memoryCitation: null,
                  delivery: null,
                },
              ]),
            ],
            nextCursor: null,
            backwardsCursor: null,
            itemsPaginationByTurnId: {
              "exported-page": {
                olderCursor: null,
                isLoadingOlder: false,
                hasLoadedOldest: true,
                itemsView: "full",
              },
            },
            itemSegmentsByTurnId: {},
            loadedItemCount: 1,
          }),
        loadTurnItemsPage: () => Effect.die("Complete export Turn must not load more items"),
      });
      const runtime = yield* make.pipe(
        Effect.provideService(ConversationEntityMap, fixture.conversations),
        Effect.provideService(CodexHistoryPageAdapter, pages),
        Effect.provideService(CodexAppServerCapabilities, capabilityService()),
      );
      const started = yield* runtime.start({ consumerId: "reader", threadId: "thread-export" });
      const result = yield* runtime.next({ consumerId: "reader", jobId: started.jobId });
      assert.strictEqual(result.turn?.turnId, "exported-page");
      assert.deepEqual(
        result.turn?.items.map((item) => item.markdownText),
        ["Exported answer"],
      );
      assert.isTrue(result.done);
      assert.strictEqual(fixture.aggregate.readCanonicalState(), before);
      assert.strictEqual(fixture.aggregate.readSnapshot(), presentation);
    }),
);

it.effect.each(["legacy", "paginated"] as const)(
  "exports complete canonical-only %s history without native access",
  (historyMode) =>
    Effect.gen(function* () {
      const fixture = makeFixture({ canonicalOnly: true, complete: true, historyMode });
      const runtime = yield* make.pipe(
        Effect.provideService(ConversationEntityMap, fixture.conversations),
        Effect.provideService(CodexHistoryPageAdapter, {
          loadTurnPage: () => Effect.die("Complete resident history needs no native pages"),
          loadTurnItemsPage: () => Effect.die("Complete resident history needs no native items"),
        }),
        Effect.provideService(CodexAppServerCapabilities, {
          forHost: () => Effect.die("Resident export needs no native connection"),
          forThread: () => Effect.die("Resident export needs no native connection"),
          isCurrent: () => Effect.die("Resident export needs no native connection"),
        }),
      );
      const before = fixture.aggregate.readCanonicalState();
      const started = yield* runtime.start({ consumerId: "reader", threadId: "thread-export" });
      assert.strictEqual(started.mode, "resident");
      assert.strictEqual(started.totalTurnCount, 1);
      const result = yield* runtime.next({ consumerId: "reader", jobId: started.jobId });
      assert.strictEqual(result.turn?.turnId, "resident-tail");
      assert.isTrue(result.done);
      assert.strictEqual(fixture.aggregate.readCanonicalState(), before);
      assert.isNull(fixture.aggregate.readSnapshot());
    }),
);

it.effect("rejects incomplete legacy canonical history despite an unqualified presentation", () =>
  Effect.gen(function* () {
    const fixture = makeFixture({ historyMode: "legacy" });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, {
        loadTurnPage: () => Effect.die("Legacy export must not load paginated history"),
        loadTurnItemsPage: () => Effect.die("Legacy export must not load paginated history"),
      }),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const failure = yield* runtime
      .start({ consumerId: "reader", threadId: "thread-export" })
      .pipe(Effect.flip);
    assert.strictEqual(failure.reason, "unsupported-history");
  }),
);

it.effect("exports resident history with updated and newly appended live Turns", () =>
  Effect.gen(function* () {
    const fixture = makeFixture({ canonicalOnly: true, complete: true });
    const overlays = createCodexCanonicalHydratedConversationState(
      thread([
        turn("resident-tail", [
          {
            type: "agentMessage",
            id: "updated-answer",
            text: "Updated live answer",
            questions: null,
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
          },
        ]),
        turn("live-follow-up", [
          {
            type: "agentMessage",
            id: "follow-up-answer",
            text: "Follow-up answer",
            questions: null,
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
          },
        ]),
      ]),
      { hostId: "local", ...hydration },
    );
    fixture.aggregate.installFollowerCanonicalState({
      ...fixture.canonical,
      turns: overlays.turns,
    });
    const before = fixture.aggregate.readCanonicalState();
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, {
        loadTurnPage: () => Effect.die("Complete resident history needs no native pages"),
        loadTurnItemsPage: () => Effect.die("Complete resident history needs no native items"),
      }),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () => Effect.die("Resident export needs no native connection"),
        forThread: () => Effect.die("Resident export needs no native connection"),
        isCurrent: () => Effect.die("Resident export needs no native connection"),
      }),
    );
    const started = yield* runtime.start({ consumerId: "reader", threadId: "thread-export" });
    assert.strictEqual(started.totalTurnCount, 2);
    const first = yield* runtime.next({ consumerId: "reader", jobId: started.jobId });
    const second = yield* runtime.next({ consumerId: "reader", jobId: started.jobId });
    assert.strictEqual(first.turn?.turnId, "resident-tail");
    assert.deepEqual(
      first.turn?.items.map((item) => item.markdownText),
      ["Updated live answer"],
    );
    assert.strictEqual(second.turn?.turnId, "live-follow-up");
    assert.deepEqual(
      second.turn?.items.map((item) => item.markdownText),
      ["Follow-up answer"],
    );
    assert.isFalse(first.done);
    assert.isTrue(second.done);
    assert.strictEqual(fixture.aggregate.readCanonicalState(), before);
    assert.isNull(fixture.aggregate.readSnapshot());
  }),
);

it.effect("does not export an item-incomplete canonical island as fully resident history", () =>
  Effect.gen(function* () {
    const fixture = makeFixture({ canonicalOnly: true, complete: true });
    fixture.aggregate.installFollowerCanonicalState(
      produce(fixture.canonical, (draft) => {
        const history = draft.turnHistory!.history;
        const key = history.islands[0]!.entries[0]!.value;
        history.entitiesByKey[key]!.itemsPagination = {
          olderCursor: "items:older",
          hasLoadedOldest: false,
          isLoadingOlder: false,
          itemsView: "summary",
        };
      }),
    );
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, {
        loadTurnPage: () => Effect.die("Export admission must not fetch a page"),
        loadTurnItemsPage: () => Effect.die("Export admission must not fetch items"),
      }),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const started = yield* runtime.start({ consumerId: "reader", threadId: "thread-export" });
    assert.strictEqual(started.mode, "paginated");
    assert.isNull(started.totalTurnCount);
    assert.isNull(fixture.aggregate.readSnapshot());
  }),
);

it.effect("streams complete Turns oldest-first without installing them in resident state", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const opening = {
      type: "userMessage",
      id: "opening",
      clientId: null,
      content: [{ type: "text", text: "question", text_elements: [] }],
    } satisfies ThreadItem;
    const answer = {
      questions: null,
      type: "agentMessage",
      id: "answer",
      text: "answer",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
    } satisfies ThreadItem;
    const pageRequests: Array<{ cursor: string | null; purpose?: string }> = [];
    const itemRequests: Array<{ cursor: string | null; purpose?: string }> = [];
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: (input) => {
        pageRequests.push({ cursor: input.cursor, purpose: input.purpose });
        const result: CodexHydratedHistoryTurnPage =
          input.cursor === null
            ? {
                turns: [turn("turn-1", [answer], "summary")],
                nextCursor: "turns:2",
                backwardsCursor: null,
                itemsPaginationByTurnId: {
                  "turn-1": {
                    olderCursor: "items:1",
                    isLoadingOlder: false,
                    hasLoadedOldest: false,
                    oldestUserInput: opening.content,
                    openingUserMessageId: opening.id,
                    itemsView: "summary" as const,
                  },
                },
                itemSegmentsByTurnId: {},
                loadedItemCount: 1,
              }
            : {
                turns: [turn("turn-2")],
                nextCursor: null,
                backwardsCursor: null,
                itemsPaginationByTurnId: {
                  "turn-2": {
                    olderCursor: null,
                    isLoadingOlder: false,
                    hasLoadedOldest: true,
                    oldestUserInput: null,
                    openingUserMessageId: null,
                    itemsView: "full" as const,
                  },
                },
                itemSegmentsByTurnId: {},
                loadedItemCount: 0,
              };
        return Effect.succeed(result);
      },
      loadTurnItemsPage: (input) => {
        itemRequests.push({ cursor: input.cursor, purpose: input.purpose });
        return Effect.succeed({
          items: [opening],
          nextCursor: null,
          backwardsCursor: null,
          approximateBytes: 1,
        });
      },
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const residentSnapshot = fixture.aggregate.readSnapshot();

    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });
    const first = yield* runtime.next({ consumerId: "renderer-1", jobId: started.jobId });
    const second = yield* runtime.next({ consumerId: "renderer-1", jobId: started.jobId });

    assert.strictEqual(started.mode, "paginated");
    assert.deepEqual(
      first.turn?.items.map((item) => item.role),
      ["user", "assistant"],
    );
    assert.strictEqual(first.done, false);
    assert.strictEqual(second.turn?.turnId, "turn-2");
    assert.strictEqual(second.done, true);
    assert.deepEqual(pageRequests, [
      { cursor: null, purpose: "export" },
      { cursor: "turns:2", purpose: "export" },
    ]);
    assert.deepEqual(itemRequests, [{ cursor: "items:1", purpose: "export" }]);
    assert.strictEqual(fixture.aggregate.readCanonicalState(), fixture.canonical);
    assert.strictEqual(fixture.aggregate.readSnapshot(), residentSnapshot);
  }),
);

it.effect("deduplicates inclusive item-page anchors without skipping export items", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const oldest = {
      type: "userMessage",
      id: "oldest",
      clientId: null,
      content: [{ type: "text", text: "oldest", text_elements: [] }],
    } satisfies ThreadItem;
    const middle = {
      questions: null,
      type: "agentMessage",
      id: "middle",
      text: "middle",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies ThreadItem;
    const newest = {
      questions: null,
      type: "agentMessage",
      id: "newest",
      text: "newest",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies ThreadItem;
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Effect.succeed({
          turns: [turn("turn-1", [newest], "summary")],
          nextCursor: null,
          backwardsCursor: null,
          itemsPaginationByTurnId: {
            "turn-1": {
              olderCursor: "items:middle",
              isLoadingOlder: false,
              hasLoadedOldest: false,
              oldestUserInput: oldest.content,
              openingUserMessageId: oldest.id,
              itemsView: "summary" as const,
            },
          },
          itemSegmentsByTurnId: {},
          loadedItemCount: 1,
        }),
      loadTurnItemsPage: (input) =>
        Effect.succeed(
          input.cursor === "items:middle"
            ? {
                items: [middle, newest],
                nextCursor: "items:oldest",
                backwardsCursor: null,
                approximateBytes: 1,
              }
            : {
                items: [oldest, middle],
                nextCursor: null,
                backwardsCursor: null,
                approximateBytes: 1,
              },
        ),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });

    const result = yield* runtime.next({ consumerId: "renderer-1", jobId: started.jobId });

    assert.deepStrictEqual(
      result.turn?.items.map((item) => item.markdownText),
      ["oldest", "middle", "newest"],
    );
    assert.isTrue(result.done);
  }),
);

it.effect("requests at most one physical item page and rejects oversized responses", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const requestedLimits: number[] = [];
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Effect.succeed({
          turns: [turn("turn-1", [], "summary")],
          nextCursor: null,
          backwardsCursor: null,
          itemsPaginationByTurnId: {
            "turn-1": {
              olderCursor: "items:older",
              isLoadingOlder: false,
              hasLoadedOldest: false,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "summary" as const,
            },
          },
          itemSegmentsByTurnId: {},
          loadedItemCount: 0,
        }),
      loadTurnItemsPage: (input) => {
        requestedLimits.push(input.limit ?? -1);
        return Effect.succeed({
          items: Array.from({ length: 101 }, (_, index) => ({
            questions: null,
            type: "agentMessage" as const,
            id: `item-${index}`,
            text: `item-${index}`,
            phase: null,
            memoryCitation: null,
            delivery: null,
          })),
          nextCursor: null,
          backwardsCursor: null,
          approximateBytes: 1,
        });
      },
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });

    const failure = yield* runtime
      .next({ consumerId: "renderer-1", jobId: started.jobId })
      .pipe(Effect.flip);

    assert.deepStrictEqual(requestedLimits, [100]);
    assert.strictEqual(failure.reason, "page-size-exceeded");
  }),
);

it.effect("rejects an advancing duplicate-only item cursor chain", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const newest = {
      questions: null,
      type: "agentMessage",
      id: "newest",
      text: "newest",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies ThreadItem;
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Effect.succeed({
          turns: [turn("turn-1", [newest], "summary")],
          nextCursor: null,
          backwardsCursor: null,
          itemsPaginationByTurnId: {
            "turn-1": {
              olderCursor: "items:first",
              isLoadingOlder: false,
              hasLoadedOldest: false,
              oldestUserInput: null,
              openingUserMessageId: null,
              itemsView: "summary" as const,
            },
          },
          itemSegmentsByTurnId: {},
          loadedItemCount: 1,
        }),
      loadTurnItemsPage: () =>
        Effect.succeed({
          items: [newest],
          nextCursor: "items:second",
          backwardsCursor: null,
          approximateBytes: 1,
        }),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });

    const failure = yield* runtime
      .next({ consumerId: "renderer-1", jobId: started.jobId })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "cursor-stalled");
    assert.match(String(failure.cause), /no unique progress/);
  }),
);

it.effect("fences a stale host generation before reading an export page", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    let current = true;
    let pageRequests = 0;
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () => {
        pageRequests += 1;
        return Effect.die("stale export must not reach the page adapter");
      },
      loadTurnItemsPage: () => Effect.die("unused"),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilityService(() => current),
      ),
    );
    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });
    current = false;
    const error = yield* runtime
      .next({ consumerId: "renderer-1", jobId: started.jobId })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "stale-generation");
    assert.strictEqual(pageRequests, 0);
  }),
);

it.effect("admits concurrent export starts atomically under the global job cap", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const releaseCapabilities = yield* Deferred.make<void>();
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () => Effect.die("unused"),
      loadTurnItemsPage: () => Effect.die("unused"),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capability),
          forThread: () => Deferred.await(releaseCapabilities).pipe(Effect.as(capability)),
          isCurrent: () => Effect.succeed(true),
        }),
      ),
    );
    const fibers = yield* Effect.forEach(
      Array.from({ length: CODEX_HISTORY_EXPORT_MAX_ACTIVE_JOBS + 1 }, (_, index) => index),
      (index) =>
        runtime
          .start({ consumerId: `renderer-${index}`, threadId: "thread-export" })
          .pipe(Effect.forkChild),
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseCapabilities, undefined);
    const started = yield* Effect.forEach(fibers, Fiber.join);

    assert.isFalse(yield* runtime.cancel({ consumerId: "renderer-0", jobId: started[0]!.jobId }));
    for (let index = 1; index < started.length; index += 1) {
      assert.isTrue(
        yield* runtime.cancel({
          consumerId: `renderer-${index}`,
          jobId: started[index]!.jobId,
        }),
      );
    }
  }),
);

it.effect("cancels an in-flight page and discards its eventual response", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const requested = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            turns: [turn("turn-1")],
            nextCursor: null,
            backwardsCursor: null,
            itemsPaginationByTurnId: {
              "turn-1": {
                olderCursor: null,
                isLoadingOlder: false,
                hasLoadedOldest: true,
                oldestUserInput: null,
                openingUserMessageId: null,
                itemsView: "full" as const,
              },
            },
            itemSegmentsByTurnId: {},
            loadedItemCount: 0,
          }),
        ),
      loadTurnItemsPage: () => Effect.die("unused"),
    });
    const runtime = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, fixture.conversations),
      Effect.provideService(CodexHistoryPageAdapter, pages),
      Effect.provideService(CodexAppServerCapabilities, capabilityService()),
    );
    const started = yield* runtime.start({ consumerId: "renderer-1", threadId: "thread-export" });
    const reading = yield* runtime
      .next({ consumerId: "renderer-1", jobId: started.jobId })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(requested);
    assert.isTrue(yield* runtime.cancel({ consumerId: "renderer-1", jobId: started.jobId }));
    yield* Deferred.succeed(release, undefined);
    const error = yield* Fiber.join(reading);
    assert.strictEqual(error.reason, "cancelled");
    assert.strictEqual(fixture.aggregate.readCanonicalState(), fixture.canonical);
  }),
);
