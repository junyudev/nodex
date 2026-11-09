import { effectiveHolds } from "./execution-holds";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { createOperationId } from "../../main/core-runtime/operation-identity";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../../main/logging/logger";
import { WorkApplication } from "./WorkApplication";

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const work = yield* WorkApplication;
  const lane = yield* Semaphore.make(1);
  const logger = getLogger({ component: "work-scheduler" });
  let afterPageId: string | null = null;
  const sweep = lane.withPermits(1)(
    Effect.gen(function* () {
      const ready = yield* core.database.read(
        { kind: "ready_work", project_id: null, limit: 100, after_page_id: afterPageId },
        null,
      );
      if (ready.value.kind !== "ready_work") return;
      afterPageId = ready.value.pages.length === 100 ? ready.value.pages.at(-1)!.page_id : null;
      for (const page of ready.value.pages) {
        if ((yield* effectiveHolds(core, { kind: "page", page_id: page.page_id })).length) continue;
        const epoch = createHash("sha256")
          .update(JSON.stringify([page.page_id, page.readiness_epoch]))
          .digest("hex");
        const task = page.page_work.auto_start
          ? work
              .startWork({
                pageId: page.page_id,
                launchId: `work:${epoch}`,
                readinessEpoch: page.readiness_epoch,
              })
              .pipe(Effect.asVoid)
          : core.workspace
              .apply(
                {
                  operationId: createOperationId("work.ready"),
                  intent: {
                    kind: "record_work_events",
                    observed: [],
                    events: [
                      {
                        kind: "ready_to_start",
                        page_id: page.page_id,
                        session_id: null,
                        dedupe_key: `ready_to_start:${page.page_id}:${page.readiness_epoch}`,
                        payload: {
                          prerequisites: page.prerequisites,
                          readiness_epoch: page.readiness_epoch,
                        },
                      },
                    ],
                  },
                },
                undefined,
                null,
              )
              .pipe(Effect.asVoid);
        yield* task.pipe(
          Effect.catchCause(() =>
            Effect.sync(() =>
              logger.warn("Page work awaits a later readiness pass", { pageId: page.page_id }),
            ),
          ),
        );
      }
    }).pipe(Effect.catchCause(() => Effect.sync(() => logger.warn("Work readiness pass failed")))),
  );
  return { sweep };
});
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.workInvalidations,
        Stream.fromSchedule(Schedule.spaced("60 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => sweep),
      Effect.forkScoped,
    );
    yield* sweep.pipe(Effect.forkScoped);
  }),
);
