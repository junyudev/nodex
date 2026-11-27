import {
  compareChatAttention,
  resolveOpenChatAttentionLane,
  type ChatAttentionLane,
} from "../../shared/chat-attention-lane";
import { presentChatReplyPreview } from "../../shared/chat-reply-preview-text";
import type { SidebarRowLiveStatus } from "./sidebar-status";

/**
 * Where an open chat sits for its reader, by whose move it is. Pinned chats are standing ones that
 * never finish. Everything else is `active` while it waits on the person, `working` while its Agent
 * works, and `snoozed` until its wake time.
 */
export type SidebarChatLane = Exclude<ChatAttentionLane, "settled">;

export const SIDEBAR_CHAT_LANES = ["pinned", "active", "working", "snoozed"] as const;

export interface SidebarLifecycleChat {
  readonly id: string;
  readonly pinned: boolean;
  /** Its place among the reader's pins, which they arrange themselves. */
  readonly pinnedOrder: number | null;
  readonly snoozedUntil: string | null;
  /** When the reader snoozed it, in Unix ms. */
  readonly snoozedAt: number | null;
  /** When the chat last came back to a person, in Unix ms. */
  readonly attentionAt: number;
  readonly status: SidebarRowLiveStatus | null;
}

/**
 * A snooze defers what the chat was asking when the reader set it; only a request that comes
 * after it brings the chat back early. Unread is only a mark on a row: reading never moves it.
 */
export function resolveSidebarChatLane(
  chat: Pick<
    SidebarLifecycleChat,
    "pinned" | "snoozedUntil" | "snoozedAt" | "attentionAt" | "status"
  >,
): SidebarChatLane {
  return resolveOpenChatAttentionLane({
    ...chat,
    stopped: chat.status === "attention",
    working: chat.status === "running" || chat.status === "background",
  });
}

/**
 * Where the chat on screen sat when the reader opened it. It keeps that place while they stay in
 * it: answering it or watching it work never sends it to another lane under their eyes.
 */
export interface SidebarChatAnchor {
  readonly id: string;
  readonly lane: SidebarChatLane;
  readonly stopped: boolean;
  readonly attentionAt: number;
}

export function anchorSidebarChat(chat: SidebarLifecycleChat): SidebarChatAnchor {
  return {
    id: chat.id,
    lane: resolveSidebarChatLane(chat),
    stopped: chat.status === "attention",
    attentionAt: chat.attentionAt,
  };
}

interface Placement {
  readonly lane: SidebarChatLane;
  readonly stopped: boolean;
  readonly attentionAt: number;
}

const ANCHORED_LANES: ReadonlySet<SidebarChatLane> = new Set(["active", "working"]);

function placeSidebarChat(chat: SidebarLifecycleChat, anchor: SidebarChatAnchor | null): Placement {
  const lane = resolveSidebarChatLane(chat);
  // Only the Agent moves a chat between Active and Working; what the reader does moves it at once.
  if (anchor?.id === chat.id && ANCHORED_LANES.has(lane) && ANCHORED_LANES.has(anchor.lane))
    return { lane: anchor.lane, stopped: anchor.stopped, attentionAt: anchor.attentionAt };
  return { lane, stopped: chat.status === "attention", attentionAt: chat.attentionAt };
}

/**
 * Splits the reader's open chats into lanes. Pinned chats keep the order they arrive in, which is
 * the person's own. The Active lane leads with the ones an Agent is stopped on, then the chat that
 * came back most recently. The Snoozed lane leads with the chat due to wake soonest.
 */
export function partitionSidebarChats<Chat extends SidebarLifecycleChat>(
  chats: readonly Chat[],
  anchor: SidebarChatAnchor | null = null,
): Readonly<Record<SidebarChatLane, readonly Chat[]>> {
  const placed = chats
    .map((chat) => ({
      chat,
      id: chat.id,
      snoozedUntil: chat.snoozedUntil,
      // Core supplies the sidebar's pins in the reader's order.
      ...placeSidebarChat(chat, anchor),
    }))
    .sort(compareChatAttention);
  const inLane = (lane: SidebarChatLane) =>
    placed.filter((entry) => entry.lane === lane).map((entry) => entry.chat);
  return {
    pinned: inLane("pinned"),
    active: inLane("active"),
    working: inLane("working"),
    snoozed: inLane("snoozed"),
  };
}

/** The order of each lane, by chat id. */
export type SidebarLaneOrder = Readonly<Record<SidebarChatLane, readonly string[]>>;

