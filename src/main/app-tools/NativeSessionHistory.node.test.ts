import { describe } from "vite-plus/test";
import {
  readSessionHistory,
  readSessionProgress,
  SESSION_READ_MAX_BYTES,
  type SessionHistoryInput,
  type SessionHistorySource,
  type SessionItemReference,
} from "./SessionHistoryRead";
import { assert, it } from "@effect/vitest";
import type {
  ThreadItem,
  ThreadItemEntry,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
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
import { createHash } from "node:crypto";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import type {
  SessionHistory,
  SessionHistoryItem,
} from "../../shared/nodex-app-tools/session-history";
import { toolResultBytes } from "./app-tool-result";
import { writeFile } from "node:fs/promises";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { make, nativeSessionAttachmentResource } from "./NativeSessionMessageAttachments";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { runtimeSessionHistory } from "./RuntimeSessionHistory";
import { make as makeNativeSessionExecution } from "./NativeSessionExecution";

describe("NativeSessionHistory", () => {
  const assistant = (id: string, text = id): ThreadItem => ({
    type: "agentMessage",
    moderation: null,
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
    const encode = (position: number, inclusive: boolean) =>
      JSON.stringify({ position, inclusive });
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
          if (itemAnchor && (!params.turnId || itemPosition < 0))
            return yield* requestError(-32602);
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
            nextCursor:
              candidates.length > page.length ? encode(page.at(-1)!.position, false) : null,
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

  it.effect(
    "recovers the exact native item across appends by canonical Run and item identity",
    () =>
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
      if (point.items[0]!.content.format === "text")
        assert.equal(point.items[0]!.content.text, "xt");
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
});

describe("SessionHistoryRead", () => {
  const fixture = (texts: string[], idLength = 0) => {
    const rows: Array<{
      reference: SessionItemReference;
      value: { type: string; text: string; attachments: Array<{ path: string; mimeType: string }> };
    }> = texts.map((text, index) => ({
      reference: {
        itemId: `item:${index}:${"x".repeat(idLength)}`,
        sourceThreadId: "source:parent",
        runId: "run:one",
        type: "message",
        status: "completed",
      } satisfies SessionItemReference,
      value: {
        type: "message",
        text,
        attachments: [{ path: "/tmp/原文😀.txt", mimeType: "text/plain" }],
      },
    }));
    const source: SessionHistorySource = {
      kind: "runtime",
      page: ({ cursor, limit }) =>
        Effect.sync(() => {
          const start = cursor === undefined ? 0 : Number(cursor);
          const selected = rows.slice(start, start + limit);
          return {
            items: selected.map((row, index) => ({
              reference: row.reference,
              after: String(start + index + 1),
            })),
            nextCursor:
              start + selected.length < rows.length ? String(start + selected.length) : null,
            tailCursor: String(start + selected.length),
          };
        }),
      content: ({ locator, format, offset, maxChars }) =>
        Effect.sync(() => {
          const row = rows.find((row) => row.reference.itemId === locator.itemId)!;
          const text = format === "text" ? row.value.text : JSON.stringify(row.value);
          const start = Math.min(offset, text.length);
          const end = Math.min(start + maxChars, text.length);
          return {
            reference: row.reference,
            text: text.slice(start, end),
            textOffset: start,
            totalChars: text.length,
            nextTextOffset: end < text.length ? end : null,
            contentVersion: createHash("sha256").update(text).digest("hex"),
          };
        }),
      progress: () =>
        Effect.gen(function* () {
          const row = rows[0];
          return {
            coverage: "complete" as const,
            nextCursor: null,
            latestTool: null,
            latestMessage: row
              ? {
                  reference: row.reference,
                  content: yield* source.content({
                    locator: row.reference,
                    format: "text",
                    offset: 0,
                    maxChars: 160,
                  }),
                }
              : null,
          };
        }),
    };
    const wrap = (history: SessionHistory) => ({
      schemaVersion: 2,
      sessionId: "session:a",
      title: "Content",
      history,
    });
    const read = (request: Partial<SessionHistoryInput> = {}) =>
      readSessionHistory({
        source,
        binding: "binding:a",
        wrap,
        request: { sessionId: "session:a", limit: 50, maxCharsPerItem: 8000, ...request },
      }).pipe(
        Effect.map((result) => result.history),
        Effect.tap((history) =>
          Effect.sync(() => {
            assert.isAtMost(toolResultBytes(wrap(history)), SESSION_READ_MAX_BYTES);
            if (history.availability !== "available") return;
            for (const cursor of [
              history.page.nextCursor,
              ...history.items.map((item) => item.content.nextCursor),
            ]) {
              if (cursor === null) continue;
              assert.isTrue(sessionObservationSchemas.read_session.safeParse({ cursor }).success);
            }
          }),
        ),
      );
    return { rows, source, read };
  };
  const available = (history: SessionHistory) => {
    assert.equal(history.availability, "available");
    if (history.availability !== "available") throw new Error("Expected available history");
    return history;
  };
  const first = (history: SessionHistory): SessionHistoryItem => {
    const item = available(history).items[0];
    assert.isDefined(item);
    return item!;
  };

  it.effect("packs complete envelopes and continues every omitted item without loss", () =>
    Effect.gen(function* () {
      const f = fixture(
        Array.from({ length: 130 }, (_, index) => `message:${index}\n${'漢😀\\"'.repeat(300)}`),
        180,
      );
      const found: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = available(yield* f.read(cursor === null ? {} : { cursor }));
        assert.isAbove(page.items.length, 0);
        found.push(...page.items.map((item) => item.id));
        assert.notEqual(page.page.nextCursor, cursor === null ? "initial" : cursor);
        cursor = page.page.nextCursor;
        pages += 1;
        assert.isBelow(pages, 131);
      } while (cursor !== null);
      assert.isAbove(pages, 3);
      assert.deepEqual(
        found,
        f.rows.map((row) => row.reference.itemId),
      );
    }),
  );

  it.effect("reassembles oversized Unicode messages through fresh stateless continuations", () =>
    Effect.gen(function* () {
      const original = '多语言😀\n\\"'.repeat(9000);
      const f = fixture([original, "older"]);
      const page = available(yield* f.read({ limit: 1 }));
      const item = first(page);
      assert.isNotNull(page.page.nextCursor);
      let current = item;
      let text = "";
      for (let count = 0; ; count++) {
        assert.isBelow(count, 200);
        assert.equal(current.id, item.id);
        assert.equal(current.content.offset, text.length);
        assert.equal(current.content.format, "text");
        if (current.content.format !== "text") throw new Error("Expected text");
        // Exercise JSON transport, including a split UTF-16 surrogate pair.
        text += (JSON.parse(JSON.stringify(current.content)) as { text: string }).text;
        if (!current.content.nextCursor) break;
        current = first(yield* f.read({ cursor: current.content.nextCursor }));
      }
      assert.equal(text, original);
      assert.equal(first(yield* f.read({ cursor: page.page.nextCursor! })).content.format, "text");
      const tiny = first(yield* f.read({ limit: 1, maxCharsPerItem: 1 }));
      assert.deepEqual({ ...tiny, content: null }, { ...item, content: null });
    }),
  );

  it.effect("activity fragments and complete items describe the same full typed value", () =>
    Effect.gen(function* () {
      const f = fixture(['"😀\n'.repeat(100)]);
      const whole = first(yield* f.read({ view: "activity" }));
      assert.equal(whole.content.format, "json");
      if (whole.content.format !== "json") throw new Error("Expected JSON");
      let item = first(yield* f.read({ view: "activity", maxCharsPerItem: 1 }));
      let text = "";
      for (let count = 0; ; count++) {
        assert.isBelow(count, 2000);
        assert.equal(item.content.offset, text.length);
        assert.equal(item.content.format, "json_fragment");
        if (item.content.format !== "json_fragment") throw new Error("Expected JSON fragment");
        text += (JSON.parse(JSON.stringify(item.content)) as { text: string }).text;
        if (!item.content.nextCursor) break;
        item = first(yield* f.read({ cursor: item.content.nextCursor, maxCharsPerItem: 7 }));
      }
      assert.deepEqual(JSON.parse(text), whole.content.value);
      assert.deepEqual(JSON.parse(text), { source: "runtime", item: f.rows[0]!.value });
    }),
  );

  it.effect("rejects changed content before interpreting obsolete offsets", () =>
    Effect.gen(function* () {
      for (const view of ["messages", "activity"] as const) {
        const f = fixture(["long".repeat(4000)]);
        const item = first(yield* f.read({ view, maxCharsPerItem: 6000 }));
        f.rows[0]!.value.text = "short";
        const changed = yield* f.read({ cursor: item.content.nextCursor! }).pipe(Effect.result);
        assert.equal(changed._tag, "Failure");
        if (changed._tag === "Failure") assert.equal(changed.failure.reason, "cursor_stale");
      }
    }),
  );

  it.effect("binds both continuation kinds to the Session, execution and view", () =>
    Effect.gen(function* () {
      const f = fixture(["long".repeat(4000), "older"]);
      const page = available(yield* f.read({ limit: 1 }));
      for (const cursor of [page.page.nextCursor!, first(page).content.nextCursor!]) {
        for (const request of [{ sessionId: "session:other" }, { view: "activity" as const }]) {
          const invalid = yield* f.read({ cursor, ...request }).pipe(Effect.result);
          assert.equal(invalid._tag, "Failure");
          if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
        }
        const rebound = yield* readSessionHistory({
          request: { sessionId: "session:a", cursor, limit: 1, maxCharsPerItem: 20 },
          source: f.source,
          binding: "binding:other",
          wrap: (history) => ({ history }),
        }).pipe(Effect.result);
        assert.equal(rebound._tag, "Failure");
        if (rebound._tag === "Failure") assert.equal(rebound.failure.reason, "invalid_cursor");
      }
    }),
  );

  it.effect("refuses an unreadable generated cursor instead of returning a dead continuation", () =>
    Effect.gen(function* () {
      const f = fixture(["long".repeat(4000)], 4096);
      const result = yield* f.read({ maxCharsPerItem: 1 }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "source_limit");
    }),
  );

  it.effect("rejects a content format conflicting with its view before reading source data", () =>
    Effect.gen(function* () {
      const f = fixture(["text".repeat(4000)]);
      const item = first(yield* f.read());
      const cursor = JSON.parse(
        Buffer.from(item.content.nextCursor!.slice(5), "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const malformed = `nxh2.${Buffer.from(JSON.stringify({ ...cursor, format: "json" })).toString("base64url")}`;
      const invalid = yield* f.read({ cursor: malformed }).pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
    }),
  );

  it.effect("returns compact progress with a usable full-message continuation", () =>
    Effect.gen(function* () {
      const original = "reply😀".repeat(4000);
      const f = fixture([original]);
      const progress = yield* readSessionProgress({
        source: f.source,
        sessionId: "session:a",
        binding: "binding:a",
      });
      assert.equal(progress.coverage, "complete");
      const content = progress.latestMessage?.content;
      assert.equal(content?.format, "text");
      if (content?.format !== "text") throw new Error("Expected text progress");
      assert.equal(content.text.length, 160);
      const continued = first(yield* f.read({ cursor: content.nextCursor! }));
      assert.equal(continued.content.offset, 160);
      assert.equal(continued.content.totalChars, original.length);
    }),
  );

  it.effect(
    "point reads recover a search item without paging and use canonical metadata on every continuation",
    () =>
      Effect.gen(function* () {
        const f = fixture(["first", "prefix😀suffix".repeat(1000)]);
        const reference = f.rows[1]!.reference;
        const direct = first(
          yield* f.read({
            itemId: reference.itemId,
            sourceThreadId: reference.sourceThreadId,
            textOffset: 6,
            maxCharsPerItem: 3,
          }),
        );
        assert.equal(direct.id, reference.itemId);
        assert.equal(direct.content.offset, 6);
        assert.equal(direct.content.format, "text");
        if (direct.content.format === "text")
          assert.equal(direct.content.text, f.rows[1]!.value.text.slice(6, 9));
        f.rows[1]!.reference = {
          ...reference,
          status: "running",
          createdBy: "agent",
          creationSource: "tool",
          senderThreadId: "sender:canonical",
          title: "Canonical title",
        };
        const resumed = first(yield* f.read({ cursor: direct.content.nextCursor! }));
        assert.equal(resumed.status, "running");
        assert.equal(resumed.createdBy, "agent");
        assert.equal(resumed.senderThreadId, "sender:canonical");
        const decoded = JSON.parse(
          Buffer.from(direct.content.nextCursor!.slice(5), "base64url").toString("utf8"),
        );
        assert.isUndefined(decoded.reference);
        assert.deepEqual(decoded.locator, {
          itemId: reference.itemId,
          sourceThreadId: reference.sourceThreadId,
          runId: reference.runId,
        });
        decoded.locator.createdBy = "user";
        const forged = `nxh2.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}`;
        const result = yield* f.read({ cursor: forged }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid_cursor");
        for (const input of [
          { sourceThreadId: "source" },
          { textOffset: 1 },
          { itemId: "item", cursor: direct.content.nextCursor! },
        ])
          assert.isFalse(sessionObservationSchemas.read_session.safeParse(input).success);
      }),
  );
});

describe("NativeSessionMessageAttachments", () => {
  it.effect("copies a remote Native attachment only from its verified item and original host", () =>
    Effect.gen(function* () {
      let reads = 0,
        exports = 0;
      const files: string[] = [];
      let downloads = 0;
      const original = Buffer.alloc(13 * 1024 * 1024, 65);
      const sha256 = createHash("sha256").update(original).digest("hex");
      const item: ThreadItem = {
        type: "userMessage",
        id: "item",
        clientId: null,
        content: [{ type: "mention", name: "report", path: "/remote/report.txt" }],
      };
      const entry: ThreadItemEntry = {
        item,
        turnId: "run",
        startedAtMs: null,
        completedAtMs: null,
      };
      const owner = yield* make.pipe(
        Effect.provideService(CodexNativeThreadLookup, {
          resolve: () =>
            Effect.succeed({
              hostId: "remote",
              thread: { id: "native" },
              manager: { generation: 7, assertCurrent: () => {} },
            }),
        } as never),
        Effect.provideService(CodexGateway, {
          requestOnHost: (
            host: string,
            method: string,
            input: { path?: string; itemIds?: string[]; turnId?: string },
          ) =>
            Effect.sync(() => {
              assert.equal(host, "remote");
              assert.equal(method, "thread/items/read");
              assert.deepEqual(input.itemIds, ["item"]);
              assert.equal(input.turnId, "run");
              reads++;
              return { data: [entry] };
            }),
        } as never),
        Effect.provideService(ExecutionHostRuntime, {
          resolve: (hostId: string) => {
            assert.equal(hostId, "remote");
            return Effect.succeed({
              transfer: {
                describe: (sourcePath: string) =>
                  Effect.sync(() => {
                    files.push(sourcePath);
                    return { path: sourcePath, sha256, size: original.length };
                  }),
                download: (input: {
                  source: { path: string; sha256: string; size: number };
                  destinationPath: string;
                }) =>
                  Effect.promise(async () => {
                    assert.equal(input.source.path, "/remote/report.txt");
                    downloads++;
                    await writeFile(input.destinationPath, original);
                    return { ...input.source, path: input.destinationPath };
                  }),
              },
            });
          },
        } as never),
        Effect.provideService(TemporaryAssets, {
          saveUploadedResource: (resource: { bytes: Buffer; mimeType: string }) => {
            exports++;
            assert.isTrue(resource.bytes.equals(original));
            assert.equal(resource.mimeType, "text/plain");
            return Promise.resolve({ fileName: "retained.txt" });
          },
          resolveAssetPath: () => "/profile/cache/retained.txt",
        } as never),
      );
      const resource = yield* owner({
        hostId: "remote",
        threadId: "native",
        itemId: "item",
        runId: "run",
        attachmentId: "input:0",
      });
      assert.equal(reads, 2);
      assert.deepEqual(files, ["/remote/report.txt"]);
      assert.equal(
        downloads,
        1,
        "Large files use the streaming owner instead of a Base64 RPC frame",
      );
      assert.equal(exports, 1);
      assert.deepEqual(resource, {
        name: "report",
        mimeType: "text/plain",
        sizeBytes: original.length,
        source: "/profile/cache/retained.txt",
      });
      const invalid = yield* owner({
        hostId: "remote",
        threadId: "native",
        itemId: "item",
        runId: "run",
        attachmentId: "input:99",
      }).pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      assert.equal(exports, 1, "An invalid reference never exports bytes");
    }),
  );

  it("maps only producer-owned Native attachment coordinates", () => {
    const item: ThreadItem = {
      type: "userMessage",
      id: "message",
      clientId: null,
      content: [
        { type: "text", text: "/private/file", text_elements: [] },
        { type: "localImage", path: "/image.png" },
        { type: "image", fileId: "provider-file" },
      ],
    };
    assert.isNull(nativeSessionAttachmentResource(item, "input:0"));
    assert.deepEqual(nativeSessionAttachmentResource(item, "input:1"), {
      name: "image.png",
      source: "/image.png",
    });
    assert.isNull(nativeSessionAttachmentResource(item, "input:2"));
    assert.isNull(nativeSessionAttachmentResource(item, "/arbitrary/path"));
    assert.deepEqual(
      nativeSessionAttachmentResource(
        {
          generationId: null,
          type: "imageGeneration",
          id: "generated",
          status: "completed",
          revisedPrompt: null,
          result: "AQID",
          failure: null,
        },
        "image",
      ),
      { name: "Generated image.png", source: "data:image/png;base64,AQID", mimeType: "image/png" },
    );
  });
});

describe("RuntimeSessionHistory", () => {
  it.effect.each([undefined, { threadId: "runtime:child" }])(
    "continues Runtime windows by exact source identity and reports removed anchors with execution=%j",
    (execution) =>
      Effect.gen(function* () {
        const calls: unknown[] = [];
        let missing = false;
        const source = runtimeSessionHistory(
          {
            timeline: (input: unknown) =>
              Effect.sync(() => {
                calls.push(input);
                if (missing)
                  return { items: [], totalItems: 1, hasMore: false, anchorFound: false };
                return {
                  items: [
                    {
                      sourceThreadId: "captured:parent",
                      sourceItemId: "item:selected",
                      position: 7,
                      visibility: "inherited",
                      item: {
                        id: "item:selected",
                        runId: "run:selected",
                        type: "assistant_message",
                        status: "completed",
                        updatedAt: "2026-10-27T00:00:00.000Z",
                      },
                    },
                  ],
                  totalItems: 9,
                  hasMore: true,
                  anchorFound: true,
                };
              }),
          } as unknown as AgentRuntimeApplication["Service"],
          "session:a",
          undefined,
          execution,
        );
        const first = yield* source.page({
          order: "newest_first",
          view: "messages",
          maxCharsPerItem: 8000,
          limit: 1,
        });
        assert.deepEqual(first.items[0]?.reference, {
          itemId: "item:selected",
          sourceThreadId: "captured:parent",
          runId: "run:selected",
          type: "assistant_message",
          status: "completed",
          visibility: "inherited",
          updatedAt: "2026-10-27T00:00:00.000Z",
        });
        yield* source.page({
          order: "newest_first",
          view: "messages",
          maxCharsPerItem: 8000,
          limit: 1,
          cursor: first.nextCursor!,
        });
        assert.deepEqual(calls[1], {
          sessionId: "session:a",
          ...(execution ? { threadId: execution.threadId } : {}),
          view: "messages",
          order: "newest_first",
          limit: 1,
          beforeItem: { sourceThreadId: "captured:parent", sourceItemId: "item:selected" },
        });
        const forward = yield* source.page({
          order: "oldest_first",
          view: "messages",
          maxCharsPerItem: 8000,
          limit: 1,
          cursor: first.tailCursor!,
        });
        assert.isNotNull(forward.tailCursor);
        assert.deepEqual(calls[2], {
          sessionId: "session:a",
          ...(execution ? { threadId: execution.threadId } : {}),
          view: "messages",
          order: "oldest_first",
          limit: 1,
          afterItem: { sourceThreadId: "captured:parent", sourceItemId: "item:selected" },
        });
        missing = true;
        const stale = yield* source
          .page({
            order: "newest_first",
            view: "messages",
            maxCharsPerItem: 8000,
            limit: 1,
            cursor: first.nextCursor!,
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.equal(stale.failure.reason, "cursor_stale");
        const invalid = yield* source
          .page({
            order: "newest_first",
            view: "messages",
            maxCharsPerItem: 8000,
            limit: 1,
            cursor: "7",
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
      }),
  );
});

describe("NativeSessionExecution", () => {
  const make = makeNativeSessionExecution;
  const fixture = (pages: readonly ThreadTurnsListResponse[]) => {
    const requests: Array<{ cursor: string | null; limit: number; itemsView: string }> = [];
    const read = make.pipe(
      Effect.provideService(CodexNativeThreadLookup, {
        resolve: () =>
          Effect.succeed({ hostId: "host:a", manager: { generation: 2, assertCurrent: () => {} } }),
      } as never),
      Effect.provideService(CodexGateway, {
        requestOnHost: (
          _host: string,
          method: string,
          input: { cursor: string | null; limit: number; itemsView: string },
        ) =>
          Effect.sync(() => {
            assert.equal(method, "thread/turns/list");
            requests.push(input);
            return pages[Math.min(requests.length - 1, pages.length - 1)];
          }),
      } as never),
    );
    return { read, requests };
  };
  const page = (id: string, cursor: string | null): ThreadTurnsListResponse => ({
    data: [
      {
        id,
        rootTurnId: null,
        status: "completed",
        error: null,
        items: [],
        itemsView: "notLoaded",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    ],
    nextCursor: cursor,
    backwardsCursor: "inclusive",
  });

  it.effect(
    "finds an explicitly requested old Turn beyond retained history using metadata pages",
    () =>
      Effect.gen(function* () {
        const f = fixture([page("turn:new", "next"), page("turn:old", null)]);
        const read = yield* f.read;
        const result = yield* read({ threadId: "thread:a", hostId: "host:a", runId: "turn:old" });
        assert.equal(result.selectedRunId, "turn:old");
        assert.equal(result.status, "completed");
        assert.deepEqual(
          f.requests.map((request) => request.cursor),
          [null, "next"],
        );
        assert.isTrue(f.requests.every((request) => request.itemsView === "notLoaded"));
      }),
  );
  it.effect("selects the latest Turn once and preserves an explicitly empty selection", () =>
    Effect.gen(function* () {
      const f = fixture([page("turn:new", "older")]);
      const read = yield* f.read;
      assert.equal((yield* read({ threadId: "thread:a" })).runId, "turn:new");
      assert.equal(f.requests[0]?.limit, 1);
      assert.equal((yield* read({ threadId: "thread:a", runId: null })).runId, null);
      assert.equal(f.requests.length, 1);
    }),
  );
  it.effect("distinguishes missing Turns, host rebinding and a non-advancing native source", () =>
    Effect.gen(function* () {
      const f = fixture([page("turn:new", null)]);
      const read = yield* f.read;
      assert.equal(
        (yield* read({ threadId: "thread:a", runId: "missing" }).pipe(Effect.flip)).reason,
        "item_unavailable",
      );
      assert.equal(
        (yield* read({ threadId: "thread:a", hostId: "host:other" }).pipe(Effect.flip)).reason,
        "history_unavailable",
      );
      const stuck = yield* fixture([page("turn:new", "same")]).read;
      assert.equal(
        (yield* stuck({ threadId: "thread:a", runId: "missing" }).pipe(Effect.flip)).reason,
        "history_unavailable",
      );
    }),
  );

  it.effect("normalizes an omitted native page cursor to exhaustion", () =>
    Effect.gen(function* () {
      const f = fixture([
        { ...page("turn:new", null), nextCursor: undefined } as unknown as ThreadTurnsListResponse,
      ]);
      const read = yield* f.read;
      assert.equal(
        (yield* read({ threadId: "thread:a", runId: "missing" }).pipe(Effect.flip)).reason,
        "item_unavailable",
      );
      assert.equal(f.requests.length, 1);
    }),
  );
});
