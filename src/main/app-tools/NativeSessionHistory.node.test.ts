import { readSessionHistory } from "./SessionHistoryRead";
import { assert, it } from "@effect/vitest";
import type {
  ThreadItem,
  ThreadItemEntry,
  ThreadItemsListParams,
  ThreadItemsListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import {
  CodexNativeThreadLookup,
  type NativeThreadMatch,
} from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway, type CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { makeNativeSessionHistory } from "./NativeSessionHistory";

const assistant = (id: string, text = id): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const entry = (item: ThreadItem, turnId = "turn:a"): ThreadItemEntry => ({
  turnId,
  item,
  startedAtMs: null,
  completedAtMs: null,
});
const requestError = (code: number, method = "thread/items/list") =>
  new CodexRuntimeError({
    operation: "request",
    reason: "request",
    retryable: false,
    message: "Request failed",
    method,
    cause: new CodexAppServerRequestError({
      code,
      errorMessage: "invalid cursor: history moved",
      method,
      operation: "receive-response",
    }),
  });

const fixture = (initial: ThreadItemEntry[], resolvedHostId = "host:a") => {
  const rows = [...initial];
  const requests: Array<{
    method: string;
    params: ThreadItemsListParams & { itemIds?: string[] };
    scheduling: CodexGatewayRequestOptions | undefined;
  }> = [];
  let current = true;
  let nextError: CodexRuntimeError | null = null;
  // Producer cursors bind a durable item position and whether the anchor is included.
  // This matches thread-store's nextCursor/exclusive and backwardsCursor/inclusive contract.
  const encode = (position: number, inclusive: boolean) => JSON.stringify({ position, inclusive });
  const gateway = CodexGateway.of({
    requestOnHost: (
      _hostId: string,
      method: string,
      params: ThreadItemsListParams & { itemIds?: string[] },
      scheduling?: CodexGatewayRequestOptions,
    ) =>
      Effect.gen(function* () {
        requests.push({ method, params, scheduling });
        if (nextError) {
          const cause = nextError;
          nextError = null;
          return yield* cause;
        }
        if (method === "thread/items/read")
          return {
            data: rows.filter(
              (row) => row.turnId === params.turnId && params.itemIds?.includes(row.item.id),
            ),
          };
        assert.equal(method, "thread/items/list");
        const itemAnchor =
          typeof params.cursor === "object" && params.cursor !== null ? params.cursor : null;
        const itemPosition = itemAnchor
          ? rows.findIndex(
              (row) => row.item.id === itemAnchor.itemId && row.turnId === params.turnId,
            )
          : -1;
        if (itemAnchor && (!params.turnId || itemPosition < 0)) return yield* requestError(-32602);
        const anchor = itemAnchor
          ? { position: itemPosition, inclusive: false }
          : typeof params.cursor === "string"
            ? (JSON.parse(params.cursor) as { position: number; inclusive: boolean })
            : null;
        const descending = params.sortDirection === "desc";
        const indexed = rows
          .map((row, position) => ({ row, position }))
          .filter(({ row, position }) => {
            if (params.turnId && row.turnId !== params.turnId) return false;
            if (anchor === null) return true;
            if (descending)
              return anchor.inclusive ? position <= anchor.position : position < anchor.position;
            return anchor.inclusive ? position >= anchor.position : position > anchor.position;
          });
        const candidates = descending ? indexed.toReversed() : indexed;
        const page = candidates.slice(0, params.limit ?? 1);
        return {
          data: page.map(({ row }) => row),
          nextCursor: candidates.length > page.length ? encode(page.at(-1)!.position, false) : null,
          backwardsCursor: page.length > 0 ? encode(page[0]!.position, true) : null,
        } satisfies ThreadItemsListResponse;
      }),
  } as never);
  const lookup = CodexNativeThreadLookup.of({
    resolve: () =>
      Effect.succeed({
        hostId: resolvedHostId,
        manager: {
          generation: 7,
          assertCurrent: () => {
            if (!current) throw new Error("Host retired");
          },
        },
        thread: { id: "thread:a" },
      } as NativeThreadMatch),
  });
  const resolved = makeNativeSessionHistory.pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexNativeThreadLookup, lookup),
    Effect.flatMap((resolve) => resolve("thread:a", "host:a")),
  );
  const source = resolved.pipe(Effect.map((value) => value.source));
  return {
    rows,
    requests,
    source,
    resolved,
    failNext: (error: CodexRuntimeError) => {
      nextError = error;
    },
    retire: () => {
      current = false;
    },
  };
};

