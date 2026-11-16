import type { AcpAgentInstanceInput } from "../../../shared/acp-agent-settings";
import { localAgentDefinition, type LocalAgentFound } from "../../../shared/local-agents";

/**
 * Agents found on this computer that the Profile doesn't run yet. An Agent the person already
 * added, from the Registry or as their own command, isn't offered again.
 */
export function localAgentSuggestions(
  found: readonly LocalAgentFound[],
  instances: readonly { readonly agentDefinitionId: string }[] | null,
): readonly LocalAgentFound[] {
  if (instances === null) return [];
  return found.filter(
    (agent) =>
      agent.supported &&
      !instances.some(
        ({ agentDefinitionId }) =>
          agentDefinitionId === localAgentDefinition(agent.id).agentDefinitionId,
      ),
  );
}

/**
 * The ACP instance that runs a found Agent: its installed command with the arguments that start
 * its ACP server, signed in as it already is on this computer.
 */
export function localAgentInstance(
  agent: LocalAgentFound,
  id: string = crypto.randomUUID(),
): AcpAgentInstanceInput {
  const definition = localAgentDefinition(agent.id);
  return {
    id,
    agentDefinitionId: definition.agentDefinitionId,
    displayName: definition.name,
    enabled: true,
    source: { kind: "local", executable: agent.executable, args: [...definition.args] },
    environment: [],
    credentials: { kind: "inherit-host-profile" },
    proxy: "inherit-host",
    customModels: [],
  };
}

/** `agy 1.5.4`: the command and version that was found. */
export function localAgentFoundDetail(agent: LocalAgentFound): string {
  const command = agent.executable.split(/[\\/]/u).at(-1) ?? agent.executable;
  return agent.version ? `${command} ${agent.version}` : command;
}
