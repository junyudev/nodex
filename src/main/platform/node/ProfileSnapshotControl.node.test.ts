import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { serveProfileSnapshotControl, type WithExecutionSnapshot } from "./ProfileSnapshotControl";

const fixture = (withExecutionSnapshot?: WithExecutionSnapshot) =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync("/tmp/nodex-snapshot-")),
      (home) => Effect.sync(() => rmSync(home, { force: true, recursive: true })),
    );
    const resumed = yield* Deferred.make<void>();
    let paused = false;
    yield* serveProfileSnapshotControl(
      home,
      (capture) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            paused = true;
          }),
          () => capture,
          () =>
            Effect.sync(() => {
              paused = false;
            }).pipe(Effect.andThen(Deferred.succeed(resumed, undefined)), Effect.asVoid),
        ),
      withExecutionSnapshot,
    );
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => connect(join(home, "ipc/clone.sock"))),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    socket.on("error", () => {});
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    const read = Effect.promise(() => lines.next());
    return { socket, read, resumed, paused: () => paused };
  });

it.live("a live capture lease restores the source before acknowledging release", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.socket.write('{"version":1}\n');
    assert.strictEqual((yield* f.read).value, '{"version":1,"status":"ready"}');
    assert.isTrue(f.paused());
    f.socket.write('{"version":1,"release":true}\n');
    assert.strictEqual((yield* f.read).value, '{"version":1,"status":"resumed"}');
    assert.isFalse(f.paused());
  }),
);

it.live("a client that disappears during capture releases its source pause", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.socket.write('{"version":1}\n');
    yield* f.read;
    assert.isTrue(f.paused());
    f.socket.destroy();
    yield* Deferred.await(f.resumed);
    assert.isFalse(f.paused());
  }),
);

it.live("malformed acquisition never pauses the source", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.socket.write('{"version":2}\n');
    assert.isTrue((yield* f.read).done);
    assert.isFalse(f.paused());
  }),
);

it.live("lends only bounded snapshot evidence while holding both physical capture lifetimes", () =>
  Effect.gen(function* () {
    let executionHeld = false;
    const source = {
      leaseId: "lease",
      runtimeId: "runtime",
      runtimeGeneration: "generation",
      sequence: 7,
      databasePath: "/profile/runtime/snapshots/execution.sqlite",
      attachmentsPath: "/profile/agent-runtime/userdata/attachments",
      environmentIdPath: "/profile/agent-runtime/userdata/environment-id",
      nativeHistories: Array.from({ length: 256 }, (_, index) => ({
        providerInstanceId: `claude:${index}`,
        driver: "claudeAgent",
        homePath: `/private/accounts/${"directory".repeat(40)}/claude`,
      })),
    };
    const privateSource = { ...source, credentials: { token: "private-fixture-token" } };
    const f = yield* fixture((capture) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          executionHeld = true;
        }),
        () => capture(privateSource),
        () =>
          Effect.sync(() => {
            executionHeld = false;
          }),
      ),
    );
    f.socket.write('{"version":1}\n');
    const ready = (yield* f.read).value;
    assert.isTrue(ready!.length > 16384);
    assert.deepStrictEqual(JSON.parse(ready!), {
      version: 1,
      status: "ready",
      executionSnapshot: source,
    });
    assert.isTrue(executionHeld);
    assert.isTrue(f.paused());
    f.socket.write('{"version":1,"release":true}\n');
    assert.strictEqual((yield* f.read).value, '{"version":1,"status":"resumed"}');
    assert.isFalse(executionHeld);
    assert.isFalse(f.paused());
  }),
);
