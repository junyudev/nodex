import { FormattedMessage, useIntl } from "@/lib/i18n";
import { AgentIntelligenceDropdown } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import {
  NodexDropdownMenu,
  NodexDropdownItem,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { useAcpAutomationModels } from "@/features/acp-agents/use-acp-automation-models";
import { projectNativeModelOption } from "@/lib/native-model-option";
import { resolveNativeIntelligenceSelection } from "@/lib/native-intelligence-selection";
import { isClaudeEffortLevel } from "../../../shared/claude-models";
import { useClaudeModelCatalog } from "@/features/local-conversation/use-claude-model-catalog";
import type { AgentModelOption } from "../../../shared/types";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import {
  resolveWorkbenchAutomationDraftModelSettings,
  type WorkbenchAutomationDraft,
} from "./workbench-automation-draft";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";

const bindingValue = (binding: AgentBackendBinding) =>
  binding.kind === "codex" ? "codex" : `${binding.kind}:${binding.instanceConfigId ?? ""}`;

interface AutomationDraftEditor {
  readonly draft: WorkbenchAutomationDraft;
  readonly codexModels: readonly AgentModelOption[];
  readonly onChange: (draft: WorkbenchAutomationDraft) => void;
}

/** The Agents an automation can run with, and switching between them. */
export function useAutomationAgent({ draft, codexModels, onChange }: AutomationDraftEditor) {
  const intl = useIntl();
  const { instances } = useAgentInstances();
  const binding = draft.backendBinding;
  const value = bindingValue(binding);
  const scheduled = instances.filter(
    (instance) =>
      instance.enabled &&
      (instance.binding.kind === "claude" ||
        instance.binding.kind === "acp" ||
        instance.binding.kind === "antigravity"),
  );
  const current = instances.find((instance) => bindingValue(instance.binding) === value);
  const label =
    binding.kind === "codex"
      ? "Codex"
      : (current?.label ??
        (binding.kind === "acp" || binding.kind === "antigravity"
          ? intl.formatMessage({
              id: "workbench.workbenchAutomationIntelligence.unavailableAgent",
              defaultMessage: "Unavailable Agent",
            })
          : binding.instanceConfigId || "Claude"));
  const options = [
    { value: "codex", label: "Codex" },
    ...scheduled.map((instance) => ({
      value: bindingValue(instance.binding),
      label: instance.label,
    })),
  ];
  const select = (next: string) => {
    if (next === value) return;
    const backendBinding: AgentBackendBinding =
      next === "codex"
        ? { kind: "codex" }
        : (scheduled.find((instance) => bindingValue(instance.binding) === next)?.binding ?? {
            kind: "codex",
          });
    const changed = {
      ...draft,
      backendBinding,
      // Account-based Agents start with their own catalog and option choices.
      model: backendBinding.kind === "claude" ? "default" : "",
      reasoningEffort:
        backendBinding.kind === "claude"
          ? "default"
          : backendBinding.kind === "acp" || backendBinding.kind === "antigravity"
            ? ""
            : "medium",
      serviceTier: "",
      localEnvironmentConfigPath: "",
    };
    onChange(resolveWorkbenchAutomationDraftModelSettings({ draft: changed, models: codexModels }));
  };
  return { label, value, options, select };
}

export type AutomationAgent = ReturnType<typeof useAutomationAgent>;

export function AutomationAgentDropdown({
  agent,
  disabled,
}: {
  readonly agent: AutomationAgent;
  readonly disabled: boolean;
}) {
  const intl = useIntl();
  return (
    <NodexDropdownMenu
      disabled={disabled}
      triggerButton={
        <NodexSettingsDropdownTrigger
          aria-label={intl.formatMessage({
            id: "workbench.workbenchAutomationIntelligence.agent",
            defaultMessage: "Automations agent",
          })}
        >
          {agent.label}
        </NodexSettingsDropdownTrigger>
      }
    >
      {agent.options.map((option) => (
        <NodexDropdownItem
          key={option.value}
          onSelect={() => agent.select(option.value)}
          rightSlot={option.value === agent.value ? <NodexDropdownSelectedIcon /> : null}
        >
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

/** The model, effort and modes a task that starts new chats runs its Agent with. */
export function AutomationModelPicker({
  agent,
  draft,
  codexModels,
  disabled,
  onChange,
}: AutomationDraftEditor & { readonly agent: AutomationAgent; readonly disabled: boolean }) {
  const binding = draft.backendBinding;
  const isClaude = binding.kind === "claude";
  const usesRuntimeCatalog = binding.kind === "acp" || binding.kind === "antigravity";
  const runtime = useAcpAutomationModels(binding);
  const catalog = useClaudeModelCatalog(
    isClaude
      ? { kind: "project", instanceConfigId: binding.instanceConfigId, projectId: draft.projectId }
      : null,
  );
  const intelligence = resolveNativeIntelligenceSelection(
    {
      model: draft.model || "default",
      effort: isClaudeEffortLevel(draft.reasoningEffort) ? draft.reasoningEffort : "default",
    },
    catalog.discovery?.intelligence,
    true,
  );
  const models = isClaude
    ? catalog.options.map((option) =>
        projectNativeModelOption(option, option.value === catalog.discovery?.intelligence.model),
      )
    : usesRuntimeCatalog
      ? runtime.models
      : codexModels;
  /** Retain only a thinking level the selected model offers. */
  const runtimeEffort = (model: string, effort: string) => {
    const efforts = runtime.models.find((option) => option.id === model)?.supportedReasoningEfforts;
    if (!efforts?.length) return "";
    return efforts.some((option) => option.reasoningEffort === effort)
      ? effort
      : (runtime.models.find((option) => option.id === model)?.defaultReasoningEffort ?? "");
  };
  const picker = (
    <AgentIntelligenceDropdown
      disabled={disabled}
      models={models}
      triggerStyle="settings"
      agent={{ binding, label: agent.label }}
      selection={{
        kind: binding.kind,
        model: isClaude
          ? intelligence.model
          : usesRuntimeCatalog
            ? draft.model
            : draft.model || "default",
        reasoningEffort: isClaude
          ? intelligence.effort
          : usesRuntimeCatalog
            ? draft.reasoningEffort || "default"
            : draft.reasoningEffort || "medium",
        serviceTier:
          isClaude || usesRuntimeCatalog ? null : normalizeCodexServiceTier(draft.serviceTier),
      }}
      onSelectionChange={(next, change) => {
        const model = change === "model" ? next.model : draft.model;
        onChange({
          ...draft,
          model,
          reasoningEffort: usesRuntimeCatalog
            ? runtimeEffort(model, next.reasoningEffort)
            : next.reasoningEffort,
          serviceTier: isClaude || usesRuntimeCatalog ? "" : (next.serviceTier ?? ""),
        });
      }}
    />
  );
  if (!usesRuntimeCatalog || runtime.loading || runtime.discovered) return picker;
  return (
    <span className="flex min-w-0 flex-col items-end gap-1">
      {picker}
      <span className="text-xs text-token-description-foreground">
        <FormattedMessage
          id="workbench.workbenchAutomationIntelligence.connectAgent"
          defaultMessage="Connect {agent} in Settings to choose its model."
          values={{ agent: agent.label }}
        />
      </span>
    </span>
  );
}
