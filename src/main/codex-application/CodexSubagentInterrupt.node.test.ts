import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { produce } from "immer";
import {
  interruptSubagentDescendants,
  CodexSubagentDirectoryError,
} from "./CodexSubagentDirectory";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";

it.effect(
  "stops known resident descendants before discovery, then checks remaining active Turns once",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const active = conversationFixture("resident", [turnFixture("resident-turn", "inProgress")]);
      const idle = produce(conversationFixture("idle", []), (draft) => {
        draft.threadRuntimeStatus = { type: "idle" };
        draft.resumeState = "resumed";
      });
      const rows = [
        { threadId: "resident", active: false },
        { threadId: "idle", active: true },
        { threadId: "cold", active: true },
        { threadId: "finished", active: true },
        { threadId: "unknown", active: false },
      ];
      const result = yield* interruptSubagentDescendants({
        known: Effect.succeed({ rows, complete: false }),
        discover: Effect.sync(() => {
          events.push("discover");
          return { rows, complete: false };
        }),
        resident: (id) => (id === "resident" ? active : id === "idle" ? idle : null),
        interruptResident: (id) =>
          Effect.sync(() => {
            events.push(`resident:${id}`);
            return id === "resident" ? "resident-turn" : null;
          }),
        readLatestTurn: (id) =>
          Effect.sync(() => {
            events.push(`read:${id}`);
            return { id: `${id}-turn`, status: id === "cold" ? "inProgress" : "completed" };
          }),
        interruptTurn: (id, turnId) => Effect.sync(() => events.push(`interrupt:${id}:${turnId}`)),
        warn: () => Effect.die("Unexpected warning"),
      });
      const discoveryIndex = events.indexOf("discover");
      assert.isTrue(events.indexOf("resident:resident") < discoveryIndex);
      assert.isTrue(events.indexOf("resident:idle") > discoveryIndex);
      assert.deepEqual(
        events.filter((event) => event.startsWith("read:")),
        ["read:idle", "read:cold", "read:finished"],
      );
      assert.deepEqual(
        events.filter((event) => event.startsWith("interrupt:")),
        ["interrupt:cold:cold-turn"],
      );
      assert.isFalse(events.some((event) => event.includes("unknown")));
      assert.deepEqual(result.interruptedThreadIds, ["resident", "cold"]);
      assert.isFalse(result.discoveryComplete);
    }),
);

it.effect("starts all known active child stops concurrently before waiting for discovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      let running = 0;
      const rows = Array.from({ length: 4 }, (_, index) => ({
        threadId: `child-${index}`,
        active: true,
      }));
      const active = conversationFixture("child", [turnFixture("turn", "inProgress")]);
      const fiber = yield* interruptSubagentDescendants({
        known: Effect.succeed({ rows, complete: true }),
        discover: Effect.sync(() => {
          assert.strictEqual(running, 4);
          return { rows, complete: true };
        }),
        resident: () => active,
        interruptResident: (id) =>
          Effect.gen(function* () {
            running++;
            if (running === 4) yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return `${id}-turn`;
          }),
        readLatestTurn: () => Effect.die("Accepted resident stops must not be read again"),
        interruptTurn: () => Effect.die("Accepted resident stops must not be interrupted again"),
        warn: () => Effect.die("Unexpected warning"),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(fiber)).interruptedThreadIds.length, 4);
    }),
  ),
);

it.effect("retains known child stop success when discovery fails", () =>
  Effect.gen(function* () {
    const warnings: unknown[] = [];
    const failure = new CodexSubagentDirectoryError({
      operation: "discover",
      rootThreadId: "root",
      cause: new Error("discovery unavailable"),
    });
    const result = yield* interruptSubagentDescendants({
      known: Effect.succeed({ rows: [{ threadId: "child", active: true }], complete: true }),
      discover: Effect.fail(failure),
      resident: () => conversationFixture("child", [turnFixture("turn", "inProgress")]),
      interruptResident: () => Effect.succeed("turn"),
      readLatestTurn: () => Effect.die("No second phase after discovery failure"),
      interruptTurn: () => Effect.die("No second phase after discovery failure"),
      warn: (id, cause) =>
        Effect.sync(() => {
          warnings.push([id, cause]);
        }),
    });
    assert.deepEqual(result.interruptedThreadIds, ["child"]);
    assert.isFalse(result.discoveryComplete);
    assert.deepEqual(warnings, [[null, failure]]);
  }),
);

it.effect("does not fallback-interrupt an old metadata child absent from fresh discovery", () =>
  Effect.gen(function* () {
    const result = yield* interruptSubagentDescendants({
      known: Effect.succeed({ rows: [{ threadId: "old-child", active: true }], complete: true }),
      discover: Effect.succeed({ rows: [], complete: true }),
      resident: () => null,
      interruptResident: () => Effect.succeed(null),
      readLatestTurn: () => Effect.die("An absent nonresident child is not a current candidate"),
      interruptTurn: () => Effect.die("An absent nonresident child must not be interrupted"),
      warn: () => Effect.die("Unexpected warning"),
    });
    assert.deepEqual(result.interruptedThreadIds, []);
  }),
);

it.effect("warns on failed children without rejecting other native interruptions", () =>
  Effect.gen(function* () {
    const warnings: Array<string | null> = [];
    const interrupted: string[] = [];
    const result = yield* interruptSubagentDescendants({
      known: Effect.succeed({ rows: [], complete: false }),
      discover: Effect.succeed({
        rows: ["failed", "healthy"].map((threadId) => ({ threadId, active: true })),
        complete: true,
      }),
      resident: () => null,
      interruptResident: () => Effect.succeed(null),
      readLatestTurn: (id) =>
        id === "failed"
          ? Effect.fail(
              new CodexSubagentDirectoryError({
                operation: "lifecycle",
                rootThreadId: "root",
                cause: new Error("read denied"),
              }),
            )
          : Effect.succeed({ id: "turn", status: "inProgress" }),
      interruptTurn: (id) =>
        Effect.sync(() => {
          interrupted.push(id);
        }),
      warn: (id) =>
        Effect.sync(() => {
          warnings.push(id);
        }),
    });
    assert.deepEqual(interrupted, ["healthy"]);
    assert.deepEqual(warnings, ["failed"]);
    assert.deepEqual(
      result.failed.map((failure) => failure.threadId),
      ["failed"],
    );
    assert.deepEqual(result.unresolvedThreadIds, []);
  }),
);
