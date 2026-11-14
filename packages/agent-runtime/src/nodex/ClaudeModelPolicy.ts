import type {
  Options,
  Settings,
  ResolvedSettings,
  ResolveSettingsOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { isModelOn, policyModelKey } from "../../../../src/shared/model-policy.ts";
import { ModelPolicyError, RuntimeModelPolicy, providerForPolicy } from "./ModelPolicy.ts";
import type { ModelSelection } from "@nodex/runtime-contracts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelSlug,
  type ClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";

/** Compile the Profile's per-version choices into Claude Code's exact allowlist. */
export const restrictions = Effect.fn("ClaudeModelPolicy.restrictions")(function* (
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
) {
  const owner = yield* RuntimeModelPolicy;
  const selected = resolveClaudeModelSlug(catalog, selection.model);
  // Check the same identity that the CLI will run, including old selections saved as aliases.
  yield* owner.assert({ ...selection, model: selected }, "nodex-agent");
  const { policy, providers } = yield* owner.current;
  const provider = providerForPolicy(providers, selection.instanceId);
  const declared = providers[selection.instanceId]?.modelAllowlist;
  const remembered = policy.exceptions.flatMap((key) => {
    try {
      const parts: unknown = JSON.parse(key);
      const model = Array.isArray(parts) ? parts.at(-1) : undefined;
      return typeof model === "string" && policyModelKey(provider, model) === key ? [model] : [];
    } catch {
      return [];
    }
  });
  const models = [
    ...new Set(
      (
        declared ?? [
          ...BUNDLED_CLAUDE_MODEL_CATALOG.models.map(({ model }) => model.slug),
          ...catalog.models.map(({ model }) => model.slug),
          ...remembered,
          selected,
        ]
      ).map((model) => resolveClaudeModelSlug(catalog, model)),
    ),
  ];
  // A deny such as claude-opus-5 also blocks claude-opus-5-5, even in exact mode.
  // Compile the permitted IDs without a second, prefix-matched restriction.
  const availableModels = [
    ...new Set(
      models
        .filter((model) => model !== "default" && isModelOn(policy, provider, model))
        .map((model) =>
          resolveClaudeCatalogApiModelId(catalog, { instanceId: selection.instanceId, model }),
        ),
    ),
  ];
  if (availableModels.length === 0 || (selected !== "default" && !models.includes(selected))) {
    return yield* new ModelPolicyError({
      code: "model_off",
      message: `Claude model ${selected} is unavailable on this account.`,
      retryable: false,
    });
  }
  return {
    availableModels,
    enforceAvailableModels: true,
    availableModelsMatch: "exact",
  } satisfies Settings;
});

/** The SDK's local merge engine performs no inference and starts no Claude process. */
export async function verifyClaudeModelPolicy(
  options: Pick<Options, "cwd" | "settingSources" | "managedSettings">,
  resolve: (input: ResolveSettingsOptions) => Promise<ResolvedSettings>,
): Promise<void> {
  const requested = options.managedSettings;
  if (!requested?.availableModels) return;
  const result = await resolve({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.settingSources === undefined ? {} : { settingSources: options.settingSources }),
    managedSettings: requested,
  });
  const effective = result.effective;
  const sameList = (left: string[] | undefined, right: string[] | undefined) =>
    JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
  if (
    effective.policyHelper ||
    effective.availableModelsMatch !== "exact" ||
    effective.enforceAvailableModels !== true ||
    !sameList(effective.availableModels, requested.availableModels)
  )
    throw new Error(
      "Claude's effective model restrictions could not be verified. Check managed Claude settings before starting this model.",
    );
}
