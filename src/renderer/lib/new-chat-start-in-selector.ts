import type { PageRunInTarget } from "./types";
import type { CodexPendingWorktreeStartingState } from "../../shared/codex-pending-worktree";

export interface NewChatStartInTarget {
  runInTarget: PageRunInTarget;
  runInEnvironmentPath?: string | null;
  worktreeStartingState?: CodexPendingWorktreeStartingState;
}
