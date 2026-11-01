import type { AgentBackendKind, ConversationAgent } from "../../../shared/conversation-identity";
import { formatAgentModelName, formatCodexModelLabel } from "../../lib/codex-thread-settings";
import { agentEffortLabel } from "../../lib/agent-runtime-model-selection";
import type { AgentRuntimeProviderLabel } from "./agent-runtime-delegated-tasks";

/** Each harness's own name, for an Agent whose configured name is not loaded. */
const HARNESS_NAMES: Record<AgentBackendKind, string | null> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  acp: null,
};

/** An Agent as people read it: its mark, its configured name, the model and the effort. */
export interface AgentIdentityPresentation {
  readonly kind: AgentBackendKind | null;
  readonly agentName: string | null;
  readonly modelName: string | null;
  readonly effortName: string | null;
}

export function presentAgentIdentity(
  agent: ConversationAgent,
  labels: ReadonlyMap<string, AgentRuntimeProviderLabel>,
): AgentIdentityPresentation {
  const configured = agent.providerInstanceId ? labels.get(agent.providerInstanceId) : undefined;
  const kind = agent.kind ?? configured?.kind ?? null;
  const catalogName = agent.model ? configured?.models.get(agent.model) : undefined;
  return {
    kind,
    agentName: configured?.label ?? (kind ? HARNESS_NAMES[kind] : null),
    modelName: agent.model
      ? catalogName
        ? formatAgentModelName(catalogName)
        : formatCodexModelLabel(agent.model, [])
      : null,
    effortName: agent.effort ? agentEffortLabel(kind ?? "codex", agent.effort) : null,
  };
}

/**
 * What an Agent mark stands beside: `model` in rows, references and dividers, where the mark
 * names the Agent; `agent` in cards and tooltips, which spell its name too; `settings` where a
 * conversation shows its own settings, which add the effort it was given.
 */
export type AgentIdentityDetail = "model" | "agent" | "settings";

/** The words beside an Agent's mark. A model already named after its Agent stands alone. */
export function agentIdentityText(
  identity: AgentIdentityPresentation,
  detail: AgentIdentityDetail,
): string | null {
  const { agentName, modelName, effortName } = identity;
  const redundant =
    agentName !== null &&
    modelName !== null &&
    modelName.toLowerCase().startsWith(agentName.toLowerCase());
  const parts =
    detail === "agent"
      ? [redundant ? null : agentName, modelName ?? (redundant ? agentName : null)]
      : [modelName ?? agentName, detail === "settings" ? effortName : null];
  const text = [...new Set(parts.filter((part): part is string => Boolean(part)))].join(" · ");
  return text || null;
}

/** What assistive technology reads for a mark and its words: the Agent's name, always. */
export function agentIdentitySpokenText(
  identity: AgentIdentityPresentation,
  detail: AgentIdentityDetail,
): string | null {
  const visible = agentIdentityText(identity, detail);
  const named = agentIdentityText(identity, "agent");
  if (detail !== "settings" || !identity.effortName) return named;
  return [named, identity.effortName].filter(Boolean).join(" · ") || visible;
}
