import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscribeCodexEvents } from "@/lib/api";
import type { CodexSubagentRow } from "../../../shared/codex-subagent-row-model";
import type { CodexSubagentOverviewRow } from "../../../shared/types";
import { useCodexAppServerManagerForConversationId } from "./local-conversation-store";

const EMPTY_ROWS: readonly CodexSubagentRow[] = [];

function toBackgroundRow(row: CodexSubagentOverviewRow): CodexSubagentRow | null {
  if (row.status === "unknown") return null;
  return {
    conversationId: row.threadId,
    parentConversationId: row.parentThreadId ?? "",
    parentTurnKey: row.parentTurnKey ?? null,
    displayName: row.displayName,
    actorName: row.actorName ?? row.displayName,
    agentRole: row.agentRole,
    spawnModel: row.spawnModel,
    status: row.status,
    statusSummary: row.statusSummary,
    lastAssistantMessage: null,
    lastAssistantMessageAtMs: row.lastAssistantMessageAtMs ?? null,
    recencyAtMs: row.recencyAtMs ?? row.lastActivityAtMs ?? 0,
    showInlineActivity: row.showInlineActivity ?? false,
    objective: row.objective,
    startedAtMs: row.startedAtMs,
    isCurrentParentTurn: row.isCurrentParentTurn,
    diffStats: row.diffStats,
    canInteract: row.canInteract,
    role: "backgroundChild",
  };
}

/** All descendant consumers share the same host-scoped overview. */
export function useBackgroundSubagentRows(
  rootThreadId: string | null,
  preferredHostId?: string | null,
) {
  const manager = useCodexAppServerManagerForConversationId(rootThreadId, preferredHostId);
  const client = useQueryClient();
  const hostId = manager.getHostId();
  const queryKey = ["codex", "background-subagent-rows", hostId, rootThreadId] as const;
  const loadRows = useCallback(async () => {
    if (!rootThreadId) return EMPTY_ROWS;
    const overview = await manager.readSubagentOverview({ rootThreadId, mode: "expanded" });
    return (overview.rows ?? [...overview.active.rows, ...overview.done.rows]).flatMap((row) => {
      const projected = toBackgroundRow(row);
      return projected ? [projected] : [];
    });
  }, [manager, rootThreadId]);
  const query = useQuery({
    queryKey,
    enabled: rootThreadId !== null,
    staleTime: Infinity,
    queryFn: loadRows,
  });
  useEffect(() => {
    if (!rootThreadId) return;
    return subscribeCodexEvents((event) => {
      if (event.type !== "subagentOverviewInvalidated" || event.rootThreadId !== rootThreadId)
        return;
      void client.invalidateQueries({
        queryKey: ["codex", "background-subagent-rows", hostId, rootThreadId],
      });
    });
  }, [client, hostId, rootThreadId]);
  const rows = query.data ?? EMPTY_ROWS;
  return rows;
}
