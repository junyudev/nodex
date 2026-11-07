import type {
  Options,
  Settings,
  ResolvedSettings,
  ResolveSettingsOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { isModelOn, policyModelKey } from "../../../../src/shared/model-policy.ts";
import { RuntimeModelPolicy, providerForPolicy } from "./ModelPolicy.ts";
import type { ModelSelection } from "@nodex/runtime-contracts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
  type ClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";

/** Native selection plus helper-request denies. Empty allowlists must never mean all-off. */
export const restrictions = Effect.fn("ClaudeModelPolicy.restrictions")(function* (
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
) {
  const owner = yield* RuntimeModelPolicy;
  // The outer boundary already authorized the caller; native restrictions describe the admitted parent.
  yield* owner.assert(selection, "nodex-agent");
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
      [...BUNDLED_CLAUDE_MODEL_CATALOG.models, ...catalog.models]
        .map((entry) => entry.model.slug)
        .concat(remembered),
    ),
  ];
  const allowed = models.filter(
    (model) => (!declared || declared.includes(model)) && isModelOn(policy, provider, model),
  );
  // The running model can be a custom model absent from the bundled inventory.
  if (!models.includes(selection.model)) allowed.push(selection.model);
  const apiId = (model: string) => resolveClaudeCatalogApiModelId(catalog, { ...selection, model });
  return {
    availableModels: allowed.map(apiId),
    enforceAvailableModels: true,
    availableModelsMatch: "exact",
    deniedModels: models.filter((model) => !allowed.includes(model)).map(apiId),
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
    !sameList(effective.availableModels, requested.availableModels) ||
    !sameList(effective.deniedModels, requested.deniedModels)
  )
    throw new Error(
      "Claude's effective model restrictions could not be verified. Check managed Claude settings before starting this model.",
    );
}
