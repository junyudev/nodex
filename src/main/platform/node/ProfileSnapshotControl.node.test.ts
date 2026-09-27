import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { serveProfileSnapshotControl } from "./ProfileSnapshotControl";

const fixture = Effect.gen(function* () {
  const home = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync("/tmp/nodex-snapshot-")),
    (home) => Effect.sync(() => rmSync(home, { force: true, recursive: true })),
  );
  const resumed = yield* Deferred.make<void>();
  let paused = false;
  yield* serveProfileSnapshotControl(home, (capture) =>
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
    const f = yield* fixture;
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
    const f = yield* fixture;
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
    const f = yield* fixture;
    f.socket.write('{"version":2}\n');
    assert.isTrue((yield* f.read).done);
    assert.isFalse(f.paused());
  }),
);
