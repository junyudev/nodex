import { assert, it } from "@effect/vitest";
import type { ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeInMemoryStdio } from "./_internal/stdio";
import { make } from "./client";
import type { ServerNotificationMethod } from "./rpc";

const encoder = new TextEncoder();
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Finite]),
      method: Schema.String,
      params: Schema.Unknown,
    }),
  ),
);
const notificationMethod = "thread/realtime/item/completed" satisfies ServerNotificationMethod;
const receipt = {
  type: "bemItemPromoted",
  id: "receipt",
  realtimeSessionId: "session",
  turnId: "turn",
  itemId: "opening",
  presentation: { type: "wholeItem" },
} as const;
const nativePage = {
  data: [
    { type: "turnStarted", position: 0, turnId: "turn", startedAt: 1700000000 },
    {
      type: "item",
      position: 1,
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "opening",
        clientId: null,
        content: [{ type: "text", text: "Hello", text_elements: [] }],
      },
    },
    { type: "realtime", position: 2, item: receipt },
    {
      type: "turnCompleted",
      position: 3,
      turnId: "turn",
      status: "completed",
      error: null,
      startedAt: 1700000000,
      completedAt: 1700000001,
      durationMs: 1000,
    },
  ],
  nextCursor: null,
  activeRealtimeSessionAtPageStart: "session",
} satisfies ThreadTimelineListResponse;

it.effect(
  "the physical client decodes native nonempty timeline boundaries, items, promotion and timing once",
  () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* make(stdio);
      const request = yield* client
        .request("thread/timeline/list", { threadId: "thread", cursor: null, limit: 500 })
        .pipe(Effect.forkScoped);
      const wire = decodeRequest(yield* Queue.take(output));
      assert.deepStrictEqual(
        { method: wire.method, params: wire.params },
        {
          method: "thread/timeline/list",
          params: { threadId: "thread", cursor: null, limit: 500 },
        },
      );
      yield* Queue.offer(
        input,
        encoder.encode(`${encodeJson({ id: wire.id, result: nativePage })}\n`),
      );
      assert.deepStrictEqual(yield* Fiber.join(request), nativePage);

      const notification = yield* client.notifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const params = { threadId: "thread", item: receipt };
      yield* Queue.offer(
        input,
        encoder.encode(`${encodeJson({ method: notificationMethod, params })}\n`),
      );
      assert.deepStrictEqual(yield* Fiber.join(notification), [
        { protocol: "generated", method: notificationMethod, params },
      ]);
    }),
);

it.effect(
  "the physical client rejects snake-case timeline aliases rather than silently accepting a second wire shape",
  () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* make(stdio);
      const request = yield* client
        .request("thread/timeline/list", { threadId: "thread", cursor: null })
        .pipe(Effect.result, Effect.forkScoped);
      const wire = decodeRequest(yield* Queue.take(output));
      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeJson({ id: wire.id, result: { ...nativePage, data: [{ type: "turnStarted", position: 0, turn_id: "turn", started_at: 1700000000 }] } })}\n`,
        ),
      );
      const result = yield* Fiber.join(request);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "CodexAppServerRequestError");
        if (result.failure._tag === "CodexAppServerRequestError") {
          assert.strictEqual(result.failure.method, "thread/timeline/list");
          assert.strictEqual(result.failure.operation, "decode-payload");
        }
      }
    }),
);
