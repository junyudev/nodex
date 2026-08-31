import type { CodexThreadSummary, ProjectSessionThreadLink } from "@/lib/types";

export function projectSessionThreadLinkToSummary(
  thread: ProjectSessionThreadLink,
): CodexThreadSummary {
  return {
    threadId: thread.threadId,
    projectId: thread.projectId,
    source: thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : null,
    threadName: thread.threadName ?? null,
    threadPreview: thread.threadPreview,
    executionProfile: thread.executionProfile ?? null,
    cwd: thread.cwd ?? null,
    managedWorktreePath: thread.managedWorktreePath ?? null,
    projectlessOutputDirectory: thread.projectlessOutputDirectory ?? null,
    projectlessWorkspaceBrowserRoot: thread.projectlessWorkspaceBrowserRoot ?? null,
    statusType: thread.statusType,
    statusActiveFlags: [...thread.statusActiveFlags],
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt,
    linkedAt: thread.linkedAt,
  };
}
