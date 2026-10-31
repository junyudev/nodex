import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { make } from "./SessionControlReceipts.ts";

it.effect("durably admits a control once and preserves pending and completed retry fences", () =>
  Effect.gen(function* () {
    const receipt = yield* make;
    const input = {
      sessionId: "session",
      operationId: "stop",
      fingerprint: "a".repeat(64),
      expiresAt: (yield* Clock.currentTimeMillis) + 60000,
    };
    const attempts = yield* Effect.all([receipt(input), receipt(input)], {
      concurrency: "unbounded",
    });
    assert.equal(attempts.filter((attempt) => attempt.admitted).length, 1);
    const reopened = yield* make;
    assert.deepEqual(yield* reopened(input), { admitted: false, resultJson: null });
    const resultJson = JSON.stringify({ sessionId: "session", status: "stop_requested" });
    yield* reopened({ ...input, resultJson });
    assert.deepEqual(yield* receipt(input), { admitted: false, resultJson });
    for (const changed of [
      { ...input, fingerprint: "b".repeat(64) },
      { ...input, sessionId: "different" },
      { ...input, resultJson: "{}" },
      { ...input, expiresAt: 0 },
    ])
      assert.isTrue(yield* receipt(changed).pipe(Effect.isFailure));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
