import { getIntl } from "@/lib/i18n";
import type { CodexThreadActiveFlag } from "../../shared/types";

/**
 * A sidebar row shows at most one trailing status, each with its own glyph. Live statuses are the
 * chat asking for its person: waiting on them, work in progress, or unread news.
 */
export type SidebarRowLiveStatus = "attention" | "running" | "background" | "unread";

/**
 * Resting statuses are what the person left behind in a chat with nothing live: an unsent draft, or
 * a snooze. They use a quiet tone so they never compete with live statuses.
 */
export type SidebarRowRestingStatus = "draft" | "snoozed";

/**
 * An unread chat that came back because its snooze came due shows why: the reader asked for it.
 */
export type SidebarRowWokeStatus = "woke";

export type SidebarRowStatus =
  | SidebarRowLiveStatus
  | SidebarRowRestingStatus
  | SidebarRowWokeStatus;

/** The glyph a row shows: an unread chat that woke from a snooze says so until it is read. */
export function resolveSidebarRowGlyph(input: {
  readonly live: SidebarRowLiveStatus | null;
  readonly wokeAt: number | null | undefined;
  readonly hasDraft: boolean;
  readonly snoozedUntil: string | null | undefined;
}): SidebarRowStatus | null {
  if (input.live === "unread" && input.wokeAt != null) return "woke";
  return input.live ?? resolveSidebarRowRestingStatus(input);
}

/** A collapsed group summarizes its chats with the same glyphs as a row. */
export type SidebarGroupStatus = Extract<SidebarRowLiveStatus, "attention" | "unread" | "running">;

/** Names a collapsed group's glyph; a spinner already announces itself. */
export const SIDEBAR_GROUP_STATUS_LABELS: Readonly<Record<SidebarGroupStatus, string | undefined>> =
  {
    get attention() {
      return getIntl().formatMessage({
        id: "lib.sidebarStatus.waiting",
        defaultMessage: "Chats waiting for you",
      });
    },
    get unread() {
      return getIntl().formatMessage({
        id: "lib.sidebarStatus.unread",
        defaultMessage: "Unread chats",
      });
    },
    running: undefined,
  };

/**
 * A chat waiting on its person stops showing work in progress: it cannot continue until they
 * answer. Otherwise work in progress outranks unread, so the dot appears once the reply lands.
 */
export function resolveSidebarRowStatus(input: {
  readonly unread: boolean;
  readonly running: boolean;
  readonly background: boolean;
  readonly needsAttention: boolean;
}): SidebarRowLiveStatus | null {
  if (input.needsAttention) return "attention";
  if (input.running) return "running";
  if (input.background) return "background";
  return input.unread ? "unread" : null;
}

/**
 * A chat with nothing live rests on what its person left behind. A draft is the more concrete
 * trace, so it outranks a snooze; both outrank the linked Page's status.
 */
export function resolveSidebarRowRestingStatus(input: {
  readonly hasDraft: boolean;
  readonly snoozedUntil: string | null | undefined;
}): SidebarRowRestingStatus | null {
  if (input.hasDraft) return "draft";
  return input.snoozedUntil ? "snoozed" : null;
}

/**
 * Inside a collapsed group, a chat waiting on its person outranks news, and anything to answer or
 * read outranks work in progress.
 */
export function resolveSidebarGroupStatus(input: {
  readonly needsAttention: boolean;
  readonly unread: boolean;
  readonly running: boolean;
}): SidebarGroupStatus | null {
  if (input.needsAttention) return "attention";
  if (input.unread) return "unread";
  return input.running ? "running" : null;
}

/** A native thread waits on its person while it asks for an approval or for input. */
export function nativeThreadWaitsOnPerson(
  activeFlags: readonly CodexThreadActiveFlag[] | undefined,
): boolean {
  return (
    activeFlags?.includes("waitingOnApproval") === true ||
    activeFlags?.includes("waitingOnUserInput") === true
  );
}
