import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { components } from "@nodex/core-protocol";
import {
  DESKTOP_AWAY_AFTER_MILLIS,
  PRESENCE_REPORT_INTERVAL_MILLIS,
  type ActivitySample,
} from "../../host/UserPresencePolicy";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { SystemActivity, live as systemActivityLive } from "../platform/electron/SystemActivity";

type Report = components["schemas"]["MemberPresenceReport"];

/** What this desktop says: how long since its person used it, or nothing behind a locked screen. */
export const presenceReport = (sample: ActivitySample): Report => ({
  idle_ms: sample.locked || sample.idleMillis === null ? null : Math.round(sample.idleMillis),
});

const attended = (sample: ActivitySample) =>
  !sample.locked && sample.idleMillis !== null && sample.idleMillis < DESKTOP_AWAY_AFTER_MILLIS;

/**
 * Tells a team Space whether its Member is at this computer, for the host that decides when
 * their phones hear about a chat. While someone uses it, a report goes every 30 seconds and at
 * once when the screen locks; once nobody is here, one last report says so and the desktop stays
 * quiet until they return. Core forgets reports that stop coming.
 */
export const run = Effect.fn("RemotePresence.run")(function* (options: {
  readonly sample: Effect.Effect<ActivitySample>;
  /** Emits each time the screen locks. */
  readonly locks: Stream.Stream<void>;
  readonly send: (report: Report) => Effect.Effect<void>;
}) {
  let reported = false;
  const tick = Effect.gen(function* () {
    const sample = yield* options.sample;
    const present = attended(sample);
    if (present || reported) yield* options.send(presenceReport(sample));
    reported = present;
  });
  yield* tick.pipe(
    Effect.andThen(
      Effect.raceFirst(
        Effect.sleep(PRESENCE_REPORT_INTERVAL_MILLIS),
        Stream.runHead(options.locks),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
});

/** One reporter per connected team Space, sent through that Space's authenticated Core. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const access = yield* CoreSessionAccess;
    const activity = yield* SystemActivity;
    yield* run({
      sample: activity.sample,
      locks: activity.locks,
      send: (report) =>
        access
          .use("host.presence", (client, signal) => {
            if (!client.reportPresence) throw new Error("This Core has no presence reports");
            return client.reportPresence(report, { signal });
          })
          .pipe(Effect.ignore),
    });
  }),
).pipe(Layer.provide(systemActivityLive));
