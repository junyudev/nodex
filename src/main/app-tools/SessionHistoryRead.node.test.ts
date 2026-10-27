import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import type {
  SessionHistory,
  SessionHistoryItem,
} from "../../shared/nodex-app-tools/session-history";
import { toolResultBytes } from "./app-tool-result";
import {
  readSessionHistory,
  readSessionProgress,
  SESSION_READ_MAX_BYTES,
  type SessionHistoryInput,
  type SessionHistorySource,
  type SessionItemReference,
} from "./SessionHistoryRead";

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
