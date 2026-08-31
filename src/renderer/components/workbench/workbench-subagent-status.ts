import type {
  ThreadOpenSubagentPayload,
  ThreadOpenSubagentStatus,
} from "@/features/local-conversation/thread-stage-types";
import type { CodexSubagentOverviewRow, CodexThreadStatusType } from "@/lib/types";

type SubagentOverviewOpenRow = Pick<
  CodexSubagentOverviewRow,
  | "agentRole"
  | "canInteract"
  | "diffStats"
  | "displayName"
  | "objective"
  | "spawnModel"
  | "status"
  | "statusSummary"
  | "threadId"
>;

export function projectThreadStatusToSubagentOpenStatus(
  statusType: CodexThreadStatusType | null | undefined,
): ThreadOpenSubagentStatus {
  if (statusType === "active") return "active";
  if (statusType === "idle") return "done";
  return "unknown";
}

export function projectSubagentOverviewRowToOpenPayload(
  row: SubagentOverviewOpenRow,
): ThreadOpenSubagentPayload {
  return {
    conversationId: row.threadId,
    displayName: row.displayName,
    agentRole: row.agentRole,
    spawnModel: row.spawnModel,
    status: row.status,
    statusSummary: row.statusSummary ?? row.objective,
    canInteract: row.canInteract,
    showInlineActivity: true,
    diffStats: row.diffStats,
  };
}
