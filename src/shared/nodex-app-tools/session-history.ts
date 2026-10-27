import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type {
  History,
  HistoryContent,
  HistoryItem,
  HistoryProgress,
} from "@nodex/agent-runtime/history-contracts";

export { HISTORY_CURSOR_MAX_CHARS as SESSION_HISTORY_CURSOR_MAX_CHARS } from "@nodex/agent-runtime/history-contracts";
export type {
  HistoryView as SessionHistoryView,
  HistoryOrder as SessionHistoryOrder,
} from "@nodex/agent-runtime/history-contracts";
export type SessionHistoryData =
  | { readonly source: "runtime"; readonly item: AgentTurnItem }
  | { readonly source: "codex"; readonly item: ThreadItem };

/** Session and Task reads share identity, continuation, version and budget semantics. */
export type SessionHistoryContent = HistoryContent<SessionHistoryData>;
export type SessionHistoryItem = HistoryItem<SessionHistoryData>;
export type SessionHistory = History<SessionHistoryData>;
export type SessionProgress = HistoryProgress<SessionHistoryData>;
