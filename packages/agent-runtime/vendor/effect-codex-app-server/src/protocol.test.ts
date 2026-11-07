import { assert, describe, it } from "@effect/vitest";
import * as BoundedQueue from "@nodex/runtime-shared/BoundedQueue";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { makeCodexAppServerPatchedProtocol } from "./protocol.ts";

describe("Codex native request lifetimes", () => {
  const makeHarness = Effect.fnUntraced(function* () {
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const started = yield* Queue.unbounded<string | number>();
    const ended = yield* Queue.unbounded<string | number>();
    const notifications = yield* Queue.unbounded<string>();
    const output = yield* Queue.unbounded<string>();
    const protocol = yield* makeCodexAppServerPatchedProtocol({
      stdio: Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) => Queue.offer(output, String(chunk))),
        stderr: () => Sink.drain,
      }),
      onRequest: (request) =>
        Queue.offer(started, request.id).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Queue.offer(ended, request.id)),
        ),
      onNotification: (notification) =>
        Queue.offer(notifications, notification.method).pipe(Effect.asVoid),
    });
    return {
      protocol,
      started,
      ended,
      notifications,
      output,
      send: (frame: unknown) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)),
    };
  });

  it.effect("releases stopped handlers by exact JSON-RPC id and admits later approvals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        // Numeric and string ids are different requests, even with the same text.
        yield* harness.send({ id: "1", method: "approval" });
        assert.equal(yield* Queue.take(harness.started), "1");
        for (let id = 1; id <= 40; id++) {
          yield* harness.send({
            id,
            method: "approval",
            params: { detail: "x".repeat(256 * 1024) },
          });
          assert.equal(yield* Queue.take(harness.started), id);
          yield* harness.send({
            method: "serverRequest/resolved",
            params: { requestId: id, threadId: "thread" },
          });
          assert.equal(yield* Queue.take(harness.ended), id);
          assert.equal(yield* Queue.take(harness.notifications), "serverRequest/resolved");
        }
        yield* harness.send({
          method: "serverRequest/resolved",
          params: { requestId: "1", threadId: "thread" },
        });
        assert.equal(yield* Queue.take(harness.ended), "1");
        assert.equal(yield* Queue.take(harness.notifications), "serverRequest/resolved");
        assert.equal(yield* Queue.size(harness.output), 0);
      }),
    ),
  );

  for (const limit of ["count", "bytes"] as const) {
    it.effect(`rejects only the excess native request at the ${limit} limit`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const bytes = limit === "bytes" ? Math.floor(BoundedQueue.DEFAULT_MAX_BYTES / 3) : 1;
          const count = limit === "count" ? 32 : 2;
          for (let id = 0; id < count; id++) {
            yield* harness.send({ id, method: "approval", params: { detail: "x".repeat(bytes) } });
            assert.equal(yield* Queue.take(harness.started), id);
          }
          yield* harness.send({
            id: count,
            method: "approval",
            params: { detail: "x".repeat(limit === "bytes" ? bytes * 2 : 1) },
          });
          const rejected = JSON.parse(yield* Queue.take(harness.output));
          assert.equal(rejected.id, count);
          assert.equal(rejected.error.code, -32001);
          yield* harness.send({ method: "serverRequest/resolved", params: { requestId: 0 } });
          assert.equal(yield* Queue.take(harness.ended), 0);
          yield* harness.send({ id: "later", method: "approval" });
          assert.equal(yield* Queue.take(harness.started), "later");
          const sibling = yield* harness.protocol
            .request("thread/read", { threadId: "sibling" })
            .pipe(Effect.forkScoped);
          const request = JSON.parse(yield* Queue.take(harness.output));
          yield* harness.send({ id: request.id, result: { alive: true } });
          assert.deepEqual(yield* Fiber.join(sibling), { alive: true });
        }),
      ),
    );
  }
});

const makeTransport = Effect.fnUntraced(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const protocol = yield* makeCodexAppServerPatchedProtocol({
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) => Queue.offer(output, String(chunk))),
      stderr: () => Sink.drain,
    }),
  });
  return {
    protocol,
    output,
    input,
    send: (frame: unknown) =>
      Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)),
  };
});

for (const kind of ["notifications", "requests"] as const) {
  it.effect(`detaches a stalled raw ${kind} observer while sibling traffic continues`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { protocol, output, send } = yield* makeTransport();
        const first = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const seen = yield* Queue.unbounded<number>();
        const stream =
          kind === "notifications" ? protocol.incomingNotifications : protocol.incomingRequests;
        const slow = yield* stream.pipe(
          Stream.runForEach(() =>
            Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          ),
          Effect.flip,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* stream.pipe(
          Stream.runForEach(() => Queue.offer(seen, 1)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* send({ ...(kind === "requests" ? { id: 0 } : {}), method: "activity" });
        yield* Deferred.await(first);
        yield* Queue.take(seen);
        for (let id = 1; id <= BoundedQueue.DEFAULT_MAX_ITEMS + 1; id++) {
          yield* send({ ...(kind === "requests" ? { id } : {}), method: "activity" });
          yield* Queue.take(seen);
        }
        yield* Deferred.succeed(resume, undefined);
        assert.isTrue(BoundedQueue.isOverflow(yield* Fiber.join(slow)));
        const requestFiber = yield* protocol
          .request("thread/read", { threadId: "sibling" })
          .pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output));
        yield* send({ id: request.id, result: "still alive" });
        assert.equal(yield* Fiber.join(requestFiber), "still alive");
      }),
    ),
  );
}

