import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withSideChatForkFallback } from "./ProviderTurnStartService.ts";

it.effect("a side fork unavailable before dispatch uses its captured context exactly once", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const native = Effect.sync(() => {
      calls.push("fork");
    }).pipe(Effect.andThen(Effect.fail("history unavailable")));
    const result = yield* withSideChatForkFallback(
      native,
      () =>
        Effect.sync(() => {
          calls.push("fresh portable child");
          return "captured context";
        }),
      true,
    );
    assert.equal(result, "captured context");
    assert.deepEqual(calls, ["fork", "fresh portable child"]);
  }),
);

it.effect(
  "ordinary fork errors remain errors and a successful native side fork does not replay history",
  () =>
    Effect.gen(function* () {
      let fallbacks = 0;
      const portable = () =>
        Effect.sync(() => {
          fallbacks += 1;
          return "portable";
        });
      assert.equal(
        (yield* withSideChatForkFallback(Effect.fail("unavailable"), portable, false).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.equal(
        yield* withSideChatForkFallback(Effect.succeed("native"), portable, true),
        "native",
      );
      assert.equal(fallbacks, 0);
    }),
);
