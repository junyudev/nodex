import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { components } from "@nodex/core-protocol";
import { createUuidV7 } from "../../shared/uuid-v7";
import { notificationSession } from "./notification-session";
import { ManagedChatFacts, live as factsLive } from "./ManagedChatFacts";
import {
  diffManagedChatObservation,
  parseManagedChatObservation,
} from "./managed-chat-observation";

const BATCH_SIZE = 50;
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const facts = yield* ManagedChatFacts;
  const lane = yield* Semaphore.make(1);
  const observed = new Map<string, string>();
  const logger = getLogger({ component: "coordinator-monitor" });
    const now = yield* Clock.currentTimeMillis;
    const result = diffManagedChatObservation({
      facts: current,
      now,
    });
    if (
      result.events.length === 0
    ) {
      return;
    }
    yield* core.workspace.apply(
      {
        operationId: `coordinator:observe:${createUuidV7()}`,
        intent: {
        },
      },
      undefined,
      null,
    );
  });
      Effect.timeout("30 seconds"),
      Effect.catchCause(() =>
        Effect.sync(() =>
        ),
      ),
    );
  const sweep = lane.withPermits(1)(
    Effect.gen(function* () {
      let after: string | null = null;
      const live = new Set<string>();
      for (;;) {
        const page = yield* core.workspace.read(
          undefined,
          null,
        );
        yield* Effect.forEach(sessions, attempt, { concurrency: 4, discard: true });
        if (sessions.length < BATCH_SIZE) break;
        after = sessions.at(-1)!.session_id;
      }
      for (const id of observed.keys()) if (!live.has(id)) observed.delete(id);
    }).pipe(
    ),
  );
  const wake = Effect.fn("CoordinatorMonitor.wake")(function* (sessionId: string) {
    yield* lane.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* core.workspace.read(
          undefined,
          null,
        );
      }),
    );
  }, Effect.ignoreCause());
  return { sweep, wake };
});

/** Scope-owned occurrences are wakeups; Core snapshots and dedupe keys survive dropped wakeups. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep, wake } = yield* make;
    const core = yield* CoreModules;
    const notifier = yield* DatabaseNotifierRuntime;
    const hub = yield* CodexApplicationEventHub;
    yield* hub.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind !== "threadNotification") return Effect.void;
        const notification = event.value;
        return notificationSession(core, notification).pipe(
          Effect.flatMap((sessionId) => (sessionId ? wake(sessionId) : Effect.void)),
          Effect.ignore,
        );
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Stream.mergeAll(
      [
        notifier.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("120 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => sweep),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* sweep.pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(factsLive));
