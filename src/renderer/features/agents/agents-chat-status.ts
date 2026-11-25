import { defineMessages, type IntlShape } from "@/lib/i18n";
import type { AgentsMapChat, AgentsMapSnapshot } from "../../../shared/agents-map";
import { subagentAttentionLabel } from "../local-conversation/agent-runtime-subagent-overview";
import { formatSubagentElapsedTime } from "../local-conversation/view/subagents-panel/subagent-overview-format";

export type AgentsChatTone = "plain" | "attention" | "failed";

const MESSAGES = defineMessages({
  waiting: { id: "conversation.subagentsPanel.waiting", defaultMessage: "Waiting" },
  working: { id: "conversation.subagentsPanel.working", defaultMessage: "Working" },
  queued: { id: "agents.agentsChatStatus.queued", defaultMessage: "Queued" },
  background: { id: "agents.agentsChatStatus.background", defaultMessage: "Background" },
  failed: { id: "conversation.agentRuntimeSubagentOverview.failed", defaultMessage: "Failed" },
  stopped: { id: "conversation.agentRuntimeSubagentOverview.stopped", defaultMessage: "Stopped" },
  done: { id: "conversation.delegationMap.done", defaultMessage: "Done" },
});

const time = (value: string | null) => {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * What a chat's card says about its work, in the words its subagents' cards use for the same
 * state: what it asks of its person, its place in the queue, or how long it has been working.
 */
export function agentsChatStatus(
  chat: Pick<AgentsMapChat, "state" | "attention" | "queuePosition" | "startedAt" | "outcome">,
  nowMs: number,
  intl: IntlShape,
): { readonly text: string; readonly tone: AgentsChatTone } {
  switch (chat.state) {
    case "waiting":
      return {
        text: chat.attention
          ? subagentAttentionLabel(
              chat.attention === "approval" ? "approval" : "question_person",
              intl,
            )
          : intl.formatMessage(MESSAGES.waiting),
        tone: "attention",
      };
    case "queued":
      return {
        text:
          chat.queuePosition === null
            ? intl.formatMessage(MESSAGES.queued)
            : intl.formatMessage(
                { id: "agents.agentsChatStatus.queuedAt", defaultMessage: "Queued · #{position}" },
                { position: chat.queuePosition },
              ),
        tone: "plain",
      };
    case "background":
      return { text: intl.formatMessage(MESSAGES.background), tone: "plain" };
    case "working": {
      const startedAt = time(chat.startedAt);
      return {
        text:
          startedAt === null
            ? intl.formatMessage(MESSAGES.working)
            : formatSubagentElapsedTime(Math.max(0, nowMs - startedAt), intl),
        tone: "plain",
      };
    }
    case "settled":
      return chat.outcome === "failed"
        ? { text: intl.formatMessage(MESSAGES.failed), tone: "failed" }
        : chat.outcome === "stopped"
          ? { text: intl.formatMessage(MESSAGES.stopped), tone: "plain" }
          : { text: intl.formatMessage(MESSAGES.done), tone: "plain" };
  }
}

/** How many of a chat's subagents its lead counts as delegated and back. */
export const agentsChatDelegation = (chat: Pick<AgentsMapChat, "subagentCount">) => ({
  total: chat.subagentCount.total,
  back: Math.max(0, chat.subagentCount.total - chat.subagentCount.live),
});

/** When a settled chat's work ended, for its row's quiet clock. */
export const agentsChatSettledAtMs = (chat: Pick<AgentsMapChat, "settledAt">) =>
  time(chat.settledAt);

/**
 * How often the tab's clock must tick for what it shows: every second while a chat or one of
 * its subagents is working and shows its elapsed time, every half minute while only finished
 * chats show how long ago they ended, and never while it shows nothing.
 */
export function agentsClockIntervalMs(
  snapshot: Pick<AgentsMapSnapshot, "active" | "recent"> | null,
): number | null {
  if (!snapshot) return null;
  const working = snapshot.active.some(
    (chat) =>
      chat.state === "working" ||
      (chat.subagents?.active.items.some(
        (subagent) => subagent.status === "running" || subagent.status === "pending",
      ) ??
        false),
  );
  if (working) return 1_000;
  return snapshot.active.length > 0 || snapshot.recent.length > 0 ? 30_000 : null;
}
