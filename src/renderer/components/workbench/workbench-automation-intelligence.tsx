import { CODEX_AGENT_BACKEND_BINDING } from "../../../shared/agent-backend";
import { agentDefinition } from "../../../shared/agents/registry";
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
import {
  defaultAutomationIntelligence,
  resolveWorkbenchAutomationDraftModelSettings,
  type WorkbenchAutomationDraft,
} from "./workbench-automation-draft";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";

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
  const value = binding.instanceId;
  const definition = agentDefinition(binding.driver);
  const modelSource = definition.capabilities.automation?.modelSource;
  const defaultBinding = CODEX_AGENT_BACKEND_BINDING;
  const defaultDefinition = agentDefinition(defaultBinding.driver);
  const scheduled = instances.filter(
    ({ enabled, binding }) =>
      enabled &&
      binding.instanceId !== defaultBinding.instanceId &&
      agentDefinition(binding.driver).capabilities.automation !== undefined,
  );
  const current = instances.find((instance) => instance.binding.instanceId === value);
  const label =
    current?.label ??
    (modelSource === "discovery" || modelSource === "account"
      ? intl.formatMessage({
          id: "workbench.workbenchAutomationIntelligence.unavailableAgent",
          defaultMessage: "Unavailable Agent",
        })
      : definition.label);
  const options = [
    { value: defaultBinding.instanceId, label: defaultDefinition.label },
    ...scheduled.map((instance) => ({
      value: instance.binding.instanceId,
      label: instance.label,
    })),
  ];
  const select = (next: string) => {
    if (next === value) return;
    const backendBinding =
      next === defaultBinding.instanceId
        ? defaultBinding
        : scheduled.find((instance) => instance.binding.instanceId === next)?.binding;
    if (!backendBinding) return;
    const changed = {
      ...draft,
      backendBinding,
      ...defaultAutomationIntelligence(backendBinding),
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
  const modelSource = agentDefinition(binding.driver).capabilities.automation?.modelSource;
  const usesNativeIntelligence = modelSource === "native";
  const usesRuntimeCatalog = modelSource === "discovery" || modelSource === "account";
  const usesAppServer = modelSource === "appServer";
  const runtime = useAcpAutomationModels(binding);
  const catalog = useClaudeModelCatalog(
    usesNativeIntelligence
      ? { kind: "project", instanceConfigId: binding.instanceId, projectId: draft.projectId }
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
  const models = usesNativeIntelligence
    ? catalog.options.map((option) =>
        projectNativeModelOption(option, option.value === catalog.discovery?.intelligence.model),
      )
    : usesRuntimeCatalog
      ? runtime.models
      : usesAppServer
        ? codexModels
        : [];
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
        kind: binding.driver,
        model: usesNativeIntelligence
          ? intelligence.model
          : usesRuntimeCatalog
            ? draft.model
            : usesAppServer
              ? draft.model || "default"
              : draft.model,
        reasoningEffort: usesNativeIntelligence
          ? intelligence.effort
          : usesRuntimeCatalog
            ? draft.reasoningEffort || "default"
            : usesAppServer
              ? draft.reasoningEffort || "medium"
              : draft.reasoningEffort,
        serviceTier: usesAppServer ? normalizeCodexServiceTier(draft.serviceTier) : null,
      }}
      onSelectionChange={(next, change) => {
        const model = change === "model" ? next.model : draft.model;
        onChange({
          ...draft,
          model,
          reasoningEffort: usesRuntimeCatalog
            ? runtimeEffort(model, next.reasoningEffort)
            : next.reasoningEffort,
          serviceTier: usesAppServer ? (next.serviceTier ?? "") : "",
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
