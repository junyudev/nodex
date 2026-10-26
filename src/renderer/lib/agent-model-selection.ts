import type { AgentBackendBinding } from "../../shared/agent-backend";
import type {
  AgentSessionConfigOption,
  AgentSessionConfigSelectOption,
} from "../../shared/agent-conversation";
import type { AgentModelCatalog, AgentModelSelection } from "../../shared/agent-model-catalog";

export const agentBindingKey = (binding: AgentBackendBinding): string =>
  binding.kind === "codex"
    ? "codex"
    : binding.kind === "acp"
      ? JSON.stringify([binding.kind, binding.agentDefinitionId, binding.instanceConfigId])
      : `${binding.kind}:${binding.instanceConfigId}`;

export const agentModelKey = (binding: AgentBackendBinding, model: string): string =>
  JSON.stringify([agentBindingKey(binding), model]);

/** Keep OpenCode's free models and the exact current choice in the default picker list. */
export function visibleAgentModelPickerEntries<
  Entry extends {
    readonly binding: AgentBackendBinding;
    readonly model: { readonly id: string };
  },
>(
  entries: readonly Entry[],
  selected: AgentModelSelection,
  showAllModels: boolean,
): readonly Entry[] {
  if (showAllModels) return entries;
  const selectedKey = agentModelKey(selected.binding, selected.model);
  return entries.filter(
    (entry) =>
      entry.binding.kind !== "opencode" ||
      entry.model.id.endsWith("-free") ||
      agentModelKey(entry.binding, entry.model.id) === selectedKey,
  );
}

const BRANDED_RUNTIME_NAMES: Partial<Record<AgentBackendBinding["kind"], readonly string[]>> = {
  codex: ["codex"],
  claude: ["claude", "claude code"],
};

/**
 * Branded runtimes are identified by their mark, so a picker row names the runtime only when the
 * instance label adds information (for example a second Claude account).
 */
export const agentRuntimeQualifier = (
  binding: Pick<AgentBackendBinding, "kind">,
  label: string,
): string | null => {
  const trimmed = label.trim();
  if (!trimmed) return null;
  return BRANDED_RUNTIME_NAMES[binding.kind]?.includes(trimmed.toLowerCase()) ? null : trimmed;
};

export const flattenAgentConfigOptions = (
  option: Extract<AgentSessionConfigOption, { type: "select" }>,
): readonly AgentSessionConfigSelectOption[] =>
  option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));

export const agentModelConfigOptions = (catalog: AgentModelCatalog, model: string) =>
  catalog.modelConfigOptions?.[model] ?? catalog.configOptions;

/** Only currently advertised options survive a model change; native IDs remain untouched. */
export function resolveAgentConfigSelections(
  configOptions: readonly AgentSessionConfigOption[],
  selected: AgentModelSelection["options"],
): NonNullable<AgentModelSelection["options"]> {
  return configOptions
    .filter((option) => option.category !== "model")
    .map((option) => {
      const previous = selected?.find((entry) => entry.id === option.id);
      if (option.type === "boolean") {
        return {
          id: option.id,
          value: typeof previous?.value === "boolean" ? previous.value : option.currentValue,
        };
      }
      const values = flattenAgentConfigOptions(option);
      return {
        id: option.id,
        value:
          typeof previous?.value === "string" &&
          values.some((candidate) => candidate.value === previous.value)
            ? previous.value
            : option.currentValue,
      };
    });
}

export function selectAgentCatalogModel(
  catalog: AgentModelCatalog,
  model: string,
  previous?: AgentModelSelection,
): AgentModelSelection | null {
  if (catalog.health.status !== "ready") return null;
  if (!catalog.models.some((entry) => entry.id === model && !entry.hidden)) return null;
  const sameInstance =
    previous && agentBindingKey(previous.binding) === agentBindingKey(catalog.binding);
  const options = resolveAgentConfigSelections(
    agentModelConfigOptions(catalog, model),
    sameInstance ? previous.options : undefined,
  );
  const previousMode = sameInstance ? previous.modeId : undefined;
  const modeId = catalog.modes?.availableModes.some((mode) => mode.id === previousMode)
    ? previousMode
    : catalog.modes?.currentModeId;
  return {
    binding: catalog.binding,
    model,
    ...(options.length ? { options } : {}),
    ...(modeId ? { modeId } : {}),
  };
}
