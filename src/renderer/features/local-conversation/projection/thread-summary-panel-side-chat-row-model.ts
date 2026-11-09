import type { PanelId, CodexConversationSnapshot } from "../../../lib/types";
import type { ThreadSummaryPanelAuxiliaryRow } from "../thread-stage-types";
import { runtimeSideChatTabId } from "../../../../shared/side-chat-tab";

export interface ThreadSummaryPanelSideChatRowInput {
  id: string;
  title: string;
  threadId: string | null;
  panelId?: PanelId;
  leafId?: string | null;
}

/** A remote side chat, which exists only while its tab is open. */
export function buildThreadSummaryPanelSideChatRow(
  input: ThreadSummaryPanelSideChatRowInput,
  conversation:
    | Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">
    | null
    | undefined,
): ThreadSummaryPanelAuxiliaryRow {
  return {
    id: input.id,
    title: input.title,
    isResponseInProgress: isThreadSummarySideChatResponseInProgress(conversation),
    panelId: input.panelId,
    leafId: input.leafId ?? null,
  };
}

/** A side chat Session of the chat, open in a tab or not. */
export interface ThreadSummaryPanelSessionSideChat {
  readonly sessionId: string;
  readonly title: string;
  readonly panelId?: PanelId;
  readonly leafId?: string | null;
}

/**
 * Every side chat of the chat, newest first. An open tab the read has not listed is newer than
 * everything listed once the read is complete, and otherwise belongs to a page not read yet. An
 * open tab supplies the title and placement, since it follows the latest request.
 */
export function buildThreadSummaryPanelSessionSideChatRows(input: {
  readonly open: readonly ThreadSummaryPanelSessionSideChat[];
  readonly listed: readonly ThreadSummaryPanelSessionSideChat[];
  readonly listComplete: boolean;
  readonly isResponding: (sessionId: string) => boolean;
}): ThreadSummaryPanelAuxiliaryRow[] {
  const openById = new Map(input.open.map((sideChat) => [sideChat.sessionId, sideChat]));
  const listedIds = new Set(input.listed.map((sideChat) => sideChat.sessionId));
  const unlisted = input.open.filter((sideChat) => !listedIds.has(sideChat.sessionId));
  const listed = input.listed.map((sideChat) => openById.get(sideChat.sessionId) ?? sideChat);
  return (input.listComplete ? [...unlisted, ...listed] : [...listed, ...unlisted]).map(
    (sideChat) => ({
      id: runtimeSideChatTabId(sideChat.sessionId),
      title: sideChat.title,
      isResponseInProgress: input.isResponding(sideChat.sessionId),
      panelId: sideChat.panelId,
      leafId: sideChat.leafId ?? null,
    }),
  );
}

export function isThreadSummarySideChatResponseInProgress(
  conversation:
    | Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">
    | null
    | undefined,
): boolean {
  if (!conversation) return false;
  if (conversation.statusType === "active") return true;
  if (conversation.statusActiveFlags.length > 0) return true;
  return conversation.turns.some((turn) => turn.status === "inProgress");
}
