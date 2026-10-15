import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import {
  mergeAgentConfigs,
  parseAgentConfigMode,
  buildAgentConfigProfile,
  hasAgentConfigIntelligenceOverride,
} from "../../shared/codex-agent-config";
import type { CodexCollaborationModeKind, CodexPromptAgentConfigInput } from "../../shared/types";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { ComposerCatalog } from "./ComposerCatalog";

export type CodexAgentConfigTarget =
  | {
      readonly kind: "new-thread";
      readonly fallbackExecutionProfile: CodexExecutionProfile | null;
    }
  | { readonly kind: "existing-thread"; readonly threadId: string };

export interface CodexPreparedAgentConfig {
  readonly hasConfig: boolean;
  readonly collaborationMode?: CodexCollaborationModeKind;
  readonly executionProfile?: CodexExecutionProfile;
}

export class CodexAgentConfigError extends Schema.TaggedError<CodexAgentConfigError>()(
  "CodexAgentConfigError",
  {
    target: Schema.Literals(["new-thread", "existing-thread"]),
    threadId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class CodexAgentConfigRuntime extends Context.Service<
  CodexAgentConfigRuntime,
  {
    readonly prepare: (input: {
      readonly target: CodexAgentConfigTarget;
      readonly configs: readonly CodexPromptAgentConfigInput[];
    }) => Effect.Effect<CodexPreparedAgentConfig, CodexAgentConfigError>;
  }
>()("nodex/main/codex-application/CodexAgentConfigRuntime") {}

export const make: Effect.Effect<
  CodexAgentConfigRuntime["Service"],
  never,
  ComposerCatalog | CodexThreadSettingsRuntime
> = Effect.gen(function* () {
  const catalog = yield* ComposerCatalog;
  const threadSettings = yield* CodexThreadSettingsRuntime;

  const prepare: CodexAgentConfigRuntime["Service"]["prepare"] = Effect.fn(
    "CodexAgentConfigRuntime.prepare",
  )(
    function* (input) {
      if (input.configs.length === 0) return { hasConfig: false };

      const merged = yield* Effect.try(() => mergeAgentConfigs(input.configs));
      const mode = yield* Effect.try(() => parseAgentConfigMode(merged.mode));
      const base =
        input.target.kind === "existing-thread"
          ? yield* threadSettings.readExecutionProfile(input.target.threadId)
          : input.target.fallbackExecutionProfile;
      const executionProfile = hasAgentConfigIntelligenceOverride(merged)
        ? yield* Effect.gen(function* () {
            const models = yield* catalog.listModels;
            const requested = yield* Effect.try(() =>
              buildAgentConfigProfile({ models, merged, base }),
            );
            if (input.target.kind === "existing-thread") {
              yield* threadSettings.update({
                threadId: input.target.threadId,
                patch: { executionProfile: requested },
              });
            }
            return requested;
          })
        : undefined;

      return {
        hasConfig: true,
        ...(mode ? { collaborationMode: mode } : {}),
        ...(executionProfile ? { executionProfile } : {}),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CodexAgentConfigError({
              target: input.target.kind,
              ...(input.target.kind === "existing-thread"
                ? { threadId: input.target.threadId }
                : {}),
              cause,
            }),
        ),
      ),
  );

  return CodexAgentConfigRuntime.of({ prepare });
});
