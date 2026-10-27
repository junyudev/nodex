import type { Ref } from "react";
import { listedModelCatalog } from "@/lib/listed-agent-model-catalog";
import type { AgentBackendBinding } from "../../../../shared/agent-backend";
import type { CodexExecutionProfileChange } from "../../../../shared/codex-execution-profile";
import type { ClaudeEffortLevel } from "../../../../shared/claude-models";
import type {
  AgentModelOption,
  CodexReasoningEffort,
  CodexServiceTier,
} from "../../../../shared/types";
import { AgentModelPicker, type AgentModelCatalogPresentation } from "./agent-model-picker";

export interface AgentIntelligenceSelection {
  readonly kind: "codex" | "claude" | "acp" | "opencode";
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier: CodexServiceTier;
}

export type AgentIntelligenceInheritance = "explicit" | "inherited";

/** Null clears an override; omitted fields keep the current native choice. */
export interface AgentNativeIntelligencePatch {
  readonly effort?: ClaudeEffortLevel;
  readonly fast?: boolean | null;
  readonly ultracode?: boolean | null;
  readonly thinking?: boolean | null;
  readonly context?: string | null;
}

export interface AgentNativeIntelligencePresentation {
  readonly selected: {
    readonly fast?: boolean | null;
    readonly ultracode?: boolean | null;
    readonly thinking?: boolean | null;
    readonly context?: string | null;
    readonly contextInherited?: boolean;
  };
  readonly capabilities: {
    readonly fastMode?: boolean;
    readonly ultracode?: boolean;
    readonly ultracodeUnavailableReason?: string;
    readonly disableThinking?: boolean;
    readonly contextWindows?: readonly string[];
  };
  readonly change: (patch: AgentNativeIntelligencePatch) => Promise<void>;
}

export interface AgentIntelligenceDropdownProps {
  readonly provider?: {
    readonly label: string;
    readonly selection: string;
    readonly nativeIntelligence?: AgentNativeIntelligencePresentation;
    readonly modelCatalog?: AgentModelCatalogPresentation;
  };
  /** The Agent a plain `models` list belongs to when there is no model catalog; Codex if omitted. */
  readonly agent?: { readonly binding: AgentBackendBinding; readonly label: string };
  readonly models: readonly AgentModelOption[];
  readonly disabled?: boolean;
  readonly selection: AgentIntelligenceSelection;
  readonly inheritance?: AgentIntelligenceInheritance;
  /** Lists "Use current/default" first; choosing it calls `onInherit`. */
  readonly allowInherit?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onSelectionChange: (
    selection: AgentIntelligenceSelection,
    change: CodexExecutionProfileChange,
  ) => void;
  readonly onInherit?: () => void;
  readonly triggerStyle?: "composer" | "settings";
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly shortcut?: { readonly label?: string; readonly ariaKeyShortcuts?: string } | null;
}

const CODEX_AGENT = { binding: { kind: "codex" }, label: "Codex" } as const;

/** Every model choice uses the one picker; a plain model list becomes a catalog for one Agent. */
export function AgentIntelligenceDropdown(props: AgentIntelligenceDropdownProps) {
  const agent = props.agent ?? CODEX_AGENT;
  const catalog =
    props.provider?.modelCatalog ??
    listedModelCatalog({
      binding: agent.binding,
      label: agent.label,
      models: props.models,
      selection: props.selection,
      onSelectionChange: props.onSelectionChange,
    });
  return <AgentModelPicker {...props} catalog={catalog} />;
}
