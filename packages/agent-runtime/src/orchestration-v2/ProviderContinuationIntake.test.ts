import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as Requests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";

const request = (index: number): Requests.ProviderContinuationRequest => ({
  threadId: ThreadId.make(`thread-${index}`),
  providerThreadId: ProviderThreadId.make(`provider-thread-${index}`),
  driver: ProviderDriverKind.make("claude"),
  detail: null,
});

describe("provider continuation intake", () => {
  it.effect(
    "rejects an overflowing origin without discarding other providers' accepted wakes",
    () =>
      Effect.gen(function* () {
        const requests = yield* Requests.ProviderContinuationRequests;
        for (let index = 0; index < Requests.MAX_PENDING_CONTINUATIONS; index++)
          yield* requests.offer(request(index));
        const rejected = yield* Effect.exit(requests.offer(request(9999)));
        assert.isTrue(Exit.isFailure(rejected));
        if (Exit.isFailure(rejected))
          assert.instanceOf(Cause.squash(rejected.cause), Requests.ProviderContinuationQueueFull);
        assert.deepEqual(yield* requests.take, request(0));
        yield* requests.offer(request(10000));
        for (let index = 1; index < Requests.MAX_PENDING_CONTINUATIONS; index++)
          assert.deepEqual(yield* requests.take, request(index));
        assert.deepEqual(yield* requests.take, request(10000));
      }).pipe(Effect.provide(Requests.layer)),
  );

  it.effect("bounds UTF-8 bytes before parking a producer and reclaims consumed space", () =>
    Effect.gen(function* () {
      const requests = yield* Requests.ProviderContinuationRequests;
      const large = { ...request(1), detail: "中".repeat(1_000_000) };
      yield* requests.offer(large);
      yield* requests.offer({ ...large, threadId: request(2).threadId });
      const rejected = yield* Effect.exit(
        requests.offer({ ...large, threadId: request(3).threadId }),
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.deepEqual(yield* requests.take, large);
      yield* requests.offer({ ...large, threadId: request(3).threadId });
      assert.equal((yield* requests.take).threadId, request(2).threadId);
      assert.equal((yield* requests.take).threadId, request(3).threadId);
      const giant = yield* Effect.exit(
        requests.offer({
          ...request(4),
          detail: "x".repeat(Requests.MAX_PENDING_CONTINUATION_BYTES),
        }),
      );
      assert.isTrue(Exit.isFailure(giant));
      yield* requests.offer(request(5));
      assert.deepEqual(yield* requests.take, request(5));
    }).pipe(Effect.provide(Requests.layer)),
  );
});
