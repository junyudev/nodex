import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { spaceHeld } from "../work-application/execution-holds";

type Decision = components["schemas"]["NodexDecisionRunInput"];

// An independent fixed budget keeps the previous eight-request assessment pass.
export const ASSESSMENT_CAPACITY = 8;

const shortSubject = (subject: string) =>
  Array.from(subject.replace(/\s+/g, " ").trim()).slice(0, 100).join("");

/** Both producers reserve capacity against the outstanding durable deliveries. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const lanes = {
    routing: yield* Semaphore.make(1),
    assessment: yield* Semaphore.make(1),
  };
  const hasCapacity = Effect.fn("DecisionRuns.hasCapacity")(function* (kind: Decision["kind"]) {
    const snapshot = yield* core.workspace.read({ kind: "decision_run_reservations" });
    if (snapshot.value.kind !== "decision_run_reservations")
      return yield* Effect.die("Invalid decision run reservations");
    const capacity =
      kind === "routing"
        ? (yield* settings.snapshot()).inbox.suggestionConcurrency
        : ASSESSMENT_CAPACITY;
    return snapshot.value[kind] < capacity;
  });
  const begin = <E>(
    decision: Decision,
    title: string,
    deliver: (sessionId: string) => Effect.Effect<void, E>,
  ) =>
    lanes[decision.kind].withPermit(
      Effect.gen(function* () {
        if (yield* spaceHeld(core)) return false;
        if (!(yield* hasCapacity(decision.kind))) return false;
        const { suggestionAgent } = (yield* settings.snapshot()).inbox;

        const modelSelection = yield* resolveInboxModel(runtime, suggestionAgent, "suggestion");
        const sessionId = yield* runtime.prepareDecisionRun({ decision, title, modelSelection });
        if (!sessionId || (yield* spaceHeld(core)) || !(yield* hasCapacity(decision.kind)))
          return false;
        yield* deliver(sessionId);
        return true;
      }),
    );
  const routingTitle = Effect.fn("DecisionRuns.routingTitle")(function* (ids: readonly string[]) {
    if (ids.length !== 1) return `Nodex · Routing ${ids.length} messages`;
    const result = yield* core.workspace.read({ kind: "inbox_entry", page_id: ids[0]! });
    const title = result.value.kind === "inbox_entry" ? result.value.item?.title : null;
    return title ? `Nodex · Routing “${shortSubject(title)}”` : "Nodex · Routing a message";
  });
  return { begin, hasCapacity, routingTitle };
});

export class DecisionRuns extends Context.Service<DecisionRuns, Effect.Success<typeof make>>()(
  "nodex/DecisionRuns",
) {}
export const live = Layer.effect(DecisionRuns, make);

/** How long a decision whose request ended may keep working on its last words. */
export const DECISION_RETIREMENT_GRACE_MS = 90_000;

export const makeRetirement = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  // When each still-working run was first seen retired; a restart only lengthens its grace.
  const firstSeen = new Map<string, number>();
  const reconcile = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let after_session_id: string | undefined;
    for (;;) {
      const snapshot = yield* core.workspace.read({
        kind: "retired_decision_runs",
        after_session_id,
      });
      if (snapshot.value.kind !== "retired_decision_runs")
        return yield* Effect.die("Invalid retired decision runs");
      const { runs } = snapshot.value;
      if (runs.length === 0) return;
      after_session_id = runs.at(-1)!.session_id;
      yield* Effect.forEach(
        runs,
        (run) =>
          runtime
            .retireDecisionRun(run.session_id, {
              stopWorking:
                now - (firstSeen.get(run.session_id) ?? now) >= DECISION_RETIREMENT_GRACE_MS,
            })
            .pipe(
              Effect.tap((outcome) =>
                Effect.sync(() => {
                  if (outcome === "waiting" && !firstSeen.has(run.session_id))
                    firstSeen.set(run.session_id, now);
                  else if (outcome !== "waiting") firstSeen.delete(run.session_id);
                }),
              ),
              Effect.timeout("10 seconds"),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
              ),
            ),
        { concurrency: 4, discard: true },
      );
    }
  }).pipe(Effect.catch((error) => Effect.logDebug("Decision retirement awaits Core", error)));
  return { reconcile };
});

export const retirement = Layer.effectDiscard(
  Effect.gen(function* () {
    const { reconcile } = yield* makeRetirement;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.inboxInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.prepend([undefined]),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );
  }),
);
