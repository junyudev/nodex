import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type { components } from "@nodex/core-protocol";
import { GitHubChannelAdapter, ChannelSendError } from "./GitHubChannelAdapter";
type Model = components["schemas"];
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const github = yield* GitHubChannelAdapter;
  const gate = yield* Semaphore.make(1);
  const apply = (command: Model["SourceCommand"]) =>
    core.workspace.apply(
      { operationId: createOperationId("channel"), intent: { kind: "source", command } },
      undefined,
      null,
    );
  const send = Effect.fn("ChannelSender.send")(function* (item: Model["ChannelOutboxItem"]) {
    if (!["pending", "sending"].includes(item.state)) return;
    const token = createOperationId("channel-lease");
    const claimed = yield* apply({
      kind: "claim_channel_send",
      id: item.id,
      lease_token: token,
      lease_duration_ms: 120000,
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!claimed) return;
    const outcome = yield* github.send(item).pipe(Effect.timeout("90 seconds"), Effect.result);
    const error =
      outcome._tag === "Failure" && Schema.is(ChannelSendError)(outcome.failure)
        ? outcome.failure
        : null;
    yield* apply({
      kind: "settle_channel_send",
      id: item.id,
      lease_token: token,
      receipt: outcome._tag === "Success" ? outcome.success : null,
      failure:
        outcome._tag === "Failure"
          ? (error?.reason ?? "GitHub reply could not be confirmed")
          : null,
      permanent: error?.permanent ?? false,
      credential_invalid: error?.credentialInvalid ?? false,
    });
  });
  const drain = gate
    .withPermits(1)(
      Effect.gen(function* () {
        let after: string | null = null;
        while (true) {
            yield* core.workspace.read(
              { kind: "sources", read: { kind: "channel_outbox", after_id: after, limit: 100 } },
              undefined,
              null,
            );
          if (snapshot.value.kind !== "sources" || snapshot.value.value.kind !== "channel_outbox")
            return;
          const items = snapshot.value.value.items;
          for (const item of items) yield* send(item).pipe(Effect.ignore);
          if (items.length < 100) return;
          after = items.at(-1)!.id;
        }
      }),
    )
    .pipe(Effect.provideService(CoreApplicationAgent, null));
  return { drain };
});
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const sender = yield* make;
    yield* sender.drain.pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
  }),
);