export function sidebarLaneOrder(
  lanes: Readonly<Record<SidebarChatLane, readonly { readonly id: string }[]>>,
): SidebarLaneOrder {
  return {
    pinned: lanes.pinned.map((chat) => chat.id),
    active: lanes.active.map((chat) => chat.id),
    working: lanes.working.map((chat) => chat.id),
    snoozed: lanes.snoozed.map((chat) => chat.id),
  };
}

/**
 * What the reader set on a chat: its pin, its place among their pins, and its snooze. A change
 * means they acted on it, so it moves at once even while the lanes hold still.
 */
export function sidebarChatReaderMark(
  chat: Pick<SidebarLifecycleChat, "pinned" | "pinnedOrder" | "snoozedUntil">,
): string {
  return `${chat.pinned}|${chat.pinnedOrder ?? ""}|${chat.snoozedUntil ?? ""}`;
}

/**
 * The lanes while the reader points at or works in the sidebar: every chat they saw keeps its lane
 * and place. A chat they acted on (`released`) moves at once to where it now belongs. A chat that
 * arrived meanwhile waits until they leave, unless it lands after every row they saw, as a page
 * they asked for does. Chats that left the list leave at once.
 */
export function holdSidebarLanes<Chat extends { readonly id: string }>(
  fresh: Readonly<Record<SidebarChatLane, readonly Chat[]>>,
  held: SidebarLaneOrder | null,
  released: ReadonlySet<string>,
): Readonly<Record<SidebarChatLane, readonly Chat[]>> {
  if (!held) return fresh;
  const byId = new Map(SIDEBAR_CHAT_LANES.flatMap((lane) => fresh[lane].map((c) => [c.id, c])));
  const seen = new Set(SIDEBAR_CHAT_LANES.flatMap((lane) => held[lane]));
  const result = {} as Record<SidebarChatLane, Chat[]>;
  for (const lane of SIDEBAR_CHAT_LANES) {
    const kept = held[lane].filter((id) => byId.has(id) && !released.has(id));
    const rows = kept.map((id) => byId.get(id)!);
    const keptIds = new Set(kept);
    const lastKept = fresh[lane].findLastIndex((chat) => keptIds.has(chat.id));
    fresh[lane].forEach((chat, index) => {
      if (keptIds.has(chat.id)) return;
      if (released.has(chat.id)) {
        // It goes below as many rows as sit above it in the fresh lane.
        const above = fresh[lane].slice(0, index).filter((row) => rows.includes(row)).length;
        rows.splice(above, 0, chat);
      } else if (!seen.has(chat.id) && index > lastKept) rows.push(chat);
    });
    result[lane] = rows;
  }
  return result;
}

/** Every list of chats Attention view shows: its lanes and the Settled shelf. */
export type SidebarChatShelf = SidebarChatLane | "settled";

/**
 * The lists a reader may leave out of Attention view, in the order it shows them.
 * `Active` always shows: it is what the arrangement is for.
 */
export const SIDEBAR_OPTIONAL_SHELVES = [
  "pinned",
  "working",
  "snoozed",
  "projects",
  "settled",
] as const;
export type SidebarOptionalShelf = (typeof SIDEBAR_OPTIONAL_SHELVES)[number];

/** The lists a stored preference hides: known ones only, once each, in display order. */
export function normalizeSidebarHiddenShelves(value: unknown): readonly SidebarOptionalShelf[] {
  if (!Array.isArray(value)) return [];
  return SIDEBAR_OPTIONAL_SHELVES.filter((shelf) => value.includes(shelf));
}

/**
 * The Active chats that "Settle read chats" settles: read ones that ask nothing and whose Agent
 * is not working, in lane order. `quiet` rules out the rest: a chat that never started a
 * conversation has nothing to settle, and one whose Page waits on the reader still asks.
 */
export function resolveSettleableReadChats(
  activeChats: readonly Pick<SidebarLifecycleChat, "id" | "status">[],
  quiet: (chatId: string) => boolean,
): readonly string[] {
  return activeChats
    .filter((chat) => chat.status === null && quiet(chat.id))
    .map((chat) => chat.id);
}

/** What a chat row says under its title: why it waits on the reader, then what it is about. */
export interface SidebarChatPreview {
  /** The Page's words for what waits on the reader, such as "Ready for your review". */
  readonly lead: string | null;
  readonly text: string | null;
}

/**
 * The lines a chat row shows under its title. A chat whose Page waits on the reader leads with
 * the Page's words for it. Then, while the chat's Agent is on a Run, the row says what that Run
 * is about: the approval it waits on, else what the Agent said it would do. Otherwise it shows
 * the Agent's latest reply. Null when there is nothing to say.
 */
