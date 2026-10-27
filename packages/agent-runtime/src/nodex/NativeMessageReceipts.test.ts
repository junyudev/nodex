import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import migration from "../persistence/Migrations/084_NativeMessageReceipts.ts";
import { make, type NativeMessageReserve } from "./NativeMessageReceipts.ts";

const reserveInput = (expiresAt: number): NativeMessageReserve => ({
  sessionId: "session",
  hostId: "remote",
  threadId: "native-thread",
  messageId: "message",
  fingerprint: "a".repeat(64),
  attemptId: "attempt:first",
  expiresAt,
});
const command = (input: NativeMessageReserve) => ({
  sessionId: input.sessionId,
  messageId: input.messageId,
  fingerprint: input.fingerprint,
  attemptId: input.attemptId,
});
const result = {
  messageId: "message",
  runId: "turn",
  status: "running",
  delivery: "started" as const,
};

it.effect(
  "admits an explicit identity once, preserves uncertain reservations and confirms producer proof",
  () =>
    Effect.gen(function* () {
      const owner = yield* make;
      const input = reserveInput((yield* Clock.currentTimeMillis) + 60000);
      assert.isTrue((yield* owner.reserve(input)).admitted);
      assert.isFalse((yield* owner.reserve({ ...input, attemptId: "another-attempt" })).admitted);
      yield* owner.settle({ ...command(input), phase: "unconfirmed" });
      const freshOwner = yield* make;
      assert.equal((yield* freshOwner.reserve(input)).phase, "unconfirmed");
      assert.equal(
        (yield* freshOwner.settle({ ...command(input), phase: "rejected" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      yield* freshOwner.settle({ ...command(input), phase: "confirmed", result });
      assert.deepEqual((yield* owner.reserve(input)).result, result);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "rejects changed arguments and stale attempts while allowing a proved pre-dispatch refusal to retry",
  () =>
    Effect.gen(function* () {
      const owner = yield* make;
      const input = reserveInput((yield* Clock.currentTimeMillis) + 60000);
      yield* owner.reserve(input);
      for (const changed of [
        { ...input, fingerprint: "b".repeat(64) },
        { ...input, sessionId: "another-session" },
      ])
        assert.equal((yield* owner.reserve(changed).pipe(Effect.result))._tag, "Failure");
      yield* owner.settle({ ...command(input), phase: "rejected" });
      yield* owner.settle({ ...command(input), phase: "rejected" });
      const next = yield* owner.reserve({ ...input, attemptId: "attempt:retry" });
      assert.isTrue(next.admitted);
      assert.equal(
        (yield* owner.settle({ ...command(input), phase: "confirmed", result }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      yield* owner.settle({
        ...command(input),
        attemptId: next.attemptId,
        phase: "confirmed",
        result,
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reads an original accepted binding after host or execution ownership changes", () =>
  Effect.gen(function* () {
    const owner = yield* make;
    const input = reserveInput((yield* Clock.currentTimeMillis) + 60000);
    assert.isNull(yield* owner.lookup(command(input)));
    yield* owner.reserve(input);
    yield* owner.settle({ ...command(input), phase: "confirmed", result });
    const stored = yield* owner.lookup(command(input));
    assert.equal(stored?.hostId, "remote");
    assert.equal(stored?.threadId, "native-thread");
    assert.deepEqual(stored?.result, result);
    const replay = yield* owner.reserve({ ...input, hostId: "new-host", threadId: "new-thread" });
    assert.equal(replay.hostId, "remote");
    assert.equal(replay.threadId, "native-thread");
    assert.isFalse(replay.admitted);
    assert.equal(
      (yield* owner.lookup({ ...command(input), fingerprint: "b".repeat(64) }).pipe(Effect.result))
        ._tag,
      "Failure",
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("has a single durable winner for concurrent reservations", () =>
  Effect.gen(function* () {
    const owner = yield* make;
    const input = reserveInput((yield* Clock.currentTimeMillis) + 60000);
    const outcomes = yield* Effect.all(
      [owner.reserve(input), owner.reserve({ ...input, attemptId: "other-attempt" })],
      { concurrency: "unbounded" },
    );
    assert.equal(outcomes.filter((outcome) => outcome.admitted).length, 1);
    assert.equal(outcomes[0]!.attemptId, outcomes[1]!.attemptId);
    assert.equal(
      (yield* owner.reserve({ ...input, expiresAt: 0 }).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "never readmits an unknown Native write after closing and reopening its SQLite owner",
  () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(path.join(tmpdir(), "nodex-native-message-receipt-"));
      const database = path.join(directory, "runtime.sqlite");
      const input = reserveInput((yield* Clock.currentTimeMillis) + 60000);
      const open = () => NodeSqliteClient.layer({ filename: database });
      try {
        yield* Effect.gen(function* () {
          yield* migration;
          const owner = yield* make;
          yield* owner.reserve(input);
        }).pipe(Effect.provide(open()));
        yield* Effect.gen(function* () {
          const owner = yield* make;
          const replay = yield* owner.reserve({ ...input, attemptId: "after-process-restart" });
          assert.isFalse(replay.admitted);
          assert.equal(replay.phase, "pending");
          yield* owner.settle({ ...command(input), phase: "confirmed", result });
        }).pipe(Effect.provide(open()));
        const confirmed = yield* Effect.gen(function* () {
          const owner = yield* make;
          return yield* owner.reserve(input);
        }).pipe(Effect.provide(open()));
        assert.deepEqual(confirmed.result, result);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
);
