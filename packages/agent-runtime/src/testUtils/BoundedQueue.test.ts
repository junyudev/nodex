import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as BoundedQueue from "@t3tools/shared/BoundedQueue";

const make = (maxItems = 2, maxBytes = 8) =>
  BoundedQueue.make<string, BoundedQueue.BufferOverflow>({
    label: "native",
    maxItems,
    maxBytes,
    mapOverflow: (error) => error,
  });

describe("bounded native intake", () => {
  it.effect(
    "rejects flood without suspending producers and clears accepted bodies on failure",
    () =>
      Effect.gen(function* () {
        const queue = yield* make();
        assert.isTrue(yield* BoundedQueue.offer(queue, "one"));
        assert.isTrue(yield* BoundedQueue.offer(queue, "two"));
        assert.isFalse(yield* BoundedQueue.offer(queue, "three"));
        yield* Effect.forEach(
          Array.from({ length: 10_000 }),
          () => BoundedQueue.offer(queue, "later"),
          { discard: true },
        );
        assert.equal(queue.items, 0);
        assert.equal(queue.bytes, 0);
        const exit = yield* Effect.exit(BoundedQueue.take(queue));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit))
          assert.instanceOf(Cause.squash(exit.cause), BoundedQueue.BufferOverflow);
      }),
  );
  it.effect(
    "counts UTF8 bytes, reclaims consumed budget, and can start a fresh connection after cancellation",
    () =>
      Effect.gen(function* () {
        const queue = yield* make(10, 4);
        assert.isTrue(yield* BoundedQueue.offer(queue, "中"));
        assert.equal(yield* BoundedQueue.take(queue), "中");
        assert.isTrue(yield* BoundedQueue.offer(queue, "中"));
        assert.isFalse(yield* BoundedQueue.offer(queue, "é"));
        yield* BoundedQueue.shutdown(queue);
        const fresh = yield* make(10, 4);
        assert.isTrue(yield* BoundedQueue.offer(fresh, "é"));
        const consumer = yield* BoundedQueue.stream(fresh).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* BoundedQueue.end(fresh);
        assert.deepEqual(yield* Fiber.join(consumer), ["é"]);
      }),
  );
  it.effect("bounds deferred causal frames and rejects a single giant frame", () =>
    Effect.gen(function* () {
      const queue = yield* make();
      const first = BoundedQueue.appendUnsafe(queue, [], "one", "two");
      assert.deepEqual(first, ["one", "two"]);
      assert.deepEqual(BoundedQueue.appendUnsafe(queue, first, "three"), []);
      const exit = yield* Effect.exit(BoundedQueue.take(queue));
      assert.isTrue(Exit.isFailure(exit));
      assert.throws(
        () => BoundedQueue.assertFrameSize(BoundedQueue.MAX_FRAME_BYTES + 1, "wire"),
        BoundedQueue.BufferOverflow,
      );
    }),
  );
});
