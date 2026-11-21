import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { CodexPlatform } from "../../../host/ProviderPlatform";
import type {
  AppComponentActivator,
  AppComponentActivationResult,
} from "../AppComponentActivation";

export const desktopToolsActivator = Effect.gen(function* () {
  const { desktopTools } = yield* CodexPlatform;
  const activation = desktopTools.browserRuntimeActivation;
  return {
    activate: Effect.suspend(() => {
      if (activation?.source !== "component")
        return Effect.succeed({
          status: "rejected",
          message: "Desktop Tools cannot be installed as a component on this build.",
        } as const);
      return activation.activate.pipe(
        Effect.timed,
        Effect.tap(([duration, result]) =>
          result.status === "available"
            ? Effect.logInfo("Desktop Tools runtime activated").pipe(
                Effect.annotateLogs({
                  rootPath: result.bundle.rootPath,
                  verificationMs: Math.round(Duration.toMillis(duration)),
                }),
              )
            : Effect.void,
        ),
        Effect.match({
          onFailure: ({ cause }): AppComponentActivationResult => ({
            status: "rejected",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
          onSuccess: ([, result]): AppComponentActivationResult =>
            result.status === "available"
              ? { status: "active" }
              : { status: "rejected", message: result.message },
        }),
      );
    }),
    isActive: Effect.sync(
      () =>
        activation?.source === "component" && desktopTools.browserRuntime.status === "available",
    ),
  } satisfies AppComponentActivator;
});
