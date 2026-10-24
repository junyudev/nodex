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

const bindingValue = (binding: AgentBackendBinding) =>
  binding.kind === "codex" ? "codex" : `${binding.kind}:${binding.instanceConfigId ?? ""}`;

export function AutomationIntelligenceDropdown({
  draft,
  codexModels,
  disabled,
  onChange,
}: {
  readonly draft: WorkbenchAutomationDraft;
  readonly codexModels: readonly AgentModelOption[];
  readonly disabled: boolean;
  readonly onChange: (draft: WorkbenchAutomationDraft) => void;
}) {
  const { instances } = useAgentInstances();
  const binding = draft.backendBinding;
  const isClaude = binding.kind === "claude";
  const isAcp = binding.kind === "acp";
  const acp = useAcpAutomationModels(binding);
  const selectedInstance =
    draft.backendBinding.kind === "claude" ? draft.backendBinding.instanceConfigId : null;
  const catalog = useClaudeModelCatalog(
    draft.kind === "cron" && selectedInstance
      ? { kind: "project", instanceConfigId: selectedInstance, projectId: draft.projectId }
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
    : isAcp
      ? acp.models
      : codexModels;
  const selection = bindingValue(binding);
  // Claude profiles and ACP instances the user turned on; OpenCode isn't scheduled here.
  const scheduled = instances.filter(
    (instance) =>
      instance.enabled && (instance.binding.kind === "claude" || instance.binding.kind === "acp"),
  );
  const current = instances.find((instance) => bindingValue(instance.binding) === selection);
  const label =
    binding.kind === "codex"
      ? "Codex"
      : (current?.label ?? (isAcp ? "Unavailable Agent" : (selectedInstance ?? "Claude")));
  const options = [
    { value: "codex", label: "Codex" },
    ...scheduled.map((instance) => ({
      value: bindingValue(instance.binding),
      label: instance.label,
    })),
  ];
  const selectBackend = (value: string) => {
    if (value === selection) return;
    const backendBinding: AgentBackendBinding =
      value === "codex"
        ? { kind: "codex" }
        : (scheduled.find((instance) => bindingValue(instance.binding) === value)?.binding ?? {
            kind: "codex",
          });
    const next = {
      ...draft,
      backendBinding,
      // An ACP instance runs its exact advertised model; its controls come with that model.
      model: backendBinding.kind === "claude" ? "default" : "",
      reasoningEffort:
        backendBinding.kind === "claude"
          ? "default"
          : backendBinding.kind === "acp"
            ? ""
            : "medium",
      serviceTier: "",
      localEnvironmentConfigPath: "",
    };
    onChange(resolveWorkbenchAutomationDraftModelSettings({ draft: next, models: codexModels }));
  };
  /** An ACP model either names one of its advertised effort values or none at all. */
  const acpEffort = (model: string, effort: string) => {
    const efforts = acp.models.find((option) => option.id === model)?.supportedReasoningEfforts;
    if (!efforts?.length) return "";
    return efforts.some((option) => option.reasoningEffort === effort)
      ? effort
      : (acp.models.find((option) => option.id === model)?.defaultReasoningEffort ?? "");
  };
  if (draft.kind === "heartbeat")
    return (
      <NodexDropdownMenu
        disabled={disabled}
        triggerButton={
          <NodexSettingsDropdownTrigger aria-label="Scheduled agent">
            {label}
          </NodexSettingsDropdownTrigger>
        }
      >
        {options.map((option) => (
          <NodexDropdownItem
            key={option.value}
            onSelect={() => selectBackend(option.value)}
            rightSlot={option.value === selection ? <NodexDropdownSelectedIcon /> : null}
          >
            {option.label}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
    );
  const dropdown = (
    <AgentIntelligenceDropdown
      disabled={disabled}
      models={models}
      triggerStyle="settings"
      provider={{
        label,
        selection,
        options,
        select: selectBackend,
      }}
      selection={{
        kind: binding.kind,
        model: isClaude ? intelligence.model : isAcp ? draft.model : draft.model || "default",
        reasoningEffort: isClaude
          ? intelligence.effort
          : isAcp
            ? draft.reasoningEffort || "default"
            : draft.reasoningEffort || "medium",
        serviceTier: isClaude || isAcp ? null : draft.serviceTier === "fast" ? "fast" : null,
      }}
      onSelectionChange={(next, change) => {
        const model = change === "model" ? next.model : draft.model;
        onChange({
          ...draft,
          model,
          reasoningEffort: isAcp ? acpEffort(model, next.reasoningEffort) : next.reasoningEffort,
          serviceTier: isClaude || isAcp ? "" : (next.serviceTier ?? ""),
        });
      }}
    />
  );
  if (!isAcp || acp.loading || acp.discovered) return dropdown;
  return (
    <span className="flex min-w-0 flex-col items-end gap-1">
      {dropdown}
      <span className="text-xs text-token-description-foreground">
        Connect {label} in Settings to choose its model.
      </span>
    </span>
  );
}
