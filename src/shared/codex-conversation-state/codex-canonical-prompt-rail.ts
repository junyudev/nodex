import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import {
  listCanonicalHistoryTurns,
  type CanonicalHistoryClient,
} from "./codex-canonical-history-loader";
import {
  buildCodexPromptRailPreviews,
  type CodexPromptRailTurnShell,
  type CodexPromptRailPreview,
} from "../codex-prompt-rail-history";

/** The rail indexes lightweight native Turn locators independently of resident history. */
export async function loadCanonicalPromptRailIndex(
  client: CanonicalHistoryClient,
  conversationId: string,
): Promise<{ items: CodexPromptRailTurnShell[]; complete: boolean }> {
  const items: CodexPromptRailTurnShell[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response: ClientRequestResponsesByMethod["thread/turns/list"] = await client.sendRequest(
      "thread/turns/list",
      {
        threadId: conversationId,
        cursor,
        limit: 100,
        itemsView: "notLoaded",
        sortDirection: "desc",
      },
      { priority: "background", source: "tail_history" },
    );
    items.push(
      ...response.data.map((turn, descendingOffset) => ({
        turnId: turn.id,
        pageBackwardsCursor: response.backwardsCursor ?? null,
        descendingOffset,
      })),
    );
    if (response.nextCursor == null) return { items: items.reverse(), complete: true };
    cursor = response.nextCursor;
  }
  return { items: items.reverse(), complete: false };
}

/** Preview reads do not install history; navigation subsequently hydrates the selected match. */
export async function previewCanonicalPromptRailTurn(
  client: CanonicalHistoryClient,
  conversationId: string,
  item: CodexPromptRailTurnShell,
): Promise<{ turnCursor: string; previews: readonly CodexPromptRailPreview[] } | null> {
  let cursor = item.pageBackwardsCursor;
  const requestOptions = { priority: "interactive", source: "thread_hydration" } as const;
  if (item.descendingOffset > 0) {
    const page = await listCanonicalHistoryTurns(client, conversationId, {
      cursor,
      limit: item.descendingOffset,
      itemsView: "notLoaded",
      sortDirection: "desc",
      requestOptions,
    });
    cursor = page.response.nextCursor;
    if (cursor === null) return null;
  }
  const page = await listCanonicalHistoryTurns(client, conversationId, {
    cursor,
    limit: 1,
    itemsView: "full",
    sortDirection: "desc",
    requestOptions,
  });
  const turn = page.response.data[0];
  const turnCursor = page.response.backwardsCursor ?? cursor;
  if (turn?.id !== item.turnId || turnCursor === null) return null;
  const previews = buildCodexPromptRailPreviews({
    turn,
    pagination: page.itemsPaginationByTurnId[turn.id] ?? {
      olderCursor: null,
      isLoadingOlder: false,
      hasLoadedOldest: turn.itemsView === "full",
    },
  });
  if (previews.length === 0 && (turn.itemsView !== "full" || turn.status === "inProgress"))
    return null;
  return { turnCursor, previews };
}
