import {
  PUSH_BODY_MAX_CHARS,
  PUSH_NONCE_BYTES,
  PUSH_TITLE_MAX_CHARS,
  decodePushKey,
  sealPushPayload,
  type PushPayload,
  type PushRegistration,
} from "@nodex/mobile-protocol";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { MobilePushRelay } from "../../main/platform/node/MobilePushRelay";

export interface PushRecipient {
  readonly deviceId: string;
  /** The Member whose Device this is: the one Member a chat event concerns. */
  readonly memberId: string;
  /** The Space and Member enrollment as the phone knows it, so a tap opens the right Space. */
  readonly hostId: string;
  readonly registration: PushRegistration;
}

/** What a phone is told, before its enrollment's `hostId` is added. */
export type PushMessage = Pick<PushPayload, "kind" | "sessionId" | "pageId" | "title" | "body">;

/** Where pushes go. Core chooses the Member; the phone relay knows which Devices are live. */
export interface PushTargets {
  /**
   * The registered Devices, without a live channel, of the Member a chat event concerns by
   * Core's answer-entitlement rule. Empty when it concerns nobody.
   */
  readonly recipients: (
    /** The chat the event happened in; a Page Turn may wait on none. */
    sessionId: string | null,
    audience: components["schemas"]["PhonePushAudience"],
  ) => Effect.Effect<readonly PushRecipient[]>;
  /**
   * How long since the Member used one of their desktops that reports to this Space and vouches
   * for them now, or null when none does. Revoked Devices never vouch.
   */
  readonly presence: (memberId: string) => Effect.Effect<number | null>;
  /** Still without a live channel at the moment of sending. */
  readonly isCurrent: (recipient: PushRecipient) => Effect.Effect<boolean>;
  /** The relay no longer reaches this registration. */
  readonly forget: (recipient: PushRecipient) => Effect.Effect<void>;
}

const truncate = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");

/**
 * Bounded, lossy delivery: relay latency and failure never hold a channel or the attention
 * occurrences. Each Device is sealed for separately, with its own key and preferences.
 */
export const makePushDelivery = Effect.fn("MobilePushDelivery.make")(function* (
  targets: Pick<PushTargets, "isCurrent" | "forget">,
) {
  const relay = yield* MobilePushRelay;
  const queue = yield* Queue.dropping<{
    readonly recipient: PushRecipient;
    readonly message: PushMessage;
  }>(128);
  const deliver = (recipient: PushRecipient, message: PushMessage) =>
    Effect.gen(function* () {
      const attempt = Effect.gen(function* () {
        if (!(yield* targets.isCurrent(recipient))) return;
        const payload = {
          ...message,
          hostId: recipient.hostId,
          title: truncate(message.title, PUSH_TITLE_MAX_CHARS),
          body: truncate(message.body, PUSH_BODY_MAX_CHARS),
        };
        const sealed = sealPushPayload(
          decodePushKey(recipient.registration.key),
          crypto.getRandomValues(new Uint8Array(PUSH_NONCE_BYTES)),
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
        if (status === 410) return yield* targets.forget(recipient);
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
      Queue.take(queue).pipe(
        Effect.flatMap(({ recipient, message }) => deliver(recipient, message)),
      ),
    ).pipe(Effect.forkScoped);
  }
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  return (recipients: readonly PushRecipient[], message: PushMessage) =>
    Effect.forEach(
      recipients,
      (recipient) => {
        const { needsYou, finished } = recipient.registration.preferences;
        return (message.kind === "needs_you" ? needsYou : finished)
          ? Queue.offer(queue, { recipient, message })
          : Effect.void;
      },
      { discard: true },
    );
});
