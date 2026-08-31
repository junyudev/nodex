import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { assert, it } from "@effect/vitest";
import { MainApplicationError } from "./MainApplication";
import { MainShutdown, layer } from "./MainShutdown";

it.layer(layer)("MainShutdown", (it) => {
  it.effect("keeps the first shutdown reason and first runtime exit", () =>
    Effect.gen(function* () {
      const shutdown = yield* MainShutdown;
      assert.isFalse(yield* shutdown.isRequested);
      assert.isTrue(yield* shutdown.request({ _tag: "UserQuit" }));
      assert.isFalse(yield* shutdown.request({ _tag: "UpdateInstall" }));
      assert.isTrue(yield* shutdown.isRequested);
      assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "UserQuit" });

      const first = Exit.fail(
        new MainApplicationError({
          phase: "runtime",
          operation: "test",
          cause: new Error("first"),
        }),
      );
      assert.isTrue(yield* shutdown.markRuntimeClosed(first));
      assert.isFalse(yield* shutdown.markRuntimeClosed(Exit.void));
      assert.strictEqual(yield* shutdown.awaitRuntimeClosed, first);
    }),
  );
});
