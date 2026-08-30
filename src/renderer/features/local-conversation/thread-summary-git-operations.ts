import { getGitWorkerClient } from "@/lib/api";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "@/lib/renderer-command";
import type {
  GhPrCreateInput,
  GitCommitInput,
  GitCommitMessageGenerateInput,
  GitPullRequestMessageGenerateInput,
  GitPushInput,
} from "@/lib/types";

const generateCommitMessageCommand = defineRendererCommand({
  key: "thread_summary.git.generate_commit_message",
  channel: "git:action:commit-message:generate",
  authority: "external",
  owner: "ThreadSummaryGitOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "external" },
});

const commitCommand = defineRendererCommand({
  key: "thread_summary.git.commit",
  channel: "git:action:commit",
  authority: "external",
  owner: "ThreadSummaryGitOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "external" },
});

const pushCommand = defineRendererCommand({
  key: "thread_summary.git.push",
  channel: "git:action:push",
  authority: "external",
  owner: "ThreadSummaryGitOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "external" },
});

const generatePullRequestMessageCommand = defineRendererCommand({
  key: "thread_summary.git.generate_pull_request_message",
  channel: "git:action:pull-request-message:generate",
  authority: "external",
  owner: "ThreadSummaryGitOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "external" },
});

const createPullRequestCommand = defineRendererCommand({
  key: "thread_summary.git.create_pull_request",
  channel: "gh-pr-create",
  authority: "external",
  owner: "ThreadSummaryGitOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "external" },
});

/** Owns the Git worker and IPC transport details used by the thread summary workflow. */
export const threadSummaryGitOperations = {
  readStatus: async (cwd: string) =>
    await getGitWorkerClient().request({ method: "action-status", params: { cwd } }),

  checkoutBranch: async (cwd: string, branch: string) =>
    await getGitWorkerClient().request({ method: "checkout-branch", params: { cwd, branch } }),

  createBranch: async (cwd: string, branch: string) =>
    await getGitWorkerClient().request({ method: "create-branch", params: { cwd, branch } }),

  readPullRequestStatus: async (cwd: string) => await invokeRendererQuery("gh-pr-status", { cwd }),

  cancel: async (operationId: string) =>
    await invokeRendererControl("git:action:cancel", { operationId }),

  generateCommitMessage: async (input: GitCommitMessageGenerateInput) =>
    await invokePlainCommand(generateCommitMessageCommand, input),

  commit: async (input: GitCommitInput) => await invokePlainCommand(commitCommand, input),

  push: async (input: GitPushInput) => await invokePlainCommand(pushCommand, input),

  generatePullRequestMessage: async (input: GitPullRequestMessageGenerateInput) =>
    await invokePlainCommand(generatePullRequestMessageCommand, input),

  createPullRequest: async (input: GhPrCreateInput) =>
    await invokePlainCommand(createPullRequestCommand, input),
};
