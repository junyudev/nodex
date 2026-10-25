import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { AcpManagementError } from "./AcpFailures.ts";

/** Keep management work bound to the exact registry instance that admitted it. */
export const withCurrentAcpInstance = Effect.fn("AcpManagement.withCurrent")(function* <A, E, R>(
  registry: Pick<ProviderInstanceRegistry["Service"], "getInstance" | "subscribeChanges">,
  captured: ProviderInstance,
  task: Effect.Effect<A, E, R>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* registry.subscribeChanges;
      const changed = Effect.fail(
        new AcpManagementError({
          reason: "invalid_request",
          message: "The ACP configuration changed. Retry against the current instance.",
        }),
      );
      // Subscribe before checking, so replacements both before and after admission are covered.
      if ((yield* registry.getInstance(captured.instanceId)) !== captured) return yield* changed;
      const replaced = Stream.fromSubscription(changes).pipe(
        Stream.filterEffect(() =>
          registry
            .getInstance(captured.instanceId)
            .pipe(Effect.map((current) => current !== captured)),
        ),
        Stream.runHead,
        Effect.andThen(changed),
      );
      return yield* Effect.raceFirst(task, replaced);
    }),
  );
});
