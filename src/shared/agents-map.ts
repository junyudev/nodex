import type { AgentSubagentOverview } from "@nodex/agent-runtime/contracts";
import type { ConversationAgent } from "./conversation-identity";

/**
 * Which chats an Agents view shows: one Project's, or, with no Project, every Project's together
 * with the chats that belong to none.
 */
export interface AgentsMapScope {
  readonly projectId: string | null;
}

/**
 * Where a chat's work stands. A waiting chat waits on its person; a queued one waits for the
 * Runtime to admit its next Run; background work runs while no Run is in the foreground. A
 * settled chat has no live work.
 */
export type AgentsMapChatState = "working" | "waiting" | "queued" | "background" | "settled";

/** How a settled chat's latest Run ended. */
export type AgentsMapChatOutcome = "completed" | "failed" | "stopped";

/** One chat and its work tree, as the Agents view draws it. */
export interface AgentsMapChat {
  readonly sessionId: string;
  readonly rootThreadId: string;
  readonly projectId: string | null;
  /** The Agent the chat runs on now: its instance, model and effort. */
  readonly agent: ConversationAgent | null;
  readonly state: AgentsMapChatState;
  /** What the chat asks of its person while it waits on them. */
  readonly attention: "approval" | "question" | null;
  /**
   * One short line about the chat's current work: the request waiting on the person, else the
   * active Run's opening statement, else its background work. Null when there is none.
   */
  readonly line: string | null;
  /** The chat's place in the admission queue, from 1, while it is queued. */
  readonly queuePosition: number | null;
  /** When the chat's current round of work began. Live chats keep this order. */
  readonly startedAt: string | null;
  /** When the chat's latest Run ended, for a settled chat. */
  readonly settledAt: string | null;
  readonly outcome: AgentsMapChatOutcome | null;
  /** Whether the chat holds a result its person has not seen yet. */
  readonly unread: boolean;
  /** The Page most recently assigned this chat as its active chat. */
  readonly page: { readonly id: string; readonly key: string | null } | null;
  /** Whether Nodex watches this chat's work. */
  readonly managed: boolean;
  /** How many subagents the chat's work tree holds, and how many of them are live. */
  readonly subagentCount: { readonly total: number; readonly live: number };
  /**
   * The chat's work tree, bounded as the Subagents overview bounds it. Live chats carry it;
   * settled chats carry only their counts.
   */
  readonly subagents: AgentSubagentOverview | null;
}

export interface AgentsMapReadInput {
  readonly scope: AgentsMapScope;
  /** How many recently settled chats to return, up to AGENTS_MAP_MAX_RECENT_LIMIT. */
  readonly recentLimit: number;
}

export interface AgentsMapSnapshot {
  readonly scope: AgentsMapScope;
  /** Advances whenever anything the snapshot shows may have changed. */
  readonly revision: number;
  /** Chats with live work, in the order their current work started. */
  readonly active: readonly AgentsMapChat[];
  /** Chats whose work ended in the last 24 hours, newest first, up to `recentLimit`. */
  readonly recent: readonly AgentsMapChat[];
  /** Whether more recently settled chats exist beyond `recent`. */
  readonly hasMoreRecent: boolean;
  /** False when more live chats exist than the snapshot holds. */
  readonly complete: boolean;
}

export const AGENTS_MAP_RECENT_PAGE = 10;
export const AGENTS_MAP_MAX_RECENT_LIMIT = 500;
export const AGENTS_MAP_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