it.effect("recovers the exact native item across appends by canonical Run and item identity", () =>
  Effect.gen(function* () {
    const f = fixture([entry(assistant("older")), entry(assistant("selected", "A😀B\n"))]);
    const source = yield* f.source;
    const page = yield* source.page({
      order: "newest_first",
      view: "messages",
      maxCharsPerItem: 8000,
      limit: 1,
    });
    const reference = page.items[0]!.reference;
    f.rows.push(entry(assistant("newer"), "turn:b"));
    // A fresh adapter instance can resume this address; no source-local registry is involved.
    const reopened = yield* f.source;
    const content = yield* reopened.content({
      locator: reference,
      format: "text",
      offset: 0,
      maxChars: 2,
    });
    const tail = yield* reopened.content({
      locator: reference,
      format: "text",
      offset: content.nextTextOffset!,
      maxChars: 100,
    });
    assert.equal(
      JSON.parse(JSON.stringify(content)).text + JSON.parse(JSON.stringify(tail)).text,
      "A😀B\n",
    );
    assert.equal(content.contentVersion, tail.contentVersion);
    assert.equal(f.requests[0]!.params.sortDirection, "desc");
    assert.equal(f.requests[1]!.method, "thread/items/read");
    assert.deepEqual(f.requests[1]!.params.itemIds, [reference.itemId]);
    assert.deepEqual(f.requests[1]!.scheduling, {
      expectedHostId: "host:a",
      expectedGeneration: 7,
      timeoutMs: 10_000,
    });
    f.rows[1] = entry(assistant("selected", "Changed"));
    const changed = yield* reopened.content({
      locator: reference,
      format: "text",
      offset: 0,
      maxChars: 100,
    });
    assert.notEqual(changed.contentVersion, content.contentVersion);
  }),
);

it.effect("retains native typed activity, status, and complete JSON slice boundaries", () =>
  Effect.gen(function* () {
    const item: ThreadItem = {
      type: "fileChange",
      id: "edit",
      status: "completed",
      changes: [
        {
          path: "src/😀.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-before\n+after\n",
        },
      ],
    };
    const f = fixture([entry(item)]);
    const source = yield* f.source;
    const page = yield* source.page({
      order: "newest_first",
      view: "activity",
      maxCharsPerItem: 8000,
      limit: 1,
    });
    assert.equal(page.items[0]!.reference.status, "completed");
    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const part = yield* source.content({
        locator: page.items[0]!.reference,
        format: "json",
        offset,
        maxChars: 7,
      });
      chunks.push(JSON.parse(JSON.stringify(part)).text);
      if (part.nextTextOffset === null) break;
      offset = part.nextTextOffset;
    }
    assert.deepEqual(JSON.parse(chunks.join("")), item);
    assert.equal(chunks.join("").length, JSON.stringify(item).length);
    f.rows[0] = entry(item, "turn:foreign");
    const moved = yield* source
      .content({ locator: page.items[0]!.reference, format: "json", offset: 0, maxChars: 100 })
      .pipe(Effect.result);
    assert.equal(moved._tag, "Failure");
    if (moved._tag === "Failure") assert.equal(moved.failure.reason, "item_unavailable");
  }),
);

it.effect("keeps cursor failures distinct from unavailable native hosts", () =>
  Effect.gen(function* () {
    const f = fixture([entry(assistant("reply"))]);
    const source = yield* f.source;
    f.failNext(requestError(-32602));
    const invalid = yield* source
      .page({
        order: "newest_first",
        cursor: "bad",
        view: "messages",
        maxCharsPerItem: 8000,
        limit: 1,
      })
      .pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
    if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
    const page = yield* source.page({
      order: "newest_first",
      view: "messages",
      maxCharsPerItem: 8000,
      limit: 1,
    });
    f.failNext(requestError(-32602, "thread/items/read"));
    const stale = yield* source
      .content({ locator: page.items[0]!.reference, format: "text", offset: 0, maxChars: 100 })
      .pipe(Effect.result);
    assert.equal(stale._tag, "Failure");
    if (stale._tag === "Failure") assert.equal(stale.failure.reason, "item_unavailable");
    f.failNext(
      new CodexRuntimeError({
        operation: "request",
        reason: "timeout",
        retryable: true,
        message: "invalid cursor: timeout",
        method: "thread/items/list",
      }),
    );
    const timeout = yield* source
      .page({
        order: "newest_first",
        cursor: "bad",
        view: "messages",
        maxCharsPerItem: 8000,
        limit: 1,
      })
      .pipe(Effect.result);
    assert.equal(timeout._tag, "Failure");
    if (timeout._tag === "Failure") assert.equal(timeout.failure.reason, "history_unavailable");
    f.retire();
    const retired = yield* source
      .page({ order: "newest_first", view: "activity", maxCharsPerItem: 8000, limit: 1 })
      .pipe(Effect.result);
    assert.equal(retired._tag, "Failure");
    if (retired._tag === "Failure") assert.equal(retired.failure.reason, "history_unavailable");
  }),
);

