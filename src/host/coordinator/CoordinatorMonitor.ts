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

type Observer = components["schemas"]["SessionExecutionObserver"];
const BATCH_SIZE = 50;
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const facts = yield* ManagedChatFacts;
  const lane = yield* Semaphore.make(1);
  const observed = new Map<string, string>();
  const logger = getLogger({ component: "coordinator-monitor" });
  const capture = Effect.fn("CoordinatorMonitor.capture")(function* (observer: Observer) {
    const current = yield* facts.read(observer.session_id);
    const now = yield* Clock.currentTimeMillis;
    const eventPrevious = parseManagedChatObservation(observer.managed?.observed_json);
    const previous = parseManagedChatObservation(observer.observation);
    const result = diffManagedChatObservation({
      sessionId: observer.session_id,
      previous: previous ?? eventPrevious,
      eventPrevious: observer.managed ? eventPrevious : undefined,
      facts: current,
      now,
      restartStallClock: observed.get(observer.session_id) !== observer.since,
      latestReportAt: observer.managed?.latest_report_at
        ? Date.parse(observer.managed?.latest_report_at)
        : null,
    });
    if (
      JSON.stringify(result.observed) === JSON.stringify(previous) &&
      (!observer.managed ||
        current.state === "unavailable" ||
        JSON.stringify(result.observed) === JSON.stringify(eventPrevious)) &&
      result.events.length === 0
    ) {
      observed.set(observer.session_id, observer.since);
      return;
    }
    yield* core.workspace.apply(
      {
        operationId: `coordinator:observe:${createUuidV7()}`,
        intent: {
          kind: "record_session_execution",
          session_id: observer.session_id,
          expected_revision: observer.revision,
          observation: result.observed,
          events: observer.managed ? result.events : [],
          resolved_request_ids: observer.managed ? result.resolvedRequestIds : [],
        },
      },
      undefined,
      null,
    );
    observed.set(observer.session_id, observer.since);
  });
  const attempt = (observer: Observer) =>
    capture(observer).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchCause(() =>
        Effect.sync(() =>
          logger.warn("Chat execution observation awaits retry", {
            sessionId: observer.session_id,
          }),
        ),
      ),
    );
  const sweep = lane.withPermits(1)(
    Effect.gen(function* () {
      let after: string | null = null;
      const live = new Set<string>();
      for (;;) {
        const page = yield* core.workspace.read(
          { kind: "session_execution_observers", after_session_id: after, limit: BATCH_SIZE },
          undefined,
          null,
        );
        if (page.value.kind !== "session_execution_observers") return;
        const sessions: readonly Observer[] = page.value.observers;
        for (const observer of sessions) live.add(observer.session_id);
        yield* Effect.forEach(sessions, attempt, { concurrency: 4, discard: true });
        if (sessions.length < BATCH_SIZE) break;
        after = sessions.at(-1)!.session_id;
      }
      for (const id of observed.keys()) if (!live.has(id)) observed.delete(id);
    }).pipe(
      Effect.catchCause(() => Effect.sync(() => logger.warn("Chat execution sweep awaits retry"))),
    ),
  );
  const wake = Effect.fn("CoordinatorMonitor.wake")(function* (sessionId: string) {
    yield* lane.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* core.workspace.read(
          { kind: "session_execution_observer", session_id: sessionId },
          undefined,
          null,
        );
        if (snapshot.value.kind === "session_execution_observer" && snapshot.value.observer)
          yield* attempt(snapshot.value.observer);
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
    const runtimeActivity = yield* AgentRuntimeSessionActivity;
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
        runtimeActivity.activityChanges.pipe(Stream.map(() => undefined)),
        runtimeActivity.connectionChanges.pipe(Stream.map(() => undefined)),
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
