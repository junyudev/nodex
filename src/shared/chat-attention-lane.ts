export const CHAT_ATTENTION_LANES = ["pinned", "active", "working", "snoozed", "settled"] as const;
export type ChatAttentionLane = (typeof CHAT_ATTENTION_LANES)[number];

interface ChatAttentionState {
  readonly pinned: boolean;
  readonly settledAt?: number | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: number | null;
  readonly attentionAt: number;
  readonly stopped: boolean;
  readonly working: boolean;
}

export function resolveChatAttentionLane(chat: ChatAttentionState, now: number): ChatAttentionLane {
  if (chat.settledAt != null) return "settled";
  return resolveOpenChatAttentionLane(chat, now);
}

/** An unanswered request only breaks a snooze if it arrived after the Member set it. */
export function resolveOpenChatAttentionLane(
  chat: Omit<ChatAttentionState, "settledAt">,
  now?: number,
): Exclude<ChatAttentionLane, "settled"> {
  if (chat.pinned) return "pinned";
  const asksAnew = chat.stopped && (chat.snoozedAt === null || chat.attentionAt > chat.snoozedAt);
  if (chat.snoozedUntil && !asksAnew && (now === undefined || Date.parse(chat.snoozedUntil) > now))
    return "snoozed";
  return !chat.stopped && chat.working ? "working" : "active";
}

export interface ChatAttentionPlacement {
  readonly lane: ChatAttentionLane;
  readonly id: string;
  readonly pinnedOrder?: number | null;
  readonly stopped: boolean;
  readonly attentionAt: number;
  readonly snoozedUntil: string | null;
  readonly settledAt?: number | null;
}

/** Equal pin ranks preserve the order supplied by the caller. */
export function compareChatAttention(
  left: ChatAttentionPlacement,
  right: ChatAttentionPlacement,
): number {
  if (left.lane !== right.lane)
    return CHAT_ATTENTION_LANES.indexOf(left.lane) - CHAT_ATTENTION_LANES.indexOf(right.lane);
  const byId = () => left.id.localeCompare(right.id);
  if (left.lane === "pinned")
    return (
      (left.pinnedOrder ?? Number.MAX_SAFE_INTEGER) - (right.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
    );
  if (left.lane === "snoozed")
    return Date.parse(left.snoozedUntil ?? "") - Date.parse(right.snoozedUntil ?? "") || byId();
  if (left.lane === "settled") return (right.settledAt ?? 0) - (left.settledAt ?? 0) || byId();
  const newestFirst = right.attentionAt - left.attentionAt || byId();
  if (left.lane === "active") return Number(right.stopped) - Number(left.stopped) || newestFirst;
  return newestFirst;
}
