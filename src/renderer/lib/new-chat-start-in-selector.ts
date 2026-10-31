import type { PageRunInTarget } from "./types";
import type { CodexPendingWorktreeStartingState } from "../../shared/codex-pending-worktree";

export interface NewChatStartInTarget {
  runInTarget: Exclude<PageRunInTarget, "cloud">;
  runInEnvironmentPath?: string | null;
  worktreeStartingState?: CodexPendingWorktreeStartingState;
}
