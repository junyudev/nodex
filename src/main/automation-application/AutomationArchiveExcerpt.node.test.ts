import { assert, it } from "@effect/vitest";
import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import {
  CodexHistoryPageAdapter,
  make as makeHistoryPageAdapter,
} from "../codex-application/CodexHistoryPageAdapter";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT,
  AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT,
  readBoundedAutomationArchiveExcerpt,
} from "./AutomationArchiveExcerpt";

const completedTurn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const fillerItem = (id: string): ThreadItem => ({ type: "contextCompaction", id });

const userItem = (id: string, text: string): ThreadItem => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

const assistantItem = (id: string, text: string): ThreadItem => ({
  questions: null,
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
});

interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const capability = {
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.145.0-alpha.15",
  version: "0.145.0-alpha.15",
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences: true,
    ephemeralFork: false,
    multiAgentV2Protocol: false,
    sideConversation: false,
    subagentAncestorFilter: false,
    threadRevert: false,
  },
} satisfies CodexAppServerCapabilitySnapshot;

const makeCapabilities = (
  isCurrent: () => boolean = () => true,
): CodexAppServerCapabilities["Service"] =>
  CodexAppServerCapabilities.of({
    forHost: () => Effect.succeed(capability),
    forThread: () => Effect.succeed(capability),
    isCurrent: () => Effect.sync(isCurrent),
  });

const makePagedHistory = (input: {
  readonly items: readonly ThreadItem[];
  readonly requests: RecordedRequest[];
}) => {
  const gateway = CodexGateway.of({
    requestForThread: (_threadId: string, method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        input.requests.push({ method, params });
        if (method === "thread/turns/list") {
          return {
            data: [completedTurn("turn-giant")],
            nextCursor: null,
            backwardsCursor: null,
          };
        }

        const cursor = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const limit = Number(params.limit);
        const descending = [...input.items].reverse();
        const data = descending.slice(cursor, cursor + limit).map((item) => ({
          turnId: "turn-giant",
          item,
        }));
        const nextOffset = cursor + data.length;
        return {
          data,
          nextCursor: nextOffset < descending.length ? String(nextOffset) : null,
          backwardsCursor: cursor > 0 ? String(Math.max(0, cursor - limit)) : null,
        };
      }) as never,
  } as unknown as CodexGateway["Service"]);
  return makeHistoryPageAdapter.pipe(Effect.provideService(CodexGateway, gateway));
};

it.effect("finds the newest semantic exchange without hydrating the giant Turn", () =>
  Effect.gen(function* () {
    const requests: RecordedRequest[] = [];
    const items = [
      ...Array.from({ length: 698 }, (_, index) => fillerItem(`filler-${index}`)),
      userItem("user-latest", "latest request"),
      assistantItem("assistant-latest", "latest response"),
    ];
    const pages = yield* makePagedHistory({ items, requests });

    const result = yield* readBoundedAutomationArchiveExcerpt(
      pages,
      makeCapabilities(),
      "thread-giant",
    );

    assert.deepStrictEqual(result.messages, {
      archivedUserMessage: "latest request",
      archivedAssistantMessage: "latest response",
    });
    assert.strictEqual(result.resolution, "satisfied");
    assert.strictEqual(result.truncationReason, null);
    assert.strictEqual(result.inspectedTurnCount, 1);
    assert.strictEqual(result.inspectedItemCount, 100);
    assert.deepStrictEqual(
      requests.map(({ method, params }) => ({
        method,
        limit: params.limit,
        itemsView: params.itemsView,
      })),
      [
        { method: "thread/turns/list", limit: 5, itemsView: "notLoaded" },
        { method: "thread/items/list", limit: 100, itemsView: undefined },
      ],
    );
  }),
);

it.effect("stops a giant Turn at the aggregate item budget and reports truncation stably", () =>
  Effect.gen(function* () {
    const items = Array.from({ length: 700 }, (_, index) => fillerItem(`filler-${index}`));
    const firstRequests: RecordedRequest[] = [];
    const firstPages = yield* makePagedHistory({ items, requests: firstRequests });
    const first = yield* readBoundedAutomationArchiveExcerpt(
      firstPages,
      makeCapabilities(),
      "thread-giant",
    );
    const secondRequests: RecordedRequest[] = [];
    const secondPages = yield* makePagedHistory({ items, requests: secondRequests });
    const second = yield* readBoundedAutomationArchiveExcerpt(
      secondPages,
      makeCapabilities(),
      "thread-giant",
    );

    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.resolution, "truncated");
    assert.strictEqual(first.truncationReason, "item-limit");
    assert.strictEqual(first.inspectedItemCount, AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT);
    assert.isAtMost(first.approximateProjectedBytes, AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT);
    const itemRequests = firstRequests.filter(({ method }) => method === "thread/items/list");
    assert.strictEqual(itemRequests.length, 5);
    assert.isTrue(itemRequests.every(({ params }) => Number(params.limit) <= 100));
  }),
);

