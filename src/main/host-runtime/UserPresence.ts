import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makePhoneViews, UserPresence, type UserPresenceService } from "../../host/UserPresence";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { SystemActivity, live as systemActivityLive } from "../platform/electron/SystemActivity";
import { desktopAttendanceSince } from "../../host/UserPresencePolicy";

/**
 * The personal Space's presence, from this desktop: which of its windows and phones show a chat,
 * and whether its one person is at this computer.
 */
export const make: Effect.Effect<
  UserPresenceService,
  never,
  CodexApplicationEventHub | CodexRendererPresentationRegistry | SystemActivity
> = Effect.gen(function* () {
  const windows = yield* CodexRendererPresentationRegistry;
  const activity = yield* SystemActivity;
  const phones = yield* makePhoneViews;

  return UserPresence.of({
    isSeen: (target) =>
      windows.isPresentedInForeground(target.conversationId, target.hostId) ||
      phones.isOnAnyPhone(target),
    isOnPhone: phones.isOnPhone,
    showOnPhone: phones.showOnPhone,
    attendanceSince: (sinceMillis) =>
      Effect.gen(function* () {
        for (;;) {
          const decision = desktopAttendanceSince(
            yield* activity.sample,
            sinceMillis,
            yield* Clock.currentTimeMillis,
          );
          if (decision.type !== "undecided") return decision.type;
          yield* Effect.raceFirst(
            Effect.sleep(decision.recheckAfterMillis),
            Stream.runHead(activity.locks),
          );
        }
      }),
  });
});

export const live: Layer.Layer<
  UserPresence,
  never,
  CodexApplicationEventHub | CodexRendererPresentationRegistry
> = Layer.effect(UserPresence, make).pipe(Layer.provide(systemActivityLive));
