import { DEFAULT_MODEL_POLICY } from "../../shared/model-policy";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../shared/link-opening-settings";
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
    terminalShellSettingsChanges: Stream.empty,
    linkOpeningSettingsChanges: Stream.succeed(DEFAULT_LINK_OPENING_SETTINGS),
    modelPolicyChanges: Stream.succeed(DEFAULT_MODEL_POLICY),
    usageMeterSettingsChanges: Stream.succeed(DEFAULT_USAGE_METER_SETTINGS),
    composerPredictionSettingsChanges: Stream.empty,
    inboxSettingsChanges: Stream.empty,
    threadNotificationSettingsChanges: Stream.never,
    telemetrySettingsChanges: Stream.empty,
    acpLaunchConfiguration: () => Effect.die("Unused ACP launch configuration"),
    openCodeLaunchConfiguration: () => Effect.die("Unused OpenCode launch configuration"),
    claudeLaunchConfiguration: () => Effect.die("Unused Claude launch configuration"),
    snapshot: () =>
      Effect.succeed({
        linkOpening: DEFAULT_LINK_OPENING_SETTINGS,
        modelPolicy: DEFAULT_MODEL_POLICY,
        usageMeters: DEFAULT_USAGE_METER_SETTINGS,
        terminalShell: { windowsShell: "automatic" },
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
