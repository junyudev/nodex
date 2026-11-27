import type { ChatSummary, InboxEntry } from "@nodex/mobile-protocol";
import type { MiniCoverage, MiniTurnRef } from "../../../shared/mini";
import type { InboxDraft } from "../inbox/inbox-capture-state";

/**
 * What Mini shows, derived from the same companion reads the phone uses. A card is one chat, or one
 * Page Turn, that is the person's concern right now: it needs them, it failed, it finished and
 * they have not seen it, or it is working. Read chats that are idle are not Mini's concern.
 */
export type MiniCardTone = "attention" | "failed" | "starting" | "done" | "working";

interface CardIdentity {
  /** Which chat, Turn or start the card is; stable while it changes. */
  readonly key: string;
  /** How it stands; a dismissed card returns once this changes. */
  readonly version: string;
}

export type MiniCard =
  | (CardIdentity & {
      readonly kind: "chat";
      readonly sessionId: string;
      readonly tone: MiniCardTone;
      readonly title: string;
      readonly project: string | null;
      /** The ask when it needs the person; else what it is doing or what it said last. */
      readonly line: string | null;
      readonly canSend: boolean;
      readonly activityAt: number;
    })
  | (CardIdentity & {
      readonly kind: "turn";
      readonly entryId: string;
      readonly pageId: string;
      readonly episode: string;
      readonly reason: MiniTurnReason;
      readonly tone: MiniCardTone;
      readonly title: string;
      readonly project: string | null;
      readonly line: string | null;
      readonly options: readonly string[];
      readonly canReply: boolean;
      readonly sessionId: string | null;
      readonly activityAt: number;
    })
  | (CardIdentity & {
      /** A chat Mini is starting, or could not start, before the chat list has it. */
      readonly kind: "starting";
      readonly sessionId: string;
      readonly tone: "starting" | "failed";
      readonly title: string;
      readonly project: string | null;
      readonly line: string | null;
      readonly activityAt: number;
    });

/** The Page Turns that are the person's move; the quieter ones stay in the Inbox. */
export type MiniTurnReason = "question" | "approval" | "review" | "reply" | "blocked" | "failed";
const TURN_REASONS = new Set<string>([
  "question",
  "approval",
  "review",
  "reply",
  "blocked",
  "failed",
]);

/**
 * A chat the person asked Mini to start, kept until the chat list settles it. Its identities are
 * chosen once, so sending it again, after a failure or a reload, replays the same chat; its draft
 * is what goes back to the composer if the person takes it back.
 */
export interface MiniStart {
  readonly sessionId: string;
  readonly launchId: string;
  readonly messageId: string;
  readonly projectId: string | null;
  readonly project: string | null;
  readonly draft: InboxDraft;
  readonly startedAt: number;
  /** `sending` until the Host answers, then `sent`, or `failed` with why. */
  readonly status: "sending" | "sent" | "failed";
  readonly sentAt: number | null;
  readonly error: string | null;
}

/** A card the person dismissed, as it stood then. */
export interface MiniDismissal {
  readonly key: string;
  readonly version: string;
}

const TONE_ORDER: Readonly<Record<MiniCardTone, number>> = {
  attention: 0,
  failed: 1,
  starting: 2,
  done: 3,
  working: 4,
};

const WORKING = new Set<ChatSummary["status"]>(["running", "background"]);

function chatTone(chat: ChatSummary): MiniCardTone | null {
  if (chat.status === "waiting" || chat.pendingRequestCount > 0) return "attention";
  if (chat.status === "failed") return "failed";
  if (WORKING.has(chat.status)) return "working";
  return chat.unread ? "done" : null;
}

function turnTone(reason: MiniTurnReason): MiniCardTone {
  return reason === "failed" || reason === "blocked" ? "failed" : "attention";
}

const progressOf = (chat: ChatSummary): string | null => chat.progress?.trim() || null;

/**
 * A start the chat list has settled: its chat is listed and no longer working, or a read since it
 * was sent does not have it (archived, or past the list's end).
 */
export function miniStartSettled(
  start: MiniStart,
  chats: readonly ChatSummary[],
  chatsReadAt: number,
): boolean {
  if (start.status !== "sent") return false;
  const chat = chats.find((candidate) => candidate.sessionId === start.sessionId);
  if (!chat) return start.sentAt !== null && chatsReadAt > start.sentAt;
  return chatTone(chat) !== "working";
}

/**
 * Cards in the order Mini stacks them. A chat the person started from Mini leads until it settles,
 * so they see it take and follow it; then what needs them, what failed, what finished unseen and
 * what is working, newest first within each. A Page Turn about a chat stands in for that chat's own
 * card, since the Turn carries the decision.
 */