it.effect(
  "reports native progress coverage when tool activity extends beyond its recent window",
  () =>
    Effect.gen(function* () {
      const tools = Array.from({ length: 21 }, (_, index) =>
        entry({ type: "fileChange", id: `edit:${index}`, changes: [], status: "completed" }),
      );
      const f = fixture([entry(assistant("older-reply")), ...tools]);
      const source = yield* f.source;
      const progress = yield* source.progress();
      assert.equal(progress.latestMessage, null);
      assert.equal(progress.coverage, "recent_window");
      assert.isNotNull(progress.nextCursor);
      assert.deepEqual(progress.latestTool, {
        id: "edit:20",
        runId: "turn:a",
        type: "fileChange",
        status: "completed",
      });
      const earlier = yield* source.page({
        order: "newest_first",
        view: "messages",
        maxCharsPerItem: 8000,
        cursor: progress.nextCursor!,
        limit: 3,
      });
      assert.equal(earlier.items[0]?.reference.itemId, "older-reply");
    }),
);

it.effect("refuses a native lookup redirected away from the Core-bound execution host", () =>
  Effect.gen(function* () {
    const f = fixture([entry(assistant("foreign-reply"))], "host:other");
    const resolved = yield* f.source.pipe(Effect.result);
    assert.equal(resolved._tag, "Failure");
    if (resolved._tag === "Failure") assert.equal(resolved.failure.reason, "history_unavailable");
    assert.deepEqual(f.requests, []);
  }),
);

it.effect("resumes a settled forward tail after append without repeating history", () =>
  Effect.gen(function* () {
    const f = fixture([entry(assistant("first")), entry(assistant("second"))]);
    const source = yield* f.source;
    const first = yield* source.page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 1,
    });
    assert.deepEqual(
      first.items.map((row) => row.reference.itemId),
      ["first"],
    );
    const second = yield* source.page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 1,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.items.map((row) => row.reference.itemId),
      ["second"],
    );
    assert.isNull(second.nextCursor);
    assert.isNotNull(second.tailCursor);
    const empty = yield* source.page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 2,
      cursor: second.tailCursor!,
    });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.tailCursor, second.tailCursor);
    f.rows.push(entry(assistant("third"), "turn:b"));
    const appended = yield* (yield* f.source).page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 2,
      cursor: empty.tailCursor!,
    });
    assert.deepEqual(
      appended.items.map((row) => row.reference.itemId),
      ["third"],
    );
    f.rows[1] = entry(assistant("removed-anchor"));
    const missing = yield* source
      .page({
        view: "messages",
        maxCharsPerItem: 8000,
        order: "oldest_first",
        limit: 2,
        cursor: second.tailCursor!,
      })
      .pipe(Effect.result);
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") assert.equal(missing.failure.reason, "cursor_stale");
  }),
);

it.effect("retains an empty native forward position for the first future item", () =>
  Effect.gen(function* () {
    const f = fixture([]);
    const source = yield* f.source;
    const empty = yield* source.page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 2,
    });
    assert.isNotNull(empty.tailCursor);
    f.rows.push(entry(assistant("first")));
    const appended = yield* source.page({
      view: "messages",
      maxCharsPerItem: 8000,
      order: "oldest_first",
      limit: 2,
      cursor: empty.tailCursor!,
    });
    assert.deepEqual(
      appended.items.map((row) => row.reference.itemId),
      ["first"],
    );
  }),
);