it.effect(
  "retires at the unanswered client-request cap and fails every pending caller with the overflow",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { protocol, output } = yield* makeTransport();
        const pending: Array<Fiber.Fiber<import("./errors.ts").CodexAppServerError, unknown>> = [];
        for (let i = 0; i < BoundedQueue.DEFAULT_MAX_ITEMS; i++) {
          pending.push(yield* protocol.request("thread/read").pipe(Effect.flip, Effect.forkScoped));
          yield* Queue.take(output);
        }
        const error = yield* protocol.request("excess").pipe(Effect.flip);
        assert.equal(error._tag, "CodexAppServerTransportError");
        assert.isTrue(BoundedQueue.isOverflow(error));
        if (
          error._tag === "CodexAppServerTransportError" &&
          error.cause instanceof BoundedQueue.BufferOverflow
        )
          assert.equal(error.cause.label, "Codex pending requests");
        assert.strictEqual(yield* protocol.termination.pipe(Effect.flip), error);
        for (const request of pending) assert.strictEqual(yield* Fiber.join(request), error);
        assert.strictEqual(yield* protocol.request("after").pipe(Effect.flip), error);
        const fresh = yield* makeTransport();
        const recovered = yield* fresh.protocol.request("thread/read").pipe(Effect.forkScoped);
        const { id } = JSON.parse(yield* Queue.take(fresh.output));
        yield* fresh.send({ id, result: "fresh connection" });
        assert.equal(yield* Fiber.join(recovered), "fresh connection");
      }),
    ),
);

for (const limit of ["count", "bytes"] as const) {
  it.effect(
    `retires on outgoing ${limit} overflow and preserves its cause for pending callers`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const writing = yield* Deferred.make<void>();
          const protocol = yield* makeCodexAppServerPatchedProtocol({
            stdio: Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.never,
              stdout: () =>
                Sink.forEach(() =>
                  Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              stderr: () => Sink.drain,
            }),
          });
          const pending = yield* protocol
            .request("thread/read")
            .pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(writing);
          const payload =
            limit === "bytes" ? { text: "x".repeat(BoundedQueue.MAX_PROMPT_BYTES / 4) } : undefined;
          const count = limit === "bytes" ? 3 : BoundedQueue.DEFAULT_MAX_ITEMS;
          for (let i = 0; i < count; i++) yield* protocol.notify("queued", payload);
          const error = yield* protocol.notify("excess", payload).pipe(Effect.flip);
          assert.equal(error._tag, "CodexAppServerTransportError");
          assert.isTrue(BoundedQueue.isOverflow(error));
          if (error._tag === "CodexAppServerTransportError") {
            assert.equal(error.operation, "write-output-stream");
            if (error.cause instanceof BoundedQueue.BufferOverflow)
              assert.equal(error.cause.label, "Codex outgoing");
          }
          assert.strictEqual(yield* protocol.termination.pipe(Effect.flip), error);
          assert.strictEqual(yield* Fiber.join(pending), error);
          assert.strictEqual(yield* protocol.notify("after").pipe(Effect.flip), error);
        }),
      ),
  );
}

for (const failure of ["read", "framing"] as const) {
  it.effect(`still terminates on genuine ${failure} failure and fails pending callers`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { protocol, input, output } = yield* makeTransport();
        const pending = yield* protocol.request("thread/read").pipe(Effect.flip, Effect.forkScoped);
        yield* Queue.take(output);
        if (failure === "read") yield* Queue.end(input);
        else yield* Queue.offer(input, new TextEncoder().encode("{invalid json}\n"));
        const error = yield* protocol.termination.pipe(Effect.flip);
        assert.strictEqual(yield* Fiber.join(pending), error);
      }),
    ),
  );
}

it.effect(
  "retires rather than waiting indefinitely when a native reply encounters a stalled writer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* Queue.unbounded<Uint8Array>();
        const writing = yield* Deferred.make<void>();
        const protocol = yield* makeCodexAppServerPatchedProtocol({
          stdio: Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.fromQueue(input),
            stderr: () => Sink.drain,
            stdout: () =>
              Sink.forEach(() =>
                Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
              ),
          }),
          onRequest: () => Effect.succeed("native reply"),
        });
        const pending = yield* protocol.request("thread/read").pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(writing);
        for (let i = 0; i < BoundedQueue.DEFAULT_MAX_ITEMS; i++) yield* protocol.notify("queued");
        yield* Queue.offer(
          input,
          new TextEncoder().encode(`${JSON.stringify({ id: "native", method: "approval" })}\n`),
        );
        const error = yield* protocol.termination.pipe(Effect.flip);
        assert.equal(error._tag, "CodexAppServerTransportError");
        assert.isTrue(BoundedQueue.isOverflow(error));
        assert.strictEqual(yield* Fiber.join(pending), error);
      }),
    ),
);

for (const direction of ["read", "write"] as const) {
  it.effect(`retires the transport on an actual stdio ${direction} error`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = PlatformError.systemError({
          _tag: "Unknown",
          module: "Stdio",
          method: direction,
          cause: new Error("pipe closed"),
        });
        const protocol = yield* makeCodexAppServerPatchedProtocol({
          stdio: Stdio.make({
            args: Effect.succeed([]),
            stdin: direction === "read" ? Stream.fail(failure) : Stream.never,
            stdout: () => (direction === "write" ? Sink.fail(failure) : Sink.drain),
            stderr: () => Sink.drain,
          }),
        });
        const error = yield* protocol.request("thread/read").pipe(Effect.flip);
        assert.equal(error._tag, "CodexAppServerTransportError");
        if (error._tag === "CodexAppServerTransportError") {
          assert.strictEqual(error.cause, failure);
          assert.equal(
            error.operation,
            direction === "read" ? "read-input-stream" : "write-output-stream",
          );
        }
        assert.strictEqual(yield* protocol.termination.pipe(Effect.flip), error);
      }),
    ),
  );
}
