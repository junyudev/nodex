import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@nodex/runtime-contracts";

/** A skill that teaches an Agent one Desktop Tool, in the host's own copy of its plugin. */
export interface McpProviderDesktopToolSkill {
  readonly name: string;
  readonly description: string;
  /** Absolute path of its `SKILL.md`. */
  readonly path: string;
}

/**
 * The Runtime's `node_repl` MCP server for this Thread: the in-app Browser, Chrome and
 * Computer Use. It takes the same Authorization header as the application server.
 */
export interface McpProviderDesktopTools {
  readonly endpoint: string;
  /** Plugin directories for providers that load skills natively; each holds `skills/`. */
  readonly pluginRoots: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<McpProviderDesktopToolSkill>;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Exact tools installed on this credential's host-owned application server. */
  readonly registeredToolNames?: ReadonlyArray<string>;
  /** Present while the host's Desktop Tools are ready for this Thread. */
  readonly desktopTools?: McpProviderDesktopTools;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
