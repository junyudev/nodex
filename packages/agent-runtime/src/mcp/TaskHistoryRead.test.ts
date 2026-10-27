import { assert, it } from "@effect/vitest";
import { NodeId, ThreadId, TurnItemId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { History } from "../nodex/history-contracts.ts";
import {
  historyResultBytes,
  HISTORY_READ_MAX_BYTES,
  readHistory,
  type HistoryInput,
} from "../nodex/HistoryRead.ts";
import { taskHistorySource } from "./TaskHistoryRead.ts";

const now = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
const threadId = ThreadId.make("task:history");
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
const item = (id: string, text: string) =>
  decodeItem({
    id: TurnItemId.make(id),
    type: "dynamic_tool",
    threadId,
    runId: null,
    nodeId: NodeId.make("tool:node"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Exact tool result",
    toolName: "capture",
    input: { code: "capture()" },
    output: { text, structuredContent: { retained: [1, true, null] } },
    mcpToolCall: {
      type: "mcpToolCall",
      id: "native:item",
      server: "browser",
      tool: "capture",
      status: "completed",
      arguments: {},
      result: {
        content: [{ type: "image", mimeType: "image/png", data: "AQID" }],
        _meta: { extension: { kept: true } },
      },
    },
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
const available = (value: History) => {
  assert.equal(value.availability, "available");
  if (value.availability !== "available") throw new Error("Expected history");
  return value;
};
const fixture = (initial = [item("a", "older"), item("b", "newer")]) => {
  let rows = initial;
  const source = () =>
    taskHistorySource(
      {
        getTimelineMetadataPage: (_thread, input) =>
          Effect.sync(() => {
            const anchor = input.beforeItem ?? input.afterItem;
            const index =
              anchor === undefined
                ? -1
                : rows.findIndex(
                    (row) =>
                      row.id === anchor.sourceItemId && row.threadId === anchor.sourceThreadId,
                  );
            if (anchor && index === -1)
              return { items: [], totalItems: rows.length, hasMore: false, anchorFound: false };
            const matching = rows.filter(
              (_row, position) =>
                anchor === undefined || (input.beforeItem ? position < index : position > index),
            );
            const ordered = input.order === "newest_first" ? matching.toReversed() : matching;
            return {
              items: ordered.slice(0, input.limit).map((value, position) => ({
                sourceThreadId: threadId,
                sourceItemId: value.id,
                visibility: "local" as const,
                position,
                item: value,
                metadata: {
                  messageId: null,
                  createdBy: "agent" as const,
                  creationSource: "mcp",
                  senderThreadId: null,
                  title: value.title,
                },
              })),
              totalItems: rows.length,
              hasMore: ordered.length > input.limit,
              anchorFound: true,
            };
          }),
        getVisibleTurnItemRecord: (input) =>
          Effect.sync(() => {
            const item = rows.find(
              (row) =>
                row.id === input.itemId &&
                (input.sourceThreadId === undefined || row.threadId === input.sourceThreadId),
            );
            return item
              ? {
                  item,
                  sourceThreadId: item.threadId,
                  sourceItemId: item.id,
                  visibility: "local" as const,
                  metadata: {
                    messageId: null,
                    createdBy: "agent" as const,
                    creationSource: "mcp",
                    senderThreadId: null,
                    title: item.title,
                  },
                }
              : null;
          }),
      },
      threadId,
    );
  const readAdmitted = (request: Partial<HistoryInput> = {}, binding = "credential:a") =>
    readHistory({
      request: {
        ownerId: threadId,
        view: "activity",
        limit: 10,
        maxCharsPerItem: 10000,
        ...request,
      },
      binding,
      source: source(),
      wrap: (history) => ({ conversation: { taskId: "task:a" }, history }),
    }).pipe(
      Effect.tap(({ history }) =>
        Effect.sync(() =>
          assert.isAtMost(
            historyResultBytes({ conversation: { taskId: "task:a" }, history }),
            HISTORY_READ_MAX_BYTES,
          ),
        ),
      ),
    );
  return {
    readAdmitted,
    read: (request: Partial<HistoryInput> = {}, binding = "credential:a") =>
      readAdmitted(request, binding).pipe(Effect.map((result) => result.history)),
    replace: (next: typeof rows) => {
      rows = next;
    },
  };
};

it.effect(
  "reassembles canonical tool JSON without dropping outputs, images or nested metadata",
  () =>
    Effect.gen(function* () {
      const original = item("long", '漢😀\n\\"'.repeat(9000));
      const f = fixture([original]);
      let current = available(yield* f.read({ maxCharsPerItem: 1 })).items[0]!;
      let joined = "";
      for (let count = 0; ; count++) {
        assert.isBelow(count, 200);
        assert.equal(current.content.offset, joined.length);
        assert.equal(current.content.format, "json_fragment");
        if (current.content.format !== "json_fragment") throw new Error("Expected fragment");
        joined += JSON.parse(JSON.stringify(current.content)).text;
        if (!current.content.nextCursor) break;
        current = available(
          yield* f.read({ cursor: current.content.nextCursor, maxCharsPerItem: 50000 }),
        ).items[0]!;
      }
      assert.deepEqual(JSON.parse(joined), { source: "runtime", item: encodeItem(original) });
    }),
);

it.effect(
  "keeps exhausted forward cursors useful across appends and rejects a removed anchor",
  () =>
    Effect.gen(function* () {
      const a = item("a", "old");
      const b = item("b", "middle");
      const c = item("c", "new");
      const f = fixture([a, b]);
      const initial = available(yield* f.read({ order: "oldest_first" }));
      assert.deepEqual(
        initial.items.map((entry) => entry.id),
        ["a", "b"],
      );
      assert.isNull(initial.page.nextCursor);
      assert.isNotNull(initial.page.tailCursor);
      f.replace([b, c]);
      const appended = available(
        yield* f.read({ order: "oldest_first", cursor: initial.page.tailCursor! }),
      );
      assert.deepEqual(
        appended.items.map((entry) => entry.id),
        ["c"],
      );
      const unchanged = available(
        yield* f.read({ order: "oldest_first", cursor: appended.page.tailCursor! }),
      );
      assert.isEmpty(unchanged.items);
      assert.equal(unchanged.page.tailCursor, appended.page.tailCursor);
      f.replace([c]);
      const stale = yield* f
        .read({ order: "oldest_first", cursor: initial.page.tailCursor! })
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.equal(stale.failure.reason, "cursor_stale");
    }),
);

it.effect(
  "fences task content versions and credentials while returning current source metadata",
  () =>
    Effect.gen(function* () {
      const original = item("selected", "long".repeat(10000));
      const f = fixture([original]);
      const current = available(yield* f.read({ maxCharsPerItem: 100 })).items[0]!;
      assert.equal(current.createdBy, "agent");
      assert.equal(current.creationSource, "mcp");
      const other = yield* f
        .read({ cursor: current.content.nextCursor! }, "credential:b")
        .pipe(Effect.result);
      assert.equal(other._tag, "Failure");
      if (other._tag === "Failure") assert.equal(other.failure.reason, "invalid_cursor");
      f.replace([item("selected", "short")]);
      const changed = yield* f.read({ cursor: current.content.nextCursor! }).pipe(Effect.result);
      assert.equal(changed._tag, "Failure");
      if (changed._tag === "Failure") assert.equal(changed.failure.reason, "cursor_stale");
    }),
);

it.effect("can poll a forward tail created before a task has any history", () =>
  Effect.gen(function* () {
    const f = fixture([]);
    const empty = available(yield* f.read({ order: "oldest_first" }));
    assert.isEmpty(empty.items);
    assert.isNull(empty.page.nextCursor);
    assert.isNotNull(empty.page.tailCursor);
    f.replace([item("first", "arrived")]);
    const appended = available(
      yield* f.read({ order: "oldest_first", cursor: empty.page.tailCursor! }),
    );
    assert.deepEqual(
      appended.items.map((entry) => entry.id),
      ["first"],
    );
  }),
);

it.effect(
  "point reads keep Task owner visibility and reject caller metadata in a content address",
  () =>
    Effect.gen(function* () {
      const f = fixture([item("selected", "long".repeat(10000))]);
      const point = available(
        yield* f.read({ itemId: "selected", sourceThreadId: threadId, maxCharsPerItem: 7 }),
      ).items[0]!;
      assert.equal(point.createdBy, "agent");
      assert.equal(point.creationSource, "mcp");
      assert.equal(point.visibility, "local");
      const cursor = JSON.parse(
        Buffer.from(point.content.nextCursor!.slice(5), "base64url").toString("utf8"),
      );
      assert.isUndefined(cursor.reference);
      cursor.locator.visibility = "inherited";
      const forged = `nxh2.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
      const result = yield* f.read({ cursor: forged }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid_cursor");
      const wrongRun = yield* f.read({ itemId: "selected", runId: "wrong" }).pipe(Effect.result);
      assert.equal(wrongRun._tag, "Failure");
      if (wrongRun._tag === "Failure") assert.equal(wrongRun.failure.reason, "item_unavailable");
      const foreign = yield* f
        .read({ itemId: "selected", sourceThreadId: "foreign" })
        .pipe(Effect.result);
      assert.equal(foreign._tag, "Failure");
      if (foreign._tag === "Failure") assert.equal(foreign.failure.reason, "item_unavailable");
    }),
);

it.effect("reports only the ranges and items admitted after complete-envelope byte trimming", () =>
  Effect.gen(function* () {
    const f = fixture([item("omitted", "older"), item("long", '漢😀\\"'.repeat(20000))]);
    const result = yield* f.readAdmitted({ maxCharsPerItem: 100000 });
    const history = available(result.history);
    assert.equal(history.items.length, 1);
    const entry = history.items[0]!;
    assert.equal(entry.content.format, "json_fragment");
    if (entry.content.format !== "json_fragment") return;
    assert.isBelow(entry.content.text.length, 100000);
    assert.deepEqual(result.admitted, [
      {
        itemId: "long",
        sourceThreadId: threadId,
        format: "json",
        offset: entry.content.offset,
        length: entry.content.text.length,
        totalChars: entry.content.totalChars,
        contentVersion: result.admitted[0]!.contentVersion,
      },
    ]);
    assert.isTrue(result.admitted.every((proof) => proof.itemId !== "omitted"));
    const next = yield* f.readAdmitted({
      cursor: entry.content.nextCursor!,
      maxCharsPerItem: 100000,
    });
    assert.equal(next.admitted[0]?.offset, entry.content.text.length);
    assert.equal(next.admitted[0]?.contentVersion, result.admitted[0]?.contentVersion);
  }),
);
