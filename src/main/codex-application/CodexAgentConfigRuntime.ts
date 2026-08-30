import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type {
  CodexCollaborationModeKind,
  CodexModelOption,
  CodexPermissionMode,
  CodexPromptAgentConfigInput,
  CodexReasoningEffort,
} from "../../shared/types";
import { CodexPermissions, type CodexPermissionDecision } from "./CodexPermissions";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { ComposerCatalog } from "./ComposerCatalog";

const CODEX_PROVIDER_ID = "openai";
const MAX_VALUE_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const PERMISSION_MODES = new Set<CodexPermissionMode>([
  "auto",
  "guardian-approvals",
  "full-access",
  "custom",
]);

export type CodexAgentConfigTarget =
  | {
      readonly kind: "new-thread";
      readonly fallbackExecutionProfile: CodexExecutionProfile | null;
    }
  | { readonly kind: "existing-thread"; readonly threadId: string };

export interface CodexAgentConfigPermissionContext {
  readonly projectId: string | null;
  readonly workspaceRoots: readonly string[];
}

export interface CodexPreparedAgentConfig {
  readonly hasConfig: boolean;
  readonly collaborationMode?: CodexCollaborationModeKind;
  readonly executionProfile?: CodexExecutionProfile;
  readonly permissionMode?: CodexPermissionMode;
  readonly permissionDecision?: CodexPermissionDecision;
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
      readonly permissionContext: CodexAgentConfigPermissionContext;
    }) => Effect.Effect<CodexPreparedAgentConfig, CodexAgentConfigError>;
  }
>()("nodex/main/codex-application/CodexAgentConfigRuntime") {}

interface MergedAgentConfig {
  readonly mode?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly speed?: string;
  readonly permission?: string;
}

