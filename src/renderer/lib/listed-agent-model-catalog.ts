import type { AgentIntelligenceSelection } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import type { AgentModelCatalogPresentation } from "@/components/shared/agent-runtime/agent-model-picker";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { CodexExecutionProfileChange } from "../../shared/codex-execution-profile";
import type { AgentModelOption, CodexReasoningEffort } from "../../shared/types";
import { agentEffortLabel } from "./agent-runtime-model-selection";
import { formatCodexModelLabel, resolveCodexReasoningEffortOptions } from "./codex-thread-settings";

/** A Codex model change keeps an effort the next model offers, else its default, High, then its first. */
export function resolveReasoningEffortForModelChange(input: {
  currentReasoningEffort: CodexReasoningEffort;
  nextModelId: string;
  models: readonly AgentModelOption[];
}): CodexReasoningEffort | null {
  const nextModel = input.models.find(
    (candidate) => candidate.id === input.nextModelId && !candidate.hidden,
  );
  const supportedOptions = resolveCodexReasoningEffortOptions(input.nextModelId, input.models);
  const supportedEfforts = new Set(supportedOptions.map((option) => option.reasoningEffort));
  if (supportedEfforts.has(input.currentReasoningEffort)) return input.currentReasoningEffort;

  const preferredEfforts: Array<CodexReasoningEffort | null | undefined> = [
    nextModel?.defaultReasoningEffort,
    supportedEfforts.has("high") ? "high" : null,
    supportedOptions[0]?.reasoningEffort,
  ];
  return preferredEfforts.find((effort) => effort && supportedEfforts.has(effort)) ?? null;
}

/**
 * The effort a model change carries. Codex and Claude keep a choice the next model also offers;
 * other Agents start from none and let their owner fit it to the model.
 */
export function resolveListedModelEffort(
  selection: AgentIntelligenceSelection,
  next: AgentModelOption,
  models: readonly AgentModelOption[],
): CodexReasoningEffort | null {
  if (selection.kind === "codex")
    return resolveReasoningEffortForModelChange({
      currentReasoningEffort: selection.reasoningEffort,
      nextModelId: next.id,
      models,
    });
  if (selection.kind === "claude")
    return next.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === selection.reasoningEffort,
    )
      ? selection.reasoningEffort
      : next.defaultReasoningEffort || null;
  return "none";
}

const LISTED_EFFORT_OPTION_ID = "reasoningEffort";

/**
 * A model picker catalog for one Agent whose models arrive as a plain list, such as a remote
 * Codex host or a scheduled task. Codex and Claude efforts are native controls in the picker;
 * any other Agent's advertised effort levels become its Effort option.
 */
export function listedModelCatalog(input: {
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly models: readonly AgentModelOption[];
  readonly selection: AgentIntelligenceSelection;
  readonly onSelectionChange: (
    selection: AgentIntelligenceSelection,
    change: CodexExecutionProfileChange,
  ) => void;
}): AgentModelCatalogPresentation {
  const { binding, label, models, selection, onSelectionChange } = input;
  const listed = models.filter((model) => !model.hidden);
  const current = listed.find((model) => model.id === selection.model);
  const efforts =
    selection.kind === "codex" || selection.kind === "claude"
      ? []
      : (current?.supportedReasoningEfforts ?? []);
  return {
    entries: listed.map((model) => ({
      binding,
      label,
      model: { ...model, displayName: formatCodexModelLabel(model.id, models) },
      selection: { binding, model: model.id },
    })),
    selected: { binding, model: selection.model },
    loading: false,
    choose: (next) => {
      const model = listed.find((candidate) => candidate.id === next.model);
      const reasoningEffort = model ? resolveListedModelEffort(selection, model, models) : null;
      if (!model || !reasoningEffort) return;
      onSelectionChange({ ...selection, model: model.id, reasoningEffort }, "model");
    },
    ...(current && efforts.length > 0
      ? {
          configOptions: [
            {
              id: LISTED_EFFORT_OPTION_ID,
              name: "Effort",
              description: null,
              category: "thought_level",
              type: "select",
              currentValue: efforts.some(
                (option) => option.reasoningEffort === selection.reasoningEffort,
              )
                ? selection.reasoningEffort
                : current.defaultReasoningEffort,
              options: efforts.map((option) => ({
                value: option.reasoningEffort,
                name: agentEffortLabel(selection.kind, option.reasoningEffort),
                description: option.description || null,
              })),
            },
          ],
          changeConfig: async (id, value) => {
            if (id !== LISTED_EFFORT_OPTION_ID || typeof value !== "string") return;
            onSelectionChange({ ...selection, reasoningEffort: value }, "reasoningEffort");
          },
        }
      : {}),
  };
}
