import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ThreadTurnsListResponse } from "@nodex/codex-app-server-protocol/v2";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { make } from "./NativeSessionExecution";

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
