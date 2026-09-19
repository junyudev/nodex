import * as Effect from "effect/Effect";
import { ApplicationSettings, type ApplicationSettingsSnapshot } from "./ApplicationSettings";

export function makeTestApplicationSettings(input?: {
  readonly detailLevel?: "STEPS_PROSE" | "STEPS_COMMANDS" | "STEPS_EXECUTION";
  readonly branchPrefix?: string;
  readonly commitInstructions?: string;
  readonly pullRequestInstructions?: string;
}): ApplicationSettings["Service"] {
  return ApplicationSettings.of({
    snapshot: () =>
      Effect.succeed({
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
