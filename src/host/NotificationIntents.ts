import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../main/host-runtime/DatabaseNotifierRuntime";

/** A missing sink retains durable intents; presentation policy runs after a successful claim. */
export class NotificationIntentPresentation extends Context.Service<
  NotificationIntentPresentation,
  {
    readonly available: Effect.Effect<boolean>;
    readonly publish: (
      intent: components["schemas"]["InboxTurnNotification"],
      row: components["schemas"]["ProjectWorkspaceInboxItem"],
    ) => Effect.Effect<void>;
  }
>()("nodex/host/NotificationIntentPresentation") {}
export const headless = Layer.succeed(NotificationIntentPresentation, {
  available: Effect.succeed(false),
  publish: () => Effect.void,
});

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const presentation = yield* NotificationIntentPresentation;
  const lane = yield* Semaphore.make(1);
  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      if (!(yield* presentation.available)) return;
      const snapshot = yield* core.workspace.read(
        { kind: "inbox_turn_notifications" },
        undefined,
        null,
      );
      if (snapshot.value.kind !== "inbox_turn_notifications") return;
      for (const intent of snapshot.value.intents) {
        const current = yield* core.workspace.read(
          { kind: "inbox_entry", page_id: intent.page_id },
          undefined,
          null,
        );
        if (
          current.value.kind !== "inbox_entry" ||
          current.value.item?.turn?.turn.episode !== intent.episode
        )
          continue;
        const row = current.value.item;
        const claim = yield* core.workspace
          .apply(
            {
              operationId: `turn-notify:${intent.member_id}:${intent.page_id}:${intent.episode}`,
              intent: {
                kind: "claim_turn_notification",
                page_id: intent.page_id,
                episode: intent.episode,
              },
            },
            undefined,
            null,
          )
          .pipe(Effect.result);
        if (
          claim._tag === "Failure" ||
          claim.success.receipt.duplicate ||
          claim.success.outcome.inbox_write?.replay
        )
          continue;
        yield* presentation.publish(intent, row);
      }
    }),
  );
  return { drain };
});
export class NodexEntryNotifications extends Context.Service<
  NodexEntryNotifications,
  Effect.Success<typeof make>
>()("nodex/NodexEntryNotifications") {}
export const live = Layer.effect(
  NodexEntryNotifications,
  Effect.gen(function* () {
    const service = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.inboxInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("120 millis"),
      Stream.runForEach(() => service.drain.pipe(Effect.ignoreCause())),
      Effect.forkScoped,
    );
    yield* service.drain.pipe(Effect.ignoreCause(), Effect.forkScoped);
    return service;
  }),
);
