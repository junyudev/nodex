import {
  PUSH_BODY_MAX_CHARS,
  PUSH_NONCE_BYTES,
  PUSH_TITLE_MAX_CHARS,
  decodePushKey,
  sealPushPayload,
  type PushRegistration,
} from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { MobileProfileFiles } from "../platform/node/MobileProfileFiles";
import { MobilePushRelay } from "../platform/node/MobilePushRelay";
import type { MobilePushEvent } from "./push-events";

export interface PushRecipient {
  readonly deviceId: string;
  /** This desktop, as the phone knows it. */
  readonly hostId: string;
  readonly registration: PushRegistration;
}
const truncate = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");

/** Bounded, lossy delivery: relay latency and failure never hold a channel or execution observer. */
export const makePushDelivery = Effect.fn("MobilePushDelivery.make")(function* (options: {
  readonly recipients: Effect.Effect<readonly PushRecipient[]>;
  readonly isCurrent: (recipient: PushRecipient) => Effect.Effect<boolean>;
  readonly forget: (recipient: PushRecipient) => Effect.Effect<void>;
}) {
  const files = yield* MobileProfileFiles;
  const relay = yield* MobilePushRelay;
  const queue = yield* Queue.dropping<{ recipient: PushRecipient; event: MobilePushEvent }>(128);
  const seen = new Set<string>();
  const deliver = (recipient: PushRecipient, event: MobilePushEvent) =>
    Effect.gen(function* () {
      const attempt = Effect.gen(function* () {
        if (!(yield* options.isCurrent(recipient))) return;
        const payload = {
          ...event.payload,
          hostId: recipient.hostId,
          title: truncate(event.payload.title, PUSH_TITLE_MAX_CHARS),
          body: truncate(event.payload.body, PUSH_BODY_MAX_CHARS),
        };
        const sealed = sealPushPayload(
          decodePushKey(recipient.registration.key),
          files.randomBytes(PUSH_NONCE_BYTES),
          payload,
        );
        const status = yield* relay
          .send({
            handle: recipient.registration.handle,
            sealed,
            urgency: payload.kind === "needs_you" ? "time-sensitive" : "active",
          })
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(() => "retry" as const),
          );
        if (status === 410) return yield* options.forget(recipient);
        if (status === 429 || (status >= 500 && status < 600))
          return yield* Effect.fail("retry" as const);
        if (status < 200 || status >= 300)
          yield* Effect.logWarning("Mobile notification relay rejected delivery");
      });
      yield* attempt.pipe(
        Effect.retry(Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 2 }))),
        Effect.catchCause(() => Effect.logWarning("Mobile notification delivery failed")),
      );
    });
  for (let worker = 0; worker < 4; worker++) {
    yield* Effect.forever(
      Effect.gen(function* () {
        const { recipient, event } = yield* Queue.take(queue);
        yield* deliver(recipient, event);
      }),
    ).pipe(Effect.forkScoped);
  }
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  return (event: MobilePushEvent) =>
    Effect.gen(function* () {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      const recipients = yield* options.recipients;
      for (const recipient of recipients) {
        const preferences = recipient.registration.preferences;
        if (event.payload.kind === "needs_you" ? !preferences.needsYou : !preferences.finished)
          continue;
        yield* Queue.offer(queue, { recipient, event });
      }
    });
});
