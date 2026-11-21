import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { acpRegistryAgent } from "../../shared/agents/acp-registry";
import { agentReadiness } from "../../shared/agents/readiness";
import { agentDefinition } from "../../shared/agents/registry";
import { isManagedRuntimeInstanceId } from "../../shared/managed-runtime-instances";
import { modelIsOn, spendsNodexCredit } from "../../shared/model-policy";
import {
  defaultAgentRuntimeModelSelection,
  isAgentRuntimeProviderAvailable,
  type AgentRuntimeNewChatDefaults,
} from "./agent-runtime-model-selection";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

/**
 * What makes two Agents a second opinion for each other: different software, or a different model
 * provider's key behind the same software. Two profiles of one built-in Agent think alike, so they
 * share its definition; an ACP Agent or a key connection is its own.
 */
const agentIdentity = (provider: Provider): string => {
  const definition = agentDefinition(provider.driver);
  const builtIn = definition.driver !== "" && definition !== acpRegistryAgent;
  return builtIn && !isManagedRuntimeInstanceId(provider.instanceId)
    ? definition.driver
    : `${provider.driver}:${provider.instanceId}`;
};

/** Nothing stands between this Agent and a message, including a check that hasn't answered. */
const canTakeWork = (provider: Provider): boolean =>
  isAgentRuntimeProviderAvailable(provider) &&
  agentReadiness({ definition: agentDefinition(provider.driver), provider }) === null &&
  provider.models.some(modelIsOn);

/**
 * Another Agent the lead could hand part of its work to right now, in catalog order. Credits are
 * never offered: an Agent may spend them only on a model it was asked for, and their instances all
 * go by Nodex's name, so naming one would not say which.
 */
export function agentTeammate(
  providers: readonly Provider[],
  leadInstanceId: string | null | undefined,
): Provider | null {
  const lead = providers.find((provider) => provider.instanceId === leadInstanceId);
  if (!lead) return null;
  return (
    providers.find(
      (provider) =>
        agentIdentity(provider) !== agentIdentity(lead) &&
        canTakeWork(provider) &&
        !spendsNodexCredit(provider),
    ) ?? null
  );
}

export interface AgentTeam {
  /** The Agent a new chat starts on. */
  readonly lead: Provider;
  readonly teammate: Provider;
}

/**
 * The Agent a new chat starts on and one it could hand work to; null without two that differ, or
 * while the chat would start on a model that is off.
 */
export function newChatAgentTeam(
  providers: readonly Provider[],
  defaults: AgentRuntimeNewChatDefaults = {},
): AgentTeam | null {
  const selection = defaultAgentRuntimeModelSelection(providers, defaults);
  const lead = providers.find((provider) => provider.instanceId === selection?.instanceId);
  const model = lead?.models.find((entry) => entry.slug === selection?.model);
  if (!lead || !model || !modelIsOn(model) || !canTakeWork(lead)) return null;
  const teammate = agentTeammate(providers, lead.instanceId);
  return teammate ? { lead, teammate } : null;
}
