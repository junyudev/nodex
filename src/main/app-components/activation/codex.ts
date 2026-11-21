import * as Effect from "effect/Effect";
import { CodexPlatform } from "../../../host/ProviderPlatform";
import { MainConfig } from "../../app/MainConfig";
import type { CodexPackage } from "../../codex/CodexPackage";
import type {
  AppComponentActivator,
  AppComponentActivationResult,
} from "../AppComponentActivation";
import { appComponentDefinition, appComponentHome } from "../AppComponentCatalog";
import { appComponentRoot } from "../AppComponentStore";

export const makeCodexActivator = (
  runtime: CodexPackage,
  root: string | null,
  startup = Effect.sync(() => runtime.current),
): AppComponentActivator => {
  const isStorePackage = (value: CodexPackage["current"]) =>
    value.status === "available" && value.package.rootPath === root;
  return {
    activate: Effect.suspend(() => {
      if (!root)
        return Effect.succeed({
          status: "rejected",
          message: "Codex is unavailable on this build.",
        });
      return runtime.activate(root).pipe(
        Effect.map((availability): AppComponentActivationResult => {
          if (isStorePackage(availability)) return { status: "active" };
          return {
            status: "rejected",
            message:
              availability.status === "unavailable"
                ? availability.message
                : "The active Codex package is outside the Component store.",
          };
        }),
      );
    }),
    isActive: startup.pipe(Effect.map(isStorePackage)),
  };
};

export const codexActivator = Effect.gen(function* () {
  const config = yield* MainConfig;
  const platform = yield* CodexPlatform;
  const definition = appComponentDefinition(config, "codex");
  return makeCodexActivator(
    platform.package,
    definition ? appComponentRoot(appComponentHome(config), definition) : null,
    platform.packageAfterStartupCheck,
  );
});
