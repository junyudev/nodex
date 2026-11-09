import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { make, NotificationIntentPresentation } from "./NotificationIntents";

it.effect("retains notification intents until a presentation sink can accept them", () =>
  Effect.gen(function* () {
    let available = false;
    let claims = 0;
    let deliveries = 0;
    const producer = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: { kind: string }) =>
            Effect.succeed({
              value:
                input.kind === "inbox_turn_notifications"
                  ? {
                      kind: input.kind,
                      intents: [{ member_id: "member", page_id: "page", episode: "one" }],
                    }
                  : {
                      kind: "inbox_entry",
                      item: { title: "Review", turn: { turn: { episode: "one" } } },
                    },
            }),
          apply: () =>
            Effect.sync(() => ({
              receipt: { duplicate: claims++ > 0 },
              outcome: { inbox_write: { replay: false } },
            })),
        },
      } as never),
      Effect.provide(
        Layer.succeed(NotificationIntentPresentation, {
          available: Effect.sync(() => available),
          publish: () =>
            Effect.sync(() => {
              deliveries++;
            }),
        }),
      ),
    );
    yield* producer.drain;
    expect(claims).toBe(0);
    available = true;
    yield* producer.drain;
    yield* producer.drain;
    expect(claims).toBe(2);
    expect(deliveries).toBe(1);
  }),
);

it.effect("never claims an intent whose Turn episode changed", () =>
  Effect.gen(function* () {
    let published = false;
    const producer = yield* make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: (input: { kind: string }) =>
            Effect.succeed({
              value:
                input.kind === "inbox_turn_notifications"
                  ? {
                      kind: input.kind,
                      intents: [{ member_id: "member", page_id: "page", episode: "old" }],
                    }
                  : { kind: "inbox_entry", item: { turn: { turn: { episode: "current" } } } },
            }),
          apply: () => Effect.die("A stale intent cannot be claimed"),
        },
      } as never),
      Effect.provideService(NotificationIntentPresentation, {
        available: Effect.succeed(true),
        publish: () =>
          Effect.sync(() => {
            published = true;
          }),
      }),
    );
    yield* producer.drain;
    expect(published).toBe(false);
  }),
);
