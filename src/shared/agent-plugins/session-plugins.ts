/**
 * The plugins one Agent Session may use, resolved by the Host when the Session
 * opens. Codex loads installed plugins natively from its own home, so a Codex
 * Session only needs the plugins that are out of scope for its Project. Every
 * other backend receives the in-scope skills and plugin MCP servers through Nodex.
 *
 * Plugins are installed once, through Codex's plugin system. A plugin's identity is
 * Codex's plugin id, `name@marketplace`.
 */

export const SESSION_SKILLS_PLUGIN_NAME = "nodex-session-skills";

export type SessionPluginBackend = "codex" | "claude" | "acp" | "opencode";

export interface SessionPluginsRequest {
  /** The Nodex Session (thread) the plugins are opened for. */
  readonly threadId: string;
  /** The Session's Project, or null for a chat without a Project. */
  readonly projectId: string | null;
  readonly backend: SessionPluginBackend;
  /** ACP only: whether the running harness advertised HTTP MCP. */
  readonly acpHttp?: boolean;
}

export interface SessionPluginSkill {
  readonly pluginId: string;
  /** Invocation name inside `skillsRoot`, qualified by its plugin when names collide. */
  readonly alias: string;
  readonly description: string;
  readonly userInvocable?: false;
}

export interface SessionPluginServer {
  readonly pluginId: string;
  /** The server key declared by the plugin. */
  readonly serverKey: string;
  /** MCP server name for this Session; unique and safe for every backend. */
  readonly name: string;
  readonly url: string;
  /** Revocable, Session-scoped credential. Never place it on a command line. */
  readonly bearerToken: string;
}

export interface SessionPlugins {
  /** Changes whenever the resolved set changes. Backends refresh at their next safe point. */
  readonly revision: string;
  /**
   * Generated, immutable, skills-only plugin directory for this revision:
   * `.claude-plugin/plugin.json` and `skills/<alias>/`. Null when no in-scope plugin
   * has skills or the backend is Codex.
   */
  readonly skillsRoot: string | null;
  readonly skills: readonly SessionPluginSkill[];
  readonly mcpServers: readonly SessionPluginServer[];
  /** In-scope Codex plugin IDs, used to suppress duplicates in Claude Code. */
  readonly pluginIds: readonly string[];
  /** ACP only: the scoped skill catalog transport. */
  readonly skillCatalog?: Pick<SessionPluginServer, "name" | "url" | "bearerToken">;
  /** Codex only: installed plugins to disable for this Session's threads. */
  readonly codexDisabledPluginIds: readonly string[];
}

/**
 * What an installed plugin can do outside Codex. Codex supports every component
 * natively; other Agents receive skills and the MCP servers Nodex can run itself.
 */
export type PluginOutsideCodexLimitation =
  | { readonly kind: "mcp-server-needs-sign-in"; readonly serverKey: string }
  | { readonly kind: "connected-app"; readonly name: string }
  | { readonly kind: "hooks" };

export interface PluginAgentSupport {
  /** "full" when every component reaches other Agents, "none" when nothing does. */
  readonly outsideCodex: "full" | "partial" | "none";
  readonly limitations: readonly PluginOutsideCodexLimitation[];
}

/** Which Projects a plugin applies to. Installed plugins apply everywhere by default. */
export type PluginProjectScope =
  | { readonly kind: "all" }
  | { readonly kind: "projects"; readonly projectIds: readonly string[] };
