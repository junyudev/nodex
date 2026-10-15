import { assert, describe, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as BoundedQueue from "@t3tools/shared/BoundedQueue";
import {
  boundResponse,
  makeFrameGuard,
  subscribeEvents,
} from "../../vendor/provider-opencode/src/server/SseIntake.ts";

const encoder = new TextEncoder();
describe("native SSE intake", () => {
  it.effect(
    "counts UTF8 bytes across chunk/line boundaries and frees budget after a complete event",
    () =>
      Effect.sync(() => {
        const guard = makeFrameGuard("native", 16);
        guard(encoder.encode("data:中\r\n"));
        guard(encoder.encode("\r\n"));
        guard(encoder.encode("data:中\n\n"));
        guard(encoder.encode("data:中\r"));
        guard(encoder.encode("\rdata:中\r\r"));
        const held = makeFrameGuard("native", 16);
        held(encoder.encode("data:中\n"));
        assert.throws(() => held(encoder.encode("data:中")), BoundedQueue.BufferOverflow);
        const burst = makeFrameGuard("native");
        assert.throws(
          () => burst(encoder.encode("data: x\n\n".repeat(BoundedQueue.DEFAULT_MAX_ITEMS + 1))),
          BoundedQueue.BufferOverflow,
        );
      }),
  );
  it.effect("accepts a supported image frame and rejects incomplete over-limit SDK output", () =>
    Effect.gen(function* () {
      const image = "data: " + "a".repeat(7 * 1024 * 1024) + "\n\n";
      const original = new Response(image, {
        headers: { "content-type": "text/event-stream", "x-native": "retained" },
      });
      const supported = boundResponse(original);
      assert.equal(supported.headers.get("x-native"), "retained");
      assert.equal(yield* Effect.tryPromise(() => supported.text()), image);
      let cancelled = false;
      const source = new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(encoder.encode("x".repeat(BoundedQueue.MAX_PROMPT_BYTES)));
            controller.enqueue(encoder.encode("x"));
          },
          cancel: () => {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const failed = boundResponse(source);
      const error = yield* Effect.tryPromise({
        try: () => failed.text(),
        catch: (cause) => cause,
      }).pipe(Effect.flip);
      assert.instanceOf(error, BoundedQueue.BufferOverflow);
      assert.isTrue(cancelled);
    }),
  );
  it.effect("retires an overflowing SDK subscription without retrying its native stream", () =>
    Effect.gen(function* () {
      let requests = 0;
      let cancelled = false;
      const client = createOpencodeClient({
        baseUrl: "http://native.test",
        fetch: async () => {
          requests++;
          return boundResponse(
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) =>
                  controller.enqueue(encoder.encode("data: " + "x".repeat(32))),
                cancel: () => {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
            16,
          );
        },
      });
      const subscription = yield* Effect.tryPromise(() =>
        subscribeEvents(client, new AbortController().signal),
      );
      const error = yield* Effect.tryPromise({
        try: () => subscription.stream[Symbol.asyncIterator]().next(),
        catch: (cause) => cause,
      }).pipe(Effect.flip);
      assert.instanceOf(error, BoundedQueue.BufferOverflow);
      assert.equal(requests, 1);
      assert.isTrue(cancelled);
    }),
  );
});
