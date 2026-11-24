import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  isProviderKeyReasoningEffort,
  providerKeyPreset,
  providerKeyQuickModel,
  type ProviderKeyModel,
  type ProviderKeyPresetId,
} from "../../shared/provider-keys";
import { CODEX_DEFAULT_INSTRUCTIONS } from "./codex-default-instructions";

/** Codex's own context window for a model it doesn't know. */
const fallbackContextWindow = 272_000;

/**
 * The catalog Codex runs a connection's models on: each model as the provider listed it, with
 * Codex's own instructions and defaults wherever the provider says nothing, and the provider's
 * documented harness preferences.
 */
export function providerKeyCodexCatalog(
  homePath: string,
  presetId: ProviderKeyPresetId,
  models: readonly ProviderKeyModel[],
) {
  const first = models[0];
  if (!first) return null;
  const quick = providerKeyQuickModel(models) ?? first;
  const harness = providerKeyPreset(presetId).codex ?? {};
  const catalog = {
    models: models.map((model, priority) => {
      const declaredDefault = model.defaultReasoningEffort;
      const efforts = [
        ...new Set(model.reasoningEfforts ?? (declaredDefault ? [declaredDefault] : [])),
      ].filter(isProviderKeyReasoningEffort);
      const defaultEffort =
        declaredDefault && efforts.includes(declaredDefault) ? declaredDefault : efforts[0];
      const contextWindow = model.contextWindow ?? fallbackContextWindow;
      return {
        slug: model.id,
        display_name: model.name,
        default_reasoning_level: defaultEffort,
        supported_reasoning_levels: efforts.map((effort) => ({ effort, description: "" })),
        shell_type: harness.shell ?? "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority,
        model_messages: { instructions_template: CODEX_DEFAULT_INSTRUCTIONS },
        support_verbosity: false,
        supports_reasoning_summary_parameter: false,
        ...(harness.applyPatch ? { apply_patch_tool_type: harness.applyPatch } : {}),
        truncation_policy: { mode: harness.truncation ?? "bytes", limit: 10_000 },
        context_window: contextWindow,
        max_context_window: contextWindow,
        experimental_supported_tools: [],
        input_modalities: model.images ? ["text", "image"] : ["text"],
        auto_review_model_override: quick.id,
      };
    }),
  };
  const contents = JSON.stringify(catalog);
  // A metadata-only refresh must change the provider declaration and restart its app-server.
  const revision = createHash("sha256").update(contents).digest("hex");
  return {
    path: join(homePath, `models-${revision}.json`),
    contents,
    model: first.id,
    quickModel: quick.id,
  };
}
