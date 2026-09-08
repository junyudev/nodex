import type { CodexAppHandoffOperation } from "../../shared/codex-thread-handoff";

export function buildThreadHandoffOperation(
  overrides: Partial<CodexAppHandoffOperation> = {},
): CodexAppHandoffOperation {
  return {
    operationId: "operation-1",
    revision: 1,
    status: "running",
    threadId: "thread-target",
    sourceThreadId: "thread-target",
    requestThreadId: "thread-1",
    projectId: "project-1",
    sourceHostId: "local",
    threadTitle: "Release notes",
    direction: "local-to-worktree",
    localBranch: "main",
    sourceBranch: "main",
    worktreeBranch: "codex/release",
    destinationHostId: "local",
    destinationHostDisplayName: "Local",
    message: null,
    steps: [
      {
        id: "checkout-worktree-branch",
        label: "Checking out codex/release in worktree",
        status: "running",
        message: null,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides,
  };
}
