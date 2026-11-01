import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";

const target = (
  supportedRuntimeModes: ReadonlyArray<"approval-required" | "auto" | "full-access">,
) => ({
  modelSelection: { instanceId: ProviderInstanceId.make("agent"), model: "model" },
  supportedRuntimeModes,
});

it.effect("an inherited mode steps down to the broadest supported mode within the caller", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveRuntimeMode("full-access", "inherit", target(["approval-required", "auto"])),
      "auto",
    );
    // Nothing the provider offers fits under the caller: fall to the narrowest mode, never wider.
    assert.equal(
      yield* resolveRuntimeMode("approval-required", undefined, target(["full-access"])),
      "approval-required",
    );
  }),
);

it.effect("a child can narrow but never widen its caller's mode", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveRuntimeMode("full-access", "approval-required"),
      "approval-required",
    );
    const widened = yield* resolveRuntimeMode("auto", "full-access").pipe(Effect.result);
    assert.equal(widened._tag, "Failure");
  }),
);