export function miniCards(input: {
  readonly chats: readonly ChatSummary[];
  /** When the chat list was last read, so a start it no longer has can be let go. */
  readonly chatsReadAt: number;
  readonly inbox: readonly InboxEntry[];
  readonly starts: readonly MiniStart[];
  readonly dismissed: readonly MiniDismissal[];
  /** Names a Project the Inbox refers to by id. */
  readonly projectName: (projectId: string) => string | null;
}): MiniCard[] {
  const cards: MiniCard[] = [];
  const leading = new Set<string>();
  const turnSessions = new Set<string>();
  for (const entry of input.inbox) {
    if (entry.rowKind !== "turn") continue;
    const reason = entry.turn.reason;
    if (!reason || !TURN_REASONS.has(reason)) continue;
    const turnReason = reason as MiniTurnReason;
    if (entry.turn.chatSessionId) turnSessions.add(entry.turn.chatSessionId);
    cards.push({
      kind: "turn",
      key: `turn:${entry.pageId}:${entry.turn.episode}`,
      version: `${turnReason}:${entry.turn.since}`,
      entryId: entry.id,
      pageId: entry.pageId,
      episode: entry.turn.episode,
      reason: turnReason,
      tone: turnTone(turnReason),
      title: entry.title,
      project: entry.scope.kind === "project" ? input.projectName(entry.scope.projectId) : null,
      line: entry.turn.deliveryError ?? firstLine(entry.body),
      options: entry.turn.options,
      canReply: entry.turn.replyCapability.kind === "available",
      sessionId: entry.turn.chatSessionId,
      activityAt: Date.parse(entry.turn.since) || 0,
    });
  }
  const started = new Set(
    input.starts.filter((start) => start.status === "sent").map((start) => start.sessionId),
  );
  const carded = new Set<string>();
  for (const chat of input.chats) {
    if (chat.archived || turnSessions.has(chat.sessionId)) continue;
    const tone = chatTone(chat);
    if (!tone) continue;
    const key = `chat:${chat.sessionId}`;
    carded.add(chat.sessionId);
    if (tone === "working" && started.has(chat.sessionId)) leading.add(key);
    cards.push({
      kind: "chat",
      key,
      // Work in progress is one state however long it runs; anything else is new when it is.
      version: tone === "working" ? tone : `${tone}:${chat.activityAt ?? 0}`,
      sessionId: chat.sessionId,
      tone,
      title: chat.title,
      project: chat.projectName,
      line: tone === "attention" ? (chat.attention ?? progressOf(chat)) : progressOf(chat),
      canSend: chat.canSend,
      activityAt: chat.activityAt ?? 0,
    });
  }
  for (const start of input.starts) {
    if (carded.has(start.sessionId) || turnSessions.has(start.sessionId)) continue;
    if (miniStartSettled(start, input.chats, input.chatsReadAt)) continue;
    const key = `starting:${start.sessionId}`;
    leading.add(key);
    cards.push({
      kind: "starting",
      key,
      version: start.status,
      sessionId: start.sessionId,
      tone: start.status === "failed" ? "failed" : "starting",
      title: miniStartTitle(start.draft),
      project: start.project,
      line: start.error,
      activityAt: start.startedAt,
    });
  }
  const dismissed = new Map(input.dismissed.map((entry) => [entry.key, entry.version]));
  return cards
    .filter((card) => dismissed.get(card.key) !== card.version)
    .sort(
      (left, right) =>
        Number(leading.has(right.key)) - Number(leading.has(left.key)) ||
        TONE_ORDER[left.tone] - TONE_ORDER[right.tone] ||
        right.activityAt - left.activityAt,
    );
}

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/u)[0]?.trim();
  return line ? line : null;
}

/** The dock's count: what is waiting on the person, never what is merely running. */
export const miniAttentionCount = (cards: readonly MiniCard[]): number =>
  cards.filter((card) => card.tone === "attention" || card.tone === "failed").length;

/** A chat started from Mini is named by its first line until it has a title of its own. */
export function miniStartTitle(draft: InboxDraft): string {
  const line = draft.text.trim().split(/\r?\n/u)[0]?.trim() || draft.title.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** What Mini tells Main it shows: every card's chat and Page Turn, and a passing notice. */
export function miniCoverage(cards: readonly MiniCard[], notice: boolean): MiniCoverage {
  const chats = new Set<string>();
  const turns: MiniTurnRef[] = [];
  for (const card of cards) {
    if (card.kind === "turn") turns.push({ pageId: card.pageId, episode: card.episode });
    else chats.add(card.sessionId);
  }
  return { chats: [...chats], turns, notice };
}

/** How your chats stand, as the dock's Nodex mark shows it. */
export type MiniStatus = "idle" | "working" | "attention" | "failed";

/** What needs the person, else what failed, else work under way, else nothing to say. */
export function miniStatus(cards: readonly MiniCard[]): MiniStatus {
  if (cards.some((card) => card.tone === "attention")) return "attention";
  if (cards.some((card) => card.tone === "failed")) return "failed";
  if (cards.some((card) => card.tone === "working" || card.tone === "starting")) return "working";
  return "idle";
}