export function resolveSidebarChatPreview(input: {
  readonly turn: string | null;
  readonly needsApproval: boolean;
  readonly approvalPrompt: string | null;
  /** The active Run's opening statement; it belongs to that Run only. */
  readonly readback: string | null;
  readonly reply: string | null;
}): SidebarChatPreview | null {
  const current =
    input.needsApproval && input.approvalPrompt ? input.approvalPrompt : input.readback;
  const text = (current ? presentChatReplyPreview(current) : null) ?? input.reply;
  return input.turn || text ? { lead: input.turn, text } : null;
}

/** A chat that asks something of its reader: an answer, an approval, or a look at its news. */
export function sidebarChatNeedsReader(status: SidebarRowLiveStatus | null): boolean {
  return status === "attention" || status === "unread";
}

/** How many open chats ask something of their reader now; a snoozed one asks once it wakes. */
export function countChatsAskingReader(chats: readonly SidebarLifecycleChat[]): number {
  return chats.filter(
    (chat) => sidebarChatNeedsReader(chat.status) && resolveSidebarChatLane(chat) !== "snoozed",
  ).length;
}

/**
 * The chat to show once `chatId` leaves the list: the row that takes its place, or the one above
 * when it was last. Null when it was the only one, or was not listed.
 */
export function resolveChatAfterLeaving(
  orderedChatIds: readonly string[],
  chatId: string,
): string | null {
  const index = orderedChatIds.indexOf(chatId);
  if (index < 0) return null;
  return orderedChatIds[index + 1] ?? orderedChatIds[index - 1] ?? null;
}

/** The neighbouring chat in list order, wrapping at either end. Null when there is no other. */
export function stepSidebarChat(
  orderedChatIds: readonly string[],
  currentChatId: string | null,
  direction: "next" | "previous",
): string | null {
  if (orderedChatIds.length === 0) return null;
  const index = currentChatId === null ? -1 : orderedChatIds.indexOf(currentChatId);
  if (index < 0) return orderedChatIds[direction === "next" ? 0 : orderedChatIds.length - 1]!;
  if (orderedChatIds.length === 1) return null;
  const step = direction === "next" ? 1 : -1;
  return orderedChatIds[(index + step + orderedChatIds.length) % orderedChatIds.length]!;
}

/**
 * The next chat in list order that asks something of its reader, starting below the current chat
 * and wrapping. Null when no other chat does.
 */
export function resolveNextChatNeedingReader(
  orderedChats: readonly { readonly id: string; readonly needsReader: boolean }[],
  currentChatId: string | null,
): string | null {
  const start = currentChatId === null ? -1 : orderedChats.findIndex((c) => c.id === currentChatId);
  for (let offset = 1; offset <= orderedChats.length; offset += 1) {
    const candidate = orderedChats[(start + offset + orderedChats.length) % orderedChats.length]!;
    if (candidate.needsReader && candidate.id !== currentChatId) return candidate.id;
  }
  return null;
}

/** Days of quiet after which an idle chat is settled for its person; null leaves them open. */
export type SidebarAutoSettleDays = number | null;

export const SIDEBAR_AUTO_SETTLE_DAY_OPTIONS = [1, 3, 7, 30] as const;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_DAYS = 7;

export function normalizeSidebarAutoSettleDays(value: unknown): SidebarAutoSettleDays {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365
    ? value
    : DEFAULT_SIDEBAR_AUTO_SETTLE_DAYS;
}

/** Chats that last asked for a person before this instant have been idle long enough. */
export function resolveAutoSettleIdleBefore(now: number, days: number): number {
  return now - days * 24 * 60 * 60 * 1000;
}

/**
 * How the sidebar arranges the reader's open chats: grouped under the Project each belongs to,
 * or, in Attention view, by whose move each one is, across every Project.
 */
export type SidebarOrganize = "attention" | "project";

/** Chats sit under their Projects until the reader turns on Attention view. */
export function normalizeSidebarOrganize(value: unknown): SidebarOrganize {
  return value === "attention" ? "attention" : "project";
}

/**
 * How many lines a row in `Pinned`, `Active` and `Working` gives to what its chat is about.
 * Snoozed and settled chats ask nothing now, so their rows always keep to the title line.
 */
export type SidebarChatPreviewLines = 0 | 1 | 2;

export const SIDEBAR_CHAT_PREVIEW_LINE_OPTIONS = [2, 1, 0] as const;
export const DEFAULT_SIDEBAR_CHAT_PREVIEW_LINES = 2;

export function normalizeSidebarChatPreviewLines(value: unknown): SidebarChatPreviewLines {
  return value === 0 || value === 1 || value === 2 ? value : DEFAULT_SIDEBAR_CHAT_PREVIEW_LINES;
}
