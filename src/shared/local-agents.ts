/**
 * Agents Nodex recognizes when they are already installed on the computer. Each serves the Agent
 * Client Protocol from its own command line, so connecting one is an ordinary ACP instance that
 * runs the person's installed command with their existing sign-in.
 */
interface LocalAgentTableRow {
  readonly id: string;
  readonly name: string;
  /** The ACP Registry identity, which selects the Agent's compatibility behavior. */
  readonly agentDefinitionId: string;
  /** Command names looked up on the host, in order. */
  readonly commands: readonly string[];
  /** Additional installer locations, relative to the home directory. */
  readonly homeLocations: readonly string[];
  /** Arguments that start its ACP server. */
  readonly args: readonly string[];
  /** The oldest version whose command line serves ACP. */
  readonly minimumVersion: string;
  /** Optional Agent-specific version output with the version in the first capture group. */
  readonly versionPattern?: RegExp;
  /** Output that positively identifies a different product. */
  readonly unrelatedVersionPattern?: RegExp;
}

export const LOCAL_AGENTS = [
  {
    id: "antigravity",
    name: "Google Antigravity",
    agentDefinitionId: "antigravity-acp",
    commands: ["agy"],
    homeLocations: [".local/bin/agy"],
    args: ["acp"],
    minimumVersion: "1.5.0",
    unrelatedVersionPattern:
      /^v?\d+\.\d+\.\d+(?:[-+][^\s]+)?\r?\n[\da-f]{7,64}\r?\n(?:arm64|x64|ia32|armhf|arm)$/iu,
  },
] as const satisfies readonly LocalAgentTableRow[];

export type LocalAgentId = (typeof LOCAL_AGENTS)[number]["id"];
export type LocalAgentDefinition = LocalAgentTableRow & { readonly id: LocalAgentId };

export interface LocalAgentScanOptions {
  readonly fresh?: boolean;
}

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
