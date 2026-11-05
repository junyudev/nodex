import type { ChatStatus, ChatSummary } from "@nodex/mobile-protocol";

export type ChatSectionId = "attention" | "working" | "recent";

export type ChatListRow =
  | { readonly type: "header"; readonly id: ChatSectionId; readonly label: string }
  | { readonly type: "chat"; readonly chat: ChatSummary };

const SECTION_LABELS: Readonly<Record<ChatSectionId, string>> = {
  attention: "Needs you",
  working: "Working",
  recent: "Recent",
};

/** A chat needs the person only while it is asking something; a failed Run stays in Recent, marked. */
const sectionOf = (chat: ChatSummary): ChatSectionId => {
  if (chat.status === "waiting" || chat.pendingRequestCount > 0) return "attention";
  if (chat.status === "running" || chat.status === "background") return "working";
  return "recent";
};

/**
 * Orders the list by what the person should look at first. Within a section the Host's recency order
 * stands, and an empty section has no header; a list with only recent chats needs no header at all.
 */
export const chatListRows = (chats: readonly ChatSummary[]): readonly ChatListRow[] => {
  const sections: Record<ChatSectionId, ChatSummary[]> = { attention: [], working: [], recent: [] };
  for (const chat of chats) sections[sectionOf(chat)].push(chat);
  const onlyRecent = sections.attention.length === 0 && sections.working.length === 0;
  const rows: ChatListRow[] = [];
  for (const id of ["attention", "working", "recent"] as const) {
    if (sections[id].length === 0) continue;
    if (!onlyRecent) rows.push({ type: "header", id, label: SECTION_LABELS[id] });
    for (const chat of sections[id]) rows.push({ type: "chat", chat });
  }
  return rows;
};

export const chatStatusTone = (status: ChatStatus): "accent" | "warning" | "danger" | null => {
  switch (status) {
    case "running":
    case "background":
      return "accent";
    case "waiting":
      return "warning";
    case "failed":
      return "danger";
    case "idle":
      return null;
  }
};

/** How many chats need the person, for the header's segment. */
export const attentionCount = (chats: readonly ChatSummary[]): number =>
  chats.filter((chat) => sectionOf(chat) === "attention").length;
