import { assert, describe, it } from "@effect/vitest";
import * as BoundedQueue from "@t3tools/shared/BoundedQueue";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { makeCodexAppServerPatchedProtocol } from "./protocol.ts";

describe("Codex native request lifetimes", () => {
  const makeHarness = Effect.fnUntraced(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    const started = yield* Queue.unbounded<string | number>();
    const ended = yield* Queue.unbounded<string | number>();
    const notifications = yield* Queue.unbounded<string>();
    const output = yield* Queue.unbounded<string>();
    const protocol = yield* makeCodexAppServerPatchedProtocol({
      stdio: Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Queue.offer(output, String(chunk))),
        stderr: () => Sink.drain,
      }),
      onRequest: (request) => Queue.offer(started, request.id).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Queue.offer(ended, request.id)),
      ),
      onNotification: (notification) => Queue.offer(notifications, notification.method).pipe(Effect.asVoid),
    });
    return {
      protocol, started, ended, notifications, output,
      send: (frame: unknown) => Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)),
    };
  });

  it.effect("releases stopped handlers by exact JSON-RPC id and admits later approvals", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeHarness();
      // Numeric and string ids are different requests, even with the same text.
      yield* harness.send({ id: "1", method: "approval" });
      assert.equal(yield* Queue.take(harness.started), "1");
      for (let id = 1; id <= 40; id++) {
        yield* harness.send({ id, method: "approval", params: { detail: "x".repeat(256 * 1024) } });
        assert.equal(yield* Queue.take(harness.started), id);
        yield* harness.send({ method: "serverRequest/resolved", params: { requestId: id, threadId: "thread" } });
        assert.equal(yield* Queue.take(harness.ended), id);
        assert.equal(yield* Queue.take(harness.notifications), "serverRequest/resolved");
      }
      yield* harness.send({ method: "serverRequest/resolved", params: { requestId: "1", threadId: "thread" } });
      assert.equal(yield* Queue.take(harness.ended), "1");
      assert.equal(yield* Queue.take(harness.notifications), "serverRequest/resolved");
      assert.equal(yield* Queue.size(harness.output), 0);
    })),
  );

  for (const limit of ["count", "bytes"] as const) {
    it.effect(`retains the active-request ${limit} admission limit`, () =>
      Effect.scoped(Effect.gen(function* () {
        const harness = yield* makeHarness();
        const bytes = limit === "bytes" ? Math.floor(BoundedQueue.DEFAULT_MAX_BYTES / 3) : 1;
        const count = limit === "count" ? 32 : 2;
        for (let id = 0; id < count; id++) {
          yield* harness.send({ id, method: "approval", params: { detail: "x".repeat(bytes) } });
          assert.equal(yield* Queue.take(harness.started), id);
        }
        yield* harness.send({ id: count, method: "approval", params: { detail: "x".repeat(limit === "bytes" ? bytes * 2 : 1) } });
        const error = yield* harness.protocol.termination.pipe(Effect.flip);
        assert.equal(error._tag, "CodexAppServerTransportError");
        if (error._tag !== "CodexAppServerTransportError") return;
        assert.isTrue(error.cause instanceof BoundedQueue.BufferOverflow);
      })),
    );
  }
});