it.effect("reuses native page payload and resumes bounded point location after new appends", () =>
  Effect.gen(function* () {
    const f = fixture(
      Array.from({ length: 182 }, (_, i) => entry(assistant(`item:${i}`, `text:${i}`))),
    );
    const read = (
      request: {
        itemId?: string;
        sourceThreadId?: string;
        cursor?: string;
        textOffset?: number;
      } = {},
    ) =>
      f.source.pipe(
        Effect.flatMap((source) =>
          readSessionHistory({
            source,
            binding: "native:a",
            request: { sessionId: "session:a", limit: 3, maxCharsPerItem: 2, ...request },
            wrap: (history) => ({ history }),
          }).pipe(Effect.map((result) => result.history)),
        ),
      );
    const page = yield* read();
    assert.equal(page.availability, "available");
    assert.equal(f.requests.length, 3); // Each first payload is used directly, with no content RPC.
    let point = yield* read({ itemId: "item:1", sourceThreadId: "thread:a", textOffset: 2 });
    assert.equal(f.requests.length, 7);
    assert.equal(point.availability, "available");
    if (point.availability !== "available") throw new Error("Expected available point read");
    assert.equal(point.page.locating, true);
    assert.isEmpty(point.items);
    const continuation = point.page.nextCursor!;
    f.rows.push(entry(assistant("newer")));
    point = yield* read({ cursor: continuation });
    if (point.availability !== "available") throw new Error("Expected available point read");
    assert.equal(point.page.locating, true);
    point = yield* read({ cursor: point.page.nextCursor! });
    if (point.availability !== "available") throw new Error("Expected located point read");
    assert.equal(point.items[0]!.id, "item:1");
    assert.equal(point.items[0]!.content.offset, 2);
    assert.equal(point.items[0]!.content.format, "text");
    if (point.items[0]!.content.format === "text") assert.equal(point.items[0]!.content.text, "xt");
    assert.equal(f.requests.length, 13);
    const resumed = yield* read({ cursor: point.items[0]!.content.nextCursor! });
    if (resumed.availability !== "available") throw new Error("Expected content continuation");
    assert.equal(resumed.items[0]!.runId, "turn:a");
    assert.equal(f.requests.length, 14);
  }),
);

it.effect.each([0, 1, 2])(
  "reads known native Run items in one producer call at both Turn boundaries %#",
  (index) =>
    Effect.gen(function* () {
      const rows = [
        entry(assistant("first")),
        entry(assistant("middle")),
        entry(assistant("last")),
      ];
      const f = fixture(rows);
      const source = yield* f.source;
      const { history: result } = yield* readSessionHistory({
        source,
        binding: "native",
        request: {
          sessionId: "session:a",
          itemId: rows[index]!.item.id,
          sourceThreadId: "thread:a",
          runId: "turn:a",
          maxCharsPerItem: 1,
          limit: 1,
        },
        wrap: (history) => ({ history }),
      });
      if (result.availability !== "available") throw new Error("Expected point item");
      assert.equal(result.items[0]?.id, rows[index]!.item.id);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]!.method, "thread/items/read");
      assert.deepEqual(f.requests[0]!.params.itemIds, [rows[index]!.item.id]);
      assert.equal(f.requests[0]!.params.turnId, "turn:a");
      const { history: continued } = yield* readSessionHistory({
        source,
        binding: "native",
        request: {
          sessionId: "session:a",
          cursor: result.items[0]!.content.nextCursor!,
          maxCharsPerItem: 50,
          limit: 1,
        },
        wrap: (history) => ({ history }),
      });
      if (continued.availability !== "available") throw new Error("Expected continuation");
      assert.equal(continued.items[0]?.id, rows[index]!.item.id);
      assert.equal(f.requests.length, 2);
      const wrong = yield* readSessionHistory({
        source,
        binding: "native",
        request: {
          sessionId: "session:a",
          itemId: rows[index]!.item.id,
          runId: "wrong",
          maxCharsPerItem: 1,
          limit: 1,
        },
        wrap: (history) => ({ history }),
      }).pipe(Effect.result);
      assert.equal(wrong._tag, "Failure");
      if (wrong._tag === "Failure") assert.equal(wrong.failure.reason, "item_unavailable");
    }),
);

it.effect("reads singleton Turns and reports canonical withdrawal as a point miss", () =>
  Effect.gen(function* () {
    const f = fixture([entry(assistant("only"))]);
    const resolved = yield* f.resolved;
    const selected = yield* resolved.readItem({ itemId: "only", runId: "turn:a" });
    assert.equal(selected.entry.item.id, "only");
    assert.equal(selected.reference.runId, "turn:a");
    assert.equal(f.requests.length, 1);
    f.rows.length = 0;
    const withdrawn = yield* resolved
      .readItem({ itemId: "only", runId: "turn:a" })
      .pipe(Effect.result);
    assert.equal(withdrawn._tag, "Failure");
    if (withdrawn._tag === "Failure") assert.equal(withdrawn.failure.reason, "item_unavailable");
  }),
);
