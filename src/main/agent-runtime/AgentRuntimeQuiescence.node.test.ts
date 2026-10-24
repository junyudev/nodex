import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make, reportsNoWork } from "./AgentRuntimeQuiescence";

const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-quiescence-" });
  const database = join(directory, "agent-runtime.sqlite");
  return { fs, directory, database };
});

it.effect("a launch starts execution unless evidence matches the stopped store exactly", () =>
  Effect.gen(function* () {
    const { fs, directory, database } = yield* home;
    const evidence = yield* make(directory);
    // A never-used Profile has nothing to resume.
    assert.isFalse(yield* evidence.startRequired);
    yield* fs.writeFileString(database, "store");
    // A store without evidence may hold work left by a crash.
    assert.isTrue(yield* evidence.startRequired);
    yield* evidence.record;
    assert.isFalse(yield* evidence.startRequired);
    // A later write, such as a restore or copy, invalidates the evidence.
    yield* fs.writeFileString(database, "restored store");
    assert.isTrue(yield* evidence.startRequired);
    yield* evidence.record;
    yield* fs.writeFileString(`${database}-wal`, "uncheckpointed");
    assert.isTrue(yield* evidence.startRequired);
    yield* evidence.record;
    assert.isFalse(yield* evidence.startRequired);
    // Starting a process clears the evidence before it can change the store.
    yield* evidence.clear;
    assert.isTrue(yield* evidence.startRequired);
    yield* fs.writeFileString(join(directory, "quiescent.json"), "{not evidence");
    assert.isTrue(yield* evidence.startRequired);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const connection = (
  activity: number,
  handoffs: number,
  fail = false,
  management = { activeOperations: 0, activeAuthentication: 0 },
) =>
  ({
    request: (method: string) =>
      fail
        ? Effect.fail(new Error("unsupported"))
        : Effect.succeed(
            method === "acp.activity"
              ? management
              : method === "execution.activity"
                ? {
                    snapshotSequence: 1,
                    items: Array.from({ length: activity }, () => ({})),
                    nextCursor: null,
                  }
                : { items: Array.from({ length: handoffs }, () => ({})), nextCursor: null },
          ),
  }) as unknown as AgentRuntimeProcessConnection;

it.effect("execution is quiet only with no live roots and no handoff holds", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* reportsNoWork(connection(0, 0)));
    assert.isFalse(yield* reportsNoWork(connection(1, 0)));
    assert.isFalse(yield* reportsNoWork(connection(0, 1)));
    assert.isFalse(
      yield* reportsNoWork(
        connection(0, 0, false, { activeOperations: 1, activeAuthentication: 0 }),
      ),
    );
    assert.isFalse(
      yield* reportsNoWork(
        connection(0, 0, false, { activeOperations: 0, activeAuthentication: 1 }),
      ),
    );
    // An unanswerable report is never treated as quiet by the supervisor.
    assert.isTrue(Exit.isFailure(yield* reportsNoWork(connection(0, 0, true)).pipe(Effect.exit)));
  }),
);
