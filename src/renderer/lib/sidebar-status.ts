/**
 * A sidebar row shows at most one trailing status. Attention and unread share the unread dot;
 * attention only changes how the row is described.
 */
export type SidebarRowStatus = "attention" | "running" | "background" | "unread";

/** A collapsed group summarizes its chats with the same dot or spinner as a row. */
export type SidebarGroupStatus = Extract<SidebarRowStatus, "unread" | "running">;

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

/** Inside a collapsed group, anything to read or answer outranks work in progress. */
export function resolveSidebarGroupStatus(input: {
  readonly needsReading: boolean;
  readonly running: boolean;
}): SidebarGroupStatus | null {
  if (input.needsReading) return "unread";
  return input.running ? "running" : null;
}
