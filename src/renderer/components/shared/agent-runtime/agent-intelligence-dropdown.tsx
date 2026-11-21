import type { Ref } from "react";
import type { AgentBackendBinding } from "../../../../shared/agent-backend";
import type { CodexExecutionProfileChange } from "../../../../shared/codex-execution-profile";
import type { ClaudeEffortLevel } from "../../../../shared/claude-models";
import type {
  AgentModelOption,
  CodexReasoningEffort,
  CodexServiceTier,
} from "../../../../shared/types";
import { AgentModelPicker, AgentModelPickerView } from "./agent-model-picker";
import type { AgentModelCatalogPresentation } from "./agent-model-catalog-presentation";
import { useAgentModelCatalog, type AgentIntelligenceMenu } from "./use-agent-intelligence-menu";

export interface AgentIntelligenceSelection {
  readonly kind: "codex" | "claude" | "acp" | "opencode" | "antigravity";
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

function AgentIntelligenceDropdownWithCatalog(props: AgentIntelligenceDropdownProps) {
  const catalog = useAgentModelCatalog(props);
  return <AgentModelPicker {...props} catalog={catalog} />;
}

/** A Composer with more than one intelligence surface can share one menu and native write queue. */
export function AgentIntelligenceDropdown({
  menu,
  ...props
}: AgentIntelligenceDropdownProps & { readonly menu?: AgentIntelligenceMenu }) {
  if (menu) return <AgentModelPickerView {...props} menu={menu} />;
  return <AgentIntelligenceDropdownWithCatalog {...props} />;
}
