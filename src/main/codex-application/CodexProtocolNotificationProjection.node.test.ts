import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexProtocolNotificationProjection, live } from "./CodexProtocolNotificationProjection";

it.effect(
  "projects native skill changes without requiring a conversation or Apps availability",
  () =>
    Effect.gen(function* () {
      const events: CodexApplicationEvent[] = [];
      const projection = yield* CodexProtocolNotificationProjection.pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This test owns the complete projection application boundary.
        Effect.provide(
          live({ supportsChatGptApps: false }).pipe(
            Layer.provide(
              Layer.succeed(CodexApplicationEventHub, {
                events: Stream.empty,
                publish: (event) => {
                  events.push(event);
                },
              }),
            ),
          ),
        ),
      );
      assert.isTrue(yield* projection.observe({ method: "skills/changed", params: {} }));
      assert.deepEqual(events, [{ kind: "codex", value: { type: "skillsChanged" } }]);
    }),
);
