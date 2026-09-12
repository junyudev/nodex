import * as Effect from "effect/Effect";
import {
  applyCodexDefaultModeRequestUserInput,
  emptyCodexExecutionAssignmentValues,
  filterCodexExecutionFeaturesForAppServer,
  parseCodexExecutionInstructionOverrides,
  projectCodexExecutionFeaturesToThreadConfig,
  projectCodexExecutionMemoryPromptsToThreadConfig,
  type CodexExecutionAssignmentValues,
} from "../../shared/codex-execution-assignments";
import { CodexExecutionAssignments } from "./CodexExecutionAssignments";
import { parseCodexPersonality } from "./CodexPersonality";

export const makeReadyCodexExecutionAssignments = (
  features: Readonly<Record<string, unknown>> = {},
  options: {
    readonly values?: CodexExecutionAssignmentValues;
    readonly defaultModeRequestUserInput?: boolean;
    readonly detailLevel?: "STEPS_PROSE" | "STEPS_COMMANDS" | "STEPS_EXECUTION";
    readonly gitSettings?: {
      readonly branchPrefix: string;
      readonly commitInstructions: string;
      readonly pullRequestInstructions: string;
    };
  } = {},
): CodexExecutionAssignments["Service"] =>
  CodexExecutionAssignments.of(
    (() => {
      const values = options.values ?? emptyCodexExecutionAssignmentValues();
      const materializeDefaults = (appServerVersion?: string | null) => {
        const filtered = filterCodexExecutionFeaturesForAppServer(features, appServerVersion) ?? {};
        return (
          applyCodexDefaultModeRequestUserInput(
            filtered,
            options.defaultModeRequestUserInput ?? true,
          ) ?? {}
        );
      };
      return {
        snapshot: {} as never,
        read: Effect.succeed({ permissionRefresh: false, threadQueue: false }),
        readExecutionAssignments: (appServerVersion) => {
          const defaultEnableFeatures =
            filterCodexExecutionFeaturesForAppServer(features, appServerVersion) ?? {};
          return Effect.succeed({
            identity: {
              userId: null,
              accountId: null,
              authMethod: null,
              stableId: "test-stable-id",
            },
            values,
            defaultEnableFeatures,
          });
        },
        readThreadDefaults: (appServerVersion) => {
          const defaultEnableFeatures = materializeDefaults(appServerVersion);
          return Effect.succeed({
            identity: {
              userId: null,
              accountId: null,
              authMethod: null,
              stableId: "test-stable-id",
            },
            values,
            defaultEnableFeatures,
            config: projectCodexExecutionFeaturesToThreadConfig(defaultEnableFeatures),
          });
        },
        readThreadSettings: (input) => {
          const defaultEnableFeatures = materializeDefaults(input.appServerVersion);
          const instructionOverrides = input.model
            ? parseCodexExecutionInstructionOverrides(values.instructions[input.model] ?? {})
            : null;
          const includeProseDetailLevelInstructions = options.detailLevel === "STEPS_PROSE";
          const writingBlocks = defaultEnableFeatures.writing_blocks === true;
          return Effect.succeed({
            identity: {
              userId: null,
              accountId: null,
              authMethod: null,
              stableId: "test-stable-id",
            },
            values,
            defaultEnableFeatures,
            config: {
              ...projectCodexExecutionFeaturesToThreadConfig(defaultEnableFeatures),
              ...(input.allowMemoryPromptOverrides === true
                ? projectCodexExecutionMemoryPromptsToThreadConfig(instructionOverrides)
                : {}),
            },
            defaultPersonality:
              parseCodexPersonality(values.personality.default_personality) ?? "friendly",
            gitSettings: options.gitSettings ?? {
              branchPrefix: "codex/",
              commitInstructions: "",
              pullRequestInstructions: "",
            },
            instructionOverrides,
            includeProseDetailLevelInstructions,
            automaticTitleCheckpoints: input.includeDeveloperInstructions && values.automaticTitles,
            writingBlocks,
            presentationOutlines:
              input.includeDeveloperInstructions &&
              writingBlocks &&
              includeProseDetailLevelInstructions &&
              (values.presentationOutlinesTargeting ||
                values.presentationOutlines.enabled === true),
          });
        },
        bootstrap: Effect.die("unused"),
        publish: () => Effect.void,
      };
    })(),
  );
