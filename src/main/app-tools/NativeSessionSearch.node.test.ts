import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { makeNativeSessionSearch } from "./NativeSessionSearch";

const entry = (id: string, text: string) => ({
  turnId: `run:${id}`,
  startedAtMs: 10,
  completedAtMs: 20,
  item: {
    type: "agentMessage",
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  },
});
const fixture = Effect.gen(function* () {
  let current = true,
    changed = false,
    append = false,
    removedTail = false,
    withUser = false,
    missingTimestamps = false;
  const requests: Array<{
    host: string;
    method: string;
    input: { cursor: string | null; sortDirection: string; limit: number };
  }> = [];
  const owner = yield* makeNativeSessionSearch.pipe(
    Effect.provideService(CodexGateway, {
      requestOnHost: (
        host: string,
        method: string,
        input: { cursor: string | null; sortDirection: string; limit: number },
      ) =>
        Effect.sync(() => {
          requests.push({ host, method, input });
          const body = [
            entry("a", changed ? "changed" : "old café now resume"),
            ...(removedTail ? [] : [entry("b", "second café resume")]),
            ...(withUser
              ? [
                  {
                    ...entry("user", "Unrelated question"),
                    startedAtMs: 100,
                    item: {
                      type: "userMessage",
                      id: "user",
                      clientId: null,
                      content: [{ type: "text", text: "Unrelated question", text_elements: [] }],
                    },
                  },
                ]
              : []),
            ...(append ? [entry("later", "café resume")] : []),
          ].map((item) => (missingTimestamps ? { ...item, startedAtMs: null } : item));
          if (method === "thread/items/read") return { data: [body[0]] };
          if (input.sortDirection === "desc")
            return { data: [body.at(-1)], nextCursor: null, backwardsCursor: "reverse" };
          const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0;
          return {
            data: body.slice(offset, offset + 1),
            nextCursor: offset + 1 < body.length ? `page:${offset + 1}` : null,
            backwardsCursor: "reverse",
          };
        }),
    } as never),
    Effect.provideService(CodexMainConversationManagers, {
      get: () =>
        Effect.succeed({
          generation: 7,
          assertCurrent: () => {
            if (!current) throw new Error("Reconnected");
          },
        }),
    } as never),
  );
  return {
    owner,
    requests,
    removeTail: () => {
      removedTail = true;
    },
    addUser: () => {
      withUser = true;
    },
    omitTimestamps: () => {
      missingTimestamps = true;
    },
    reconnect: () => {
      current = false;
    },
    change: () => {
      changed = true;
    },
    append: () => {
      append = true;
    },
  };
});
it.effect(
  "matches complete Native message text with exact item coordinates and a stable append fence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.owner.page({
        hostId: "remote",
        threadId: "native",
        query: "cafe resume",
        cursor: null,
      });
      assert.equal(first.items[0]?.reference.itemId, "a");
      assert.equal(first.items[0]?.reference.runId, "run:a");
      assert.isAbove(first.items[0]!.quality, 0);
      assert.isNotNull(first.nextCursor);
      f.append();
      const second = yield* f.owner.page({
        hostId: "remote",
        threadId: "native",
        query: "cafe resume",
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.items.map((fact) => fact.reference.itemId),
        ["b"],
      );
      assert.equal(second.nextCursor, null);
      assert.isTrue(
        f.requests.every(
          (request) => request.host === "remote" && request.method === "thread/items/list",
        ),
      );
      assert.deepEqual(
        f.requests.map((request) => request.input.limit),
        [1, 20, 20],
      );
    }),
);
it.effect("point resolves canonical versions and rejects changed messages or replaced hosts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const page = yield* f.owner.page({
      hostId: "remote",
      threadId: "native",
      query: "cafe resume",
      cursor: null,
    });
    const reference = page.items[0]!.reference;
    const resolved = yield* f.owner.resolve({
      hostId: "remote",
      threadId: "native",
      query: "cafe resume",
      reference,
    });
    assert.equal(resolved.reference.itemId, "a");
    assert.equal(f.requests.at(-1)?.method, "thread/items/read");
    f.change();
    assert.equal(
      (yield* f.owner
        .resolve({ hostId: "remote", threadId: "native", query: "cafe resume", reference })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    f.reconnect();
    assert.equal(
      (yield* f.owner
        .page({ hostId: "remote", threadId: "native", query: "cafe resume", cursor: null })
        .pipe(Effect.result))._tag,
      "Failure",
    );
  }),
);

it.effect("does not replace a missing fixed tail with newly appended history", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.owner.page({
      hostId: "remote",
      threadId: "native",
      query: "cafe resume",
      cursor: null,
    });
    f.removeTail();
    f.append();
    const result = yield* f.owner
      .page({
        hostId: "remote",
        threadId: "native",
        query: "cafe resume",
        cursor: first.nextCursor,
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("collects the latest user-role activity even when that message does not match", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.addUser();
    let page = yield* f.owner.page({
      hostId: "remote",
      threadId: "native",
      query: "cafe resume",
      cursor: null,
    });
    while (page.nextCursor)
      page = yield* f.owner.page({
        hostId: "remote",
        threadId: "native",
        query: "cafe resume",
        cursor: page.nextCursor,
      });
    assert.isEmpty(page.items);
    assert.equal(page.latestUserMessageAt, new Date(100).toISOString());
  }),
);

it.effect("keeps unavailable producer timestamps unknown instead of inventing activity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.addUser();
    f.omitTimestamps();
    let page = yield* f.owner.page({
      hostId: "remote",
      threadId: "native",
      query: "cafe resume",
      cursor: null,
    });
    assert.equal(page.items[0]?.messageAt, "");
    assert.isNull(page.latestUserMessageAt);
    while (page.nextCursor)
      page = yield* f.owner.page({
        hostId: "remote",
        threadId: "native",
        query: "cafe resume",
        cursor: page.nextCursor,
      });
    assert.isNull(page.latestUserMessageAt);
  }),
);
