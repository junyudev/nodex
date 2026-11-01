import type { AgentBackendBinding } from "./agent-backend";

/** The harness whose mark identifies an Agent. */
export type AgentBackendKind = AgentBackendBinding["kind"];

/**
 * The Agent behind a conversation's work: its harness, the configured Agent instance, and the
 * model and effort it runs. The harness, not the model's maker, decides the mark: an OpenCode
 * Agent running a GPT model carries the OpenCode mark.
 */
export interface ConversationAgent {
  /** Null when the Agent is no longer configured and nothing else names its harness. */
  readonly kind: AgentBackendKind | null;
  /** The configured instance, which supplies the Agent's name and its model display names. */
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  /** The effort choice as its provider names it, such as Codex `xhigh` or Claude `high`. */
  readonly effort: string | null;
}

/**
 * How Nodex names another conversation where it attributes work to it: who sent a message,
 * answered a question, stopped a Run or was forked from. References resolve live, so a renamed
 * chat shows its current title and a chat handed to another Agent shows its current lead.
 */
export interface ConversationIdentity {
  readonly threadId: string;
  /** The Session that owns the conversation; opening it addresses this Session. */
  readonly sessionId: string | null;
  /** A chat's Session title, or a subagent's own name. */
  readonly title: string;
  /** A subagent belongs to the conversation that delegated it, inside the same Session. */
  readonly role: "chat" | "subagent";
  readonly agent: ConversationAgent | null;
  /** Archived chats stay nameable but no longer open from a reference. */
  readonly archived: boolean;
  /** Set when the conversation runs on another machine, such as an SSH execution host. */
  readonly host: { readonly id: string; readonly name: string } | null;
}

/** Runtime drivers belong to the same harness family as their configured desktop Agent. */
export function agentBackendKindOfDriver(
  driver: string | null | undefined,
): AgentBackendKind | null {
  if (!driver) return null;
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  if (driver === "opencode" || driver === "opencode2") return "opencode";
  return "acp";
}
