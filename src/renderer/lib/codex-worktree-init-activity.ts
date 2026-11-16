import { getIntl } from "@/lib/i18n";
export type CodexWorktreeInitActivityKind = "worktree" | "setup" | "conversation";

export type CodexWorktreeInitActivityStatus = "running" | "completed" | "skipped" | "failed";

export interface CodexWorktreeInitActivity {
  id: string;
  kind: CodexWorktreeInitActivityKind;
  status: CodexWorktreeInitActivityStatus;
  outputText: string;
}

export function codexWorktreeInitActivityLabel(activity: CodexWorktreeInitActivity): string {
  if (activity.kind === "worktree") {
    if (activity.status === "running") return "Creating a worktree";
    if (activity.status === "failed")
      return getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.worktreeFailed",
        defaultMessage: "Failed to create worktree",
      });
    return getIntl().formatMessage({
      id: "lib.codexWorktreeInitActivity.worktreeCreated",
      defaultMessage: "Worktree created",
    });
  }

  if (activity.kind === "setup") {
    if (activity.status === "running")
      return getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.setupRunning",
        defaultMessage: "Setting up the environment",
      });
    if (activity.status === "completed")
      return getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.setupDone",
        defaultMessage: "Environment set up",
      });
    if (activity.status === "skipped")
      return getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.setupSkipped",
        defaultMessage: "Environment setup skipped",
      });
    return getIntl().formatMessage({
      id: "lib.codexWorktreeInitActivity.setupFailed",
      defaultMessage: "Failed to set up the environment",
    });
  }

  return activity.status === "failed"
    ? getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.startFailed",
        defaultMessage: "Failed to start the conversation",
      })
    : getIntl().formatMessage({
        id: "lib.codexWorktreeInitActivity.starting",
        defaultMessage: "Starting the conversation",
      });
}
