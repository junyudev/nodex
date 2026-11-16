/**
 * Agents Nodex recognizes when they are already installed on the computer. Each serves the Agent
 * Client Protocol from its own command line, so connecting one is an ordinary ACP instance that
 * runs the person's installed command with their existing sign-in.
 */
export interface LocalAgentDefinition {
  readonly id: "antigravity";
  readonly name: string;
  /** The ACP Registry identity, which selects the Agent's compatibility behavior. */
  readonly agentDefinitionId: string;
  /** Command names looked up on the login shell's PATH, in order. */
  readonly commands: readonly string[];
  /** Installer locations checked when the command isn't on PATH, relative to the home directory. */
  readonly homeLocations: readonly string[];
  /** Arguments that start its ACP server. */
  readonly args: readonly string[];
  /** The oldest version whose command line serves ACP. */
  readonly minimumVersion: string;
}

export const LOCAL_AGENTS: readonly LocalAgentDefinition[] = [
  {
    id: "antigravity",
    name: "Google Antigravity",
    agentDefinitionId: "antigravity-acp",
    commands: ["agy"],
    homeLocations: [".local/bin/agy"],
    args: ["acp"],
    minimumVersion: "1.5.0",
  },
];

export type LocalAgentId = LocalAgentDefinition["id"];

export const localAgentDefinition = (id: LocalAgentId): LocalAgentDefinition =>
  LOCAL_AGENTS.find((agent) => agent.id === id)!;

export const localAgentByDefinitionId = (agentDefinitionId: string): LocalAgentDefinition | null =>
  LOCAL_AGENTS.find((agent) => agent.agentDefinitionId === agentDefinitionId) ?? null;

/** One recognized Agent found on this computer. */
export interface LocalAgentFound {
  readonly id: LocalAgentId;
  /** The absolute path of the executable that was found. */
  readonly executable: string;
  /** What `--version` reported, when it answered. */
  readonly version: string | null;
  /** False when the installed version is older than the one that serves ACP. */
  readonly supported: boolean;
}

export interface LocalAgentScan {
  readonly agents: readonly LocalAgentFound[];
}