it.effect("rejects an indivisible item page above the projected byte budget as truncated", () =>
  Effect.gen(function* () {
    const requests: RecordedRequest[] = [];
    const pages = yield* makePagedHistory({
      items: [assistantItem("assistant-oversized", "x".repeat(3 * 1024 * 1024))],
      requests,
    });

    const result = yield* readBoundedAutomationArchiveExcerpt(
      pages,
      makeCapabilities(),
      "thread-giant",
    );

    assert.strictEqual(result.resolution, "truncated");
    assert.strictEqual(result.truncationReason, "byte-limit");
    assert.strictEqual(result.inspectedItemCount, 0);
    assert.strictEqual(result.approximateProjectedBytes, 0);
    assert.isTrue(
      requests
        .filter(({ method }) => method === "thread/items/list")
        .every(({ params }) => Number(params.limit) <= 100),
    );
  }),
);

it.effect("marks an unexhausted outer history window as turn-limited", () =>
  Effect.gen(function* () {
    const requests: RecordedRequest[] = [];
    const turns = Array.from({ length: 21 }, (_, index) => completedTurn(`turn-${index}`));
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          requests.push({ method, params });
          if (method === "thread/items/list") {
            return { data: [], nextCursor: null, backwardsCursor: null };
          }
          const cursor = typeof params.cursor === "string" ? Number(params.cursor) : 0;
          const limit = Number(params.limit);
          const descending = [...turns].reverse();
          const data = descending.slice(cursor, cursor + limit);
          const nextOffset = cursor + data.length;
          return {
            data,
            nextCursor: nextOffset < descending.length ? String(nextOffset) : null,
            backwardsCursor: cursor > 0 ? String(Math.max(0, cursor - limit)) : null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const pages: CodexHistoryPageAdapter["Service"] = yield* makeHistoryPageAdapter.pipe(
      Effect.provideService(CodexGateway, gateway),
    );

    const result = yield* readBoundedAutomationArchiveExcerpt(
      pages,
      makeCapabilities(),
      "thread-many-turns",
    );

    assert.strictEqual(result.resolution, "truncated");
    assert.strictEqual(result.truncationReason, "turn-limit");
    assert.strictEqual(result.inspectedTurnCount, 20);
    assert.isTrue(
      requests
        .filter(({ method }) => method === "thread/turns/list")
        .every(({ params }) => params.itemsView === "notLoaded" && Number(params.limit) <= 5),
    );
  }),
);

it.effect("bounds physical pagination when an advancing server page makes no item progress", () =>
  Effect.gen(function* () {
    let itemRequests = 0;
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            return {
              data: [completedTurn("turn-empty-pages")],
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          itemRequests += 1;
          return {
            data: [],
            nextCursor: `items:${itemRequests}`,
            backwardsCursor: params.cursor ?? null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const pages = yield* makeHistoryPageAdapter.pipe(Effect.provideService(CodexGateway, gateway));

    const result = yield* readBoundedAutomationArchiveExcerpt(
      pages,
      makeCapabilities(),
      "thread-empty-pages",
    );

    assert.strictEqual(result.resolution, "truncated");
    assert.strictEqual(result.truncationReason, "pagination-limit");
    assert.strictEqual(itemRequests, 20);
    assert.strictEqual(result.inspectedItemCount, 0);
  }),
);

it.effect("rejects an item page returned by a replaced app-server generation", () =>
  Effect.gen(function* () {
    let current = true;
    let itemRequests = 0;
    const pages = CodexHistoryPageAdapter.of({
      loadTurnPage: () =>
        Effect.succeed({
          turns: [completedTurn("turn-stale")],
          nextCursor: null,
          backwardsCursor: null,
          itemsPaginationByTurnId: {},
          itemSegmentsByTurnId: {},
          loadedItemCount: 0,
        }),
      loadTurnItemsPage: () =>
        Effect.sync(() => {
          itemRequests += 1;
          current = false;
          return {
            items: [assistantItem("assistant-stale", "must not be accepted")],
            nextCursor: null,
            backwardsCursor: null,
            approximateBytes: 1_024,
          };
        }),
    });

    const failure = yield* Effect.flip(
      readBoundedAutomationArchiveExcerpt(
        pages,
        makeCapabilities(() => current),
        "thread-stale",
      ),
    );

    assert.strictEqual(failure._tag, "AutomationArchiveExcerptError");
    assert.strictEqual(failure.reason, "stale-generation");
    assert.strictEqual(itemRequests, 1);
  }),
);
