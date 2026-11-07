import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { it } from "@effect/vitest";
import {
  encodePushKey,
  openPushPayload,
  RelayPushRequestSchema,
  PUSH_BODY_MAX_CHARS,
  PUSH_TITLE_MAX_CHARS,
  type RelayPushRequest,
} from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { live as files } from "../platform/node/MobileProfileFiles";
import { make as relay, MobilePushRelay } from "../platform/node/MobilePushRelay";
import { makePushDelivery, type PushRecipient } from "./push-delivery";
import type { MobilePushEvent } from "./push-events";

const event = (
  id: string,
  kind: MobilePushEvent["payload"]["kind"] = "finished",
): MobilePushEvent => ({
  id,
  payload: { kind, sessionId: "chat", title: "🙂".repeat(160), body: "🙂".repeat(300) },
});

it.effect("posts only sealed payloads to an injectable relay and forgets 410 registrations", () =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<RelayPushRequest>();
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const received: RelayPushRequest[] = [];
        const server = createServer(async (request, response) => {
          expect(request.url).toBe("/v1/push");
          expect(request.method).toBe("POST");
          expect(request.headers["content-type"]).toBe("application/json");
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = RelayPushRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
          received.push(body);
          Queue.offerUnsafe(requests, body);
          response.writeHead(body.handle === "gone" ? 410 : 200).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No listener");
        return { server, received, origin: `http://127.0.0.1:${address.port}` };
      }),
      ({ server }) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
    const key = randomBytes(32);
    const recipient: PushRecipient = {
      deviceId: "phone",
      hostId: "host",
      registration: {
        handle: "opaque",
        key: encodePushKey(key),
        preferences: { needsYou: true, finished: true },
      },
    };
    const forgotten = yield* Queue.unbounded<string>();
    const enqueue = yield* makePushDelivery({
      recipients: Effect.succeed([recipient]),
      isCurrent: () => Effect.succeed(true),
      forget: (phone) => Queue.offer(forgotten, phone.deviceId).pipe(Effect.asVoid),
    }).pipe(Effect.provide(files), Effect.provideService(MobilePushRelay, relay(server.origin)));
    yield* enqueue(event("first", "needs_you"));
    const first = yield* Queue.take(requests);
    expect(Object.keys(first).sort()).toEqual(["handle", "sealed", "urgency"]);
    expect(first.urgency).toBe("time-sensitive");
    const opened = openPushPayload(key, first.sealed);
    expect(opened).toMatchObject({ kind: "needs_you", sessionId: "chat" });
    expect(Array.from(opened!.title)).toHaveLength(PUSH_TITLE_MAX_CHARS);
    expect(Array.from(opened!.body)).toHaveLength(PUSH_BODY_MAX_CHARS);
    yield* enqueue(event("second"));
    const second = yield* Queue.take(requests);
    expect(second.urgency).toBe("active");
    expect(second.sealed).not.toBe(first.sealed);
    yield* enqueue(event("first", "needs_you"));
    recipient.registration.handle = "gone";
    yield* enqueue(event("gone"));
    yield* Queue.take(requests);
    expect(yield* Queue.take(forgotten)).toBe("phone");
    expect(server.received).toHaveLength(3);
  }),
);

it.effect(
  "bounds retries for throttling, server and transport failures, and stops retrying revoked work",
  () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      const recipient: PushRecipient = {
        deviceId: "phone",
        hostId: "host",
        registration: {
          handle: "opaque",
          key: encodePushKey(randomBytes(32)),
          preferences: { needsYou: true, finished: true },
        },
      };
      let current = true;
      let count = 0;
      const responses = [429, 503, "transport", 400, 503] as const;
      const enqueue = yield* makePushDelivery({
        recipients: Effect.succeed([recipient]),
        isCurrent: () => Effect.succeed(current),
        forget: () => Effect.void,
      }).pipe(
        Effect.provide(files),
        Effect.provideService(MobilePushRelay, {
          send: () =>
            Effect.gen(function* () {
              const status = responses[count++] ?? 200;
              yield* Queue.offer(attempts, count);
              return status === "transport" ? yield* Effect.fail("transport" as const) : status;
            }),
        }),
      );
      yield* enqueue(event("retry"));
      expect(yield* Queue.take(attempts)).toBe(1);
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(attempts)).toBe(2);
      yield* TestClock.adjust("500 millis");
      expect(yield* Queue.take(attempts)).toBe(3);
      yield* TestClock.adjust("1 minute");
      expect(count).toBe(3);
      yield* enqueue(event("bad"));
      expect(yield* Queue.take(attempts)).toBe(4);
      yield* TestClock.adjust("1 minute");
      expect(count).toBe(4);
      yield* enqueue(event("revoke"));
      expect(yield* Queue.take(attempts)).toBe(5);
      current = false;
      yield* TestClock.adjust("1 minute");
      expect(count).toBe(5);
    }),
);

it.effect("filters preferences and remains responsive when relay requests time out", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<void>();
    let count = 0;
    const recipient: PushRecipient = {
      deviceId: "phone",
      hostId: "host",
      registration: {
        handle: "opaque",
        key: encodePushKey(randomBytes(32)),
        preferences: { needsYou: false, finished: true },
      },
    };
    const enqueue = yield* makePushDelivery({
      recipients: Effect.succeed([recipient]),
      isCurrent: () => Effect.succeed(true),
      forget: () => Effect.void,
    }).pipe(
      Effect.provide(files),
      Effect.provideService(MobilePushRelay, {
        send: () =>
          Effect.gen(function* () {
            count++;
            yield* Queue.offer(attempts, undefined);
            return yield* Effect.never;
          }),
      }),
    );
    yield* enqueue(event("ignored", "needs_you"));
    yield* TestClock.adjust("1 minute");
    expect(count).toBe(0);
    yield* enqueue(event("timeout"));
    yield* Queue.take(attempts);
    yield* TestClock.adjust("6 seconds");
    yield* Queue.take(attempts);
    yield* TestClock.adjust("6 seconds");
    yield* Queue.take(attempts);
    yield* TestClock.adjust("1 minute");
    expect(count).toBe(3);
    recipient.registration.preferences = { needsYou: true, finished: false };
    yield* enqueue(event("ignored-finished"));
    yield* enqueue(event("ignored-failed", "failed"));
    yield* TestClock.adjust("1 minute");
    expect(count).toBe(3);
  }),
);
