import { useEffect, useState } from "react";
import { AgentIntelligenceDropdown } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import {
  NodexDropdownMenu,
  NodexDropdownItem,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { readClaudeAgentSettings } from "@/lib/workbench-settings-runtime";
import { resolveRendererTransport } from "@/lib/renderer-transport";
import { projectNativeModelOption } from "@/lib/native-model-option";
import { resolveNativeIntelligenceSelection } from "@/lib/native-intelligence-selection";
import { isClaudeEffortLevel } from "../../../shared/claude-models";
import { useClaudeModelCatalog } from "@/features/local-conversation/use-claude-model-catalog";
import type { AgentModelOption } from "../../../shared/types";
import type { ClaudeAgentSettings } from "../../../shared/claude-agent-settings";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import {
  resolveWorkbenchAutomationDraftModelSettings,
  type WorkbenchAutomationDraft,
} from "./workbench-automation-draft";

const useAutomationProfiles = () => {
  const [profiles, setProfiles] = useState<ClaudeAgentSettings["instances"]>([]);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const reload = () => {
      const requested = ++generation;
      void readClaudeAgentSettings().then(
        (settings) => {
          if (!disposed && requested === generation && settings) setProfiles(settings.instances);
        },
        () => {},
      );
    };
    const unsubscribe = resolveRendererTransport().subscribeClaudeAgentSettingsChanges(reload);
    reload();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return profiles;
};

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
  const profiles = useAutomationProfiles();
  const isClaude = draft.backendBinding.kind === "claude";
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
    : codexModels;
  const selection = isClaude ? `claude:${selectedInstance}` : "codex";
  const label = isClaude
    ? (profiles.find((profile) => profile.id === selectedInstance)?.displayName ??
      selectedInstance ??
      "Claude")
    : "Codex";
  const options = [
    { value: "codex", label: "Codex" },
    ...profiles
      .filter((profile) => profile.enabled)
      .map((profile) => ({ value: `claude:${profile.id}`, label: profile.displayName })),
  ];
  const selectBackend = (value: string) => {
    if (value === selection) return;
    const backendBinding: AgentBackendBinding =
      value === "codex"
        ? { kind: "codex" }
        : { kind: "claude", instanceConfigId: value.slice("claude:".length) };
    const next = {
      ...draft,
      backendBinding,
      model: backendBinding.kind === "claude" ? "default" : "",
      reasoningEffort: backendBinding.kind === "claude" ? "default" : "medium",
      serviceTier: "",
      localEnvironmentConfigPath: "",
    };
    onChange(resolveWorkbenchAutomationDraftModelSettings({ draft: next, models: codexModels }));
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
  return (
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
        kind: isClaude ? "claude" : "codex",
        model: isClaude ? intelligence.model : draft.model || "default",
        reasoningEffort: isClaude ? intelligence.effort : draft.reasoningEffort || "medium",
        serviceTier: isClaude ? null : draft.serviceTier === "fast" ? "fast" : null,
      }}
      onSelectionChange={(next, change) =>
        onChange({
          ...draft,
          model: change === "model" ? next.model : draft.model,
          reasoningEffort: next.reasoningEffort,
          serviceTier: isClaude ? "" : (next.serviceTier ?? ""),
        })
      }
    />
  );
}
