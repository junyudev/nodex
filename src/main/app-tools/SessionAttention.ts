import type { components } from "@nodex/core-protocol";
import type { ThreadActiveFlag } from "@nodex/codex-app-server-protocol/v2";
import { resolveChatAttentionLane, type ChatAttentionLane } from "../../shared/chat-attention-lane";
import type { SessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";

type CoreSession = components["schemas"]["ProjectWorkspaceSessionSummary"];
type MemberRequests = components["schemas"]["AgentSessionMemberRequests"];

export interface SessionAttention {
  readonly lane: ChatAttentionLane | null;
  readonly waitingOn: "approval" | "input" | null;
  readonly working: "foreground" | "background" | null;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly attentionAt: number;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: number | null;
  readonly wokeAt: number | null;
  readonly settledAt: string | null;
}

type Status = {
  readonly status_type: string;
  readonly active_flags: readonly ThreadActiveFlag[];
};

/** Root execution facts and the Member's Core state describe the same chat, including child reads. */
export function projectSessionAttention(
  session: CoreSession,
  memberRequests: MemberRequests | undefined,
  status: Status | undefined,
  observed: SessionActivity | undefined,
  now: number,
): SessionAttention {
  const runtime = observed?.threadId === session.execution_ref?.thread_id ? observed : undefined;
  const flags = runtime?.activeFlags ?? status?.active_flags ?? [];
  const mayAnswer = (kind: "approval" | "question") =>
    memberRequests?.personal === true ||
    memberRequests?.pending.some(
      (request) =>
        request.kind === kind &&
        (!session.execution_ref || runtime?.pendingRequestIds?.includes(request.id)),
    ) === true;
  const waitingOn = session.archived
    ? null
    : flags.includes("waitingOnApproval") && mayAnswer("approval")
      ? "approval"
      : flags.includes("waitingOnUserInput") && mayAnswer("question")
        ? "input"
        : null;
  const working =
    session.archived || waitingOn !== null
      ? null
      : runtime?.status === "background"
        ? "background"
        : runtime?.status === "running" ||
            (!runtime && status?.status_type === "active" && flags.length === 0)
          ? "foreground"
          : null;
  const attention = {
    waitingOn,
    working,
    unread: session.unread,
    pinned: session.pinned,
    attentionAt: session.attention_at,
    snoozedUntil: session.snoozed_until ?? null,
    snoozedAt: session.snoozed_at ?? null,
    wokeAt: session.woke_at ?? null,
  } satisfies Omit<SessionAttention, "lane" | "settledAt">;
  const settledAt = session.settled_at ?? null;
  return {
    ...attention,
    settledAt: settledAt === null ? null : new Date(settledAt).toISOString(),
    lane: session.archived
      ? null
      : resolveChatAttentionLane(
          {
            ...attention,
            settledAt,
            stopped: waitingOn !== null,
            working: working !== null,
          },
          now,
        ),
  };
}
