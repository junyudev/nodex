import { DEFAULT_USAGE_METER_SETTINGS } from "../../shared/usage-meter-settings";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ApplicationSettings, type ApplicationSettingsSnapshot } from "./ApplicationSettings";

export function makeTestApplicationSettings(input?: {
  readonly detailLevel?: "STEPS_PROSE" | "STEPS_COMMANDS" | "STEPS_EXECUTION";
  readonly branchPrefix?: string;
  readonly commitInstructions?: string;
  readonly pullRequestInstructions?: string;
}): ApplicationSettings["Service"] {
  return ApplicationSettings.of({
    usageMeterSettingsChanges: Stream.succeed(DEFAULT_USAGE_METER_SETTINGS),
    composerPredictionSettingsChanges: Stream.empty,
    acpLaunchConfiguration: () => Effect.die("Unused ACP launch configuration"),
    openCodeLaunchConfiguration: () => Effect.die("Unused OpenCode launch configuration"),
    claudeLaunchConfiguration: () => Effect.die("Unused Claude launch configuration"),
    snapshot: () =>
      Effect.succeed({
        usageMeters: DEFAULT_USAGE_METER_SETTINGS,
        composerPredictions: { enabled: true },
        developer: { detailLevel: input?.detailLevel ?? "STEPS_COMMANDS" },
        git: {
          branchPrefix: input?.branchPrefix ?? "codex/",
          commitInstructions: input?.commitInstructions ?? "",
          pullRequestInstructions: input?.pullRequestInstructions ?? "",
        },
      } as ApplicationSettingsSnapshot),
    update: () => Effect.die("Unused ApplicationSettings update"),
  });
}