function normalizeExplicitValue(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`Invalid Agent config ${field}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function mergeAgentConfigs(configs: readonly CodexPromptAgentConfigInput[]): MergedAgentConfig {
  const merged: Record<string, string> = {};
  for (const config of configs) {
    if ((config.unknownAttributes?.length ?? 0) > 0) {
      throw new Error(
        `Unsupported Agent config attributes: ${config.unknownAttributes?.join(", ")}`,
      );
    }
    for (const field of [
      "mode",
      "provider",
      "model",
      "reasoning",
      "speed",
      "permission",
    ] as const) {
      const value = config[field];
      if (value !== undefined) merged[field] = normalizeExplicitValue(field, value);
    }
  }
  return merged;
}

function parseMode(value: string | undefined): CodexCollaborationModeKind | undefined {
  if (value === undefined) return undefined;
  if (value === "default" || value === "plan") return value;
  throw new Error(`Unsupported Agent config mode: ${value}`);
}

function parsePermission(value: string | undefined): CodexPermissionMode | undefined {
  if (value === undefined) return undefined;
  if (PERMISSION_MODES.has(value as CodexPermissionMode)) return value as CodexPermissionMode;
  throw new Error(`Unsupported Agent config permission: ${value}`);
}

function visibleModel(
  models: readonly CodexModelOption[],
  modelId: string,
): CodexModelOption | null {
  return (
    models.find((model) => !model.hidden && (model.id === modelId || model.model === modelId)) ??
    null
  );
}

function defaultModel(models: readonly CodexModelOption[]): CodexModelOption | null {
  return (
    models.find((model) => !model.hidden && model.isDefault) ??
    models.find((model) => !model.hidden) ??
    null
  );
}

function resolveReasoningEffort(
  model: CodexModelOption,
  requested: string | null | undefined,
): CodexReasoningEffort | null {
  const supported = new Set<string>(
    model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
  );
  if (requested && supported.has(requested)) return requested as CodexReasoningEffort;
  if (requested) throw new Error(`Effort '${requested}' is unavailable for ${model.displayName}`);
  if (model.defaultReasoningEffort && supported.has(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return model.supportedReasoningEfforts[0]?.reasoningEffort ?? null;
}

function resolveSpeed(
  model: CodexModelOption,
  requested: string | null | undefined,
): string | null {
  if (requested === undefined) return model.defaultServiceTier ?? null;
  const normalized = normalizeCodexServiceTier(requested);
  if (normalized === null) return null;
  if (normalized === "fast") return "fast";
  if (model.serviceTiers.some((option) => option.id === normalized)) return normalized;
  throw new Error(`Speed '${requested}' is unavailable for ${model.displayName}`);
}

function buildRequestedProfile(input: {
  models: readonly CodexModelOption[];
  merged: MergedAgentConfig;
  base: CodexExecutionProfile | null;
}): CodexExecutionProfile {
  if (input.merged.provider && input.merged.provider !== CODEX_PROVIDER_ID) {
    throw new Error(`Agent provider '${input.merged.provider}' is unavailable`);
  }

  const inheritedModel = input.base ? visibleModel(input.models, input.base.modelId) : null;
  const requestedModel = input.merged.model ? visibleModel(input.models, input.merged.model) : null;
  if (input.merged.model && !requestedModel) {
    throw new Error(`Agent model '${input.merged.model}' is unavailable`);
  }
  const model = requestedModel ?? inheritedModel ?? defaultModel(input.models);
  if (!model) throw new Error("No Codex model is available");

  const sameBaseModel = input.base !== null && visibleModel([model], input.base.modelId) !== null;
  return {
    modelId: model.model,
    reasoningEffort: resolveReasoningEffort(
      model,
      input.merged.reasoning !== undefined
        ? input.merged.reasoning
        : sameBaseModel
          ? input.base?.reasoningEffort
          : undefined,
    ),
    serviceTier: resolveSpeed(
      model,
      input.merged.speed !== undefined
        ? input.merged.speed
        : sameBaseModel
          ? input.base?.serviceTier
          : undefined,
    ),
  };
}

function hasIntelligenceOverride(config: MergedAgentConfig): boolean {
  return Boolean(config.provider || config.model || config.reasoning || config.speed);
}

export function validateCodexAgentConfigPermissionDecision(
  requestedMode: CodexPermissionMode,
  decision: CodexPermissionDecision,
): void {
  if (!decision.state.availableModes.includes(requestedMode)) {
    throw new Error(`Permission mode '${requestedMode}' is unavailable`);
  }
  if (requestedMode === "guardian-approvals" && !decision.state.autoReviewAvailable) {
    throw new Error("Approve for me is unavailable because auto review is not available");
  }
  if (decision.state.mode !== requestedMode) {
    throw new Error(`Permission mode '${requestedMode}' could not be applied`);
  }
  if (requestedMode === "full-access" && !decision.verifiedBuiltinFullAccess) {
    throw new Error(
      "Full access must already be enabled for this Project before Agent config can use it",
    );
  }
}

export const make: Effect.Effect<
  CodexAgentConfigRuntime["Service"],
  never,
  ComposerCatalog | CodexPermissions | CodexThreadSettingsRuntime
> = Effect.gen(function* () {
  const catalog = yield* ComposerCatalog;
  const permissions = yield* CodexPermissions;
  const threadSettings = yield* CodexThreadSettingsRuntime;

  const prepare: CodexAgentConfigRuntime["Service"]["prepare"] = Effect.fn(
    "CodexAgentConfigRuntime.prepare",
  )(
    function* (input) {
      if (input.configs.length === 0) return { hasConfig: false };

      const merged = yield* Effect.try(() => mergeAgentConfigs(input.configs));
      const mode = yield* Effect.try(() => parseMode(merged.mode));
      const permissionMode = yield* Effect.try(() => parsePermission(merged.permission));
      const base =
        input.target.kind === "existing-thread"
          ? yield* threadSettings.readExecutionProfile(input.target.threadId)
          : input.target.fallbackExecutionProfile;
      const executionProfile = hasIntelligenceOverride(merged)
        ? yield* Effect.gen(function* () {
            const models = yield* catalog.listModels;
            const requested = yield* Effect.try(() =>
              buildRequestedProfile({ models, merged, base }),
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
      const permissionDecision = permissionMode
        ? yield* permissions
            .resolve({
              projectId: input.permissionContext.projectId,
              requestedMode: permissionMode,
              workspaceRoots: input.permissionContext.workspaceRoots,
            })
            .pipe(
              Effect.tap((decision) =>
                Effect.try(() =>
                  validateCodexAgentConfigPermissionDecision(permissionMode, decision),
                ),
              ),
            )
        : undefined;

      return {
        hasConfig: true,
        ...(mode ? { collaborationMode: mode } : {}),
        ...(executionProfile ? { executionProfile } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionDecision ? { permissionDecision } : {}),
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
