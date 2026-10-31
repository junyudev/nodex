import type { CodexThreadActiveFlag } from "../../shared/types";

/**
 * A sidebar row shows at most one trailing status, each with its own glyph: a chat waiting on its
 * person, work in progress, or unread news.
 */
export type SidebarRowStatus = "attention" | "running" | "background" | "unread";

/** A collapsed group summarizes its chats with the same glyphs as a row. */
export type SidebarGroupStatus = Extract<SidebarRowStatus, "attention" | "unread" | "running">;

/** Names a collapsed group's glyph; a spinner already announces itself. */
export const SIDEBAR_GROUP_STATUS_LABELS: Readonly<Record<SidebarGroupStatus, string | undefined>> =
  {
    attention: "Chats waiting for you",
    unread: "Unread chats",
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
}): SidebarRowStatus | null {
  if (input.needsAttention) return "attention";
  if (input.running) return "running";
  if (input.background) return "background";
  return input.unread ? "unread" : null;
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
