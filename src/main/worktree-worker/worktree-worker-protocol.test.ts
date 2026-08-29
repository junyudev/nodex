import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  isCodexWorktreeWorkerHostMessage,
  isCodexWorktreeWorkerThreadMessage,
} from "./worktree-worker-protocol";

function createRequest() {
  return {
    type: "request",
    protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
    id: "create:1",
    request: {
      operation: "create",
      input: {
        requestId: "pending-1:1",
        hostId: "local",
        repositoryPath: "/repo",
        nodexHome: "/nodex-home",
        managedRoot: "/nodex-home/worktrees",
        projectId: "project-1",
        targetId: "pending-1",
        threadTitle: "Implement feature",
        startingState: {
          type: "branch",
          branchName: "feature",
          remoteRef: "refs/remotes/origin/feature",
        },
        localEnvironmentConfigPath: ".codex/environments/environment.toml",
        setUpSyncedBranch: true,
        propagateLocalWorkspaceFiles: true,
      },
    },
  } as const;
}

describe("worktree worker protocol", () => {
  test("accepts a versioned create request with an exact operation discriminator", () => {
    expect(isCodexWorktreeWorkerHostMessage(createRequest())).toBe(true);
  });

  test("rejects absolute and escaping environment selections", () => {
    for (const localEnvironmentConfigPath of [
      "/repo/.codex/environments/environment.toml",
      ".codex/environments/../outside.toml",
    ]) {
      expect(
        isCodexWorktreeWorkerHostMessage({
          ...createRequest(),
          request: {
            ...createRequest().request,
            input: {
              ...createRequest().request.input,
              localEnvironmentConfigPath,
            },
          },
        }),
      ).toBe(false);
    }
  });

  test("rejects version drift and unknown operations", () => {
    expect(
      isCodexWorktreeWorkerHostMessage({
        ...createRequest(),
        protocolVersion: 1,
      }),
    ).toBe(false);
    expect(
      isCodexWorktreeWorkerHostMessage({
        ...createRequest(),
        request: { operation: "guess-from-shape", input: createRequest().request.input },
      }),
    ).toBe(false);
  });

  test("accepts exact targets from an earlier managed root and rejects stale authority", () => {
    const removeRequest = {
      type: "request",
      protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      id: "remove:1",
      request: {
        operation: "remove",
        input: {
          requestId: "remove:1",
          hostId: "local",
          worktreeGitRoot: "/old-managed-root/abcd/repo",
          reason: "cancel",
          snapshotPolicy: "ephemeral",
        },
      },
    } as const;
    expect(isCodexWorktreeWorkerHostMessage(removeRequest)).toBe(true);
    expect(
      isCodexWorktreeWorkerHostMessage({
        ...removeRequest,
        request: {
          ...removeRequest.request,
          input: {
            ...removeRequest.request.input,
            managedRoot: "/current-managed-root",
          },
        },
      }),
    ).toBe(false);
  });

  test("allows handoff from an old root into the current destination root", () => {
    expect(
      isCodexWorktreeWorkerHostMessage({
        type: "request",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
        id: "prepare-handoff:1",
        request: {
          operation: "prepare-handoff",
          input: {
            requestId: "prepare-handoff:1",
            hostId: "local",
            managedRoot: "/current-managed-root",
            nodexHome: "/nodex-home",
            projectId: "project-1",
            threadId: "thread-1",
            threadTitle: "Move task",
            sourceCwd: "/old-managed-root/abcd/repo/packages/app",
            sourceWorkspaceRoot: "/old-managed-root/abcd/repo",
            sourceManagedWorktreePath: "/old-managed-root/abcd/repo",
            destinationCheckoutRoot: null,
          },
        },
      }),
    ).toBe(true);
  });

  test("requires event and result operations to agree with their payload", () => {
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "ready",
        epoch: 2,
        hostId: "local",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "event",
        id: "create:1",
        operation: "create",
        event: {
          operation: "create",
          type: "path-allocated",
          worktreeGitRoot: "/managed/abcd/repo",
          worktreeWorkspaceRoot: "/managed/abcd/repo/packages/app",
        },
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "event",
        id: "prepare-handoff:1",
        operation: "prepare-handoff",
        event: {
          operation: "prepare-handoff",
          type: "path-allocated",
          worktreeGitRoot: "/managed/abcd/repo",
          worktreeWorkspaceRoot: "/managed/abcd/repo/packages/app",
        },
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "event",
        id: "create:1",
        operation: "remove",
        event: {
          operation: "create",
          type: "path-allocated",
          worktreeGitRoot: "/managed/abcd/repo",
          worktreeWorkspaceRoot: "/managed/abcd/repo/packages/app",
        },
      }),
    ).toBe(false);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "event",
        id: "remove:1",
        operation: "remove",
        event: {
          operation: "remove",
          type: "snapshot-started",
        },
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "result",
        id: "create:1",
        operation: "create",
        result: {
          type: "ok",
          success: {
            operation: "create",
            value: {
              worktreeGitRoot: "/managed/abcd/repo",
              worktreeWorkspaceRoot: "/managed/abcd/repo/packages/app",
              setupError: null,
              shellEnvironment: null,
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "result",
        id: "create:1",
        operation: "remove",
        result: {
          type: "ok",
          success: {
            operation: "create",
            value: {
              worktreeGitRoot: "/managed/abcd/repo",
              worktreeWorkspaceRoot: "/managed/abcd/repo/packages/app",
              setupError: null,
              shellEnvironment: null,
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("accepts filesystem birth timestamps with sub-millisecond precision", () => {
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "result",
        id: "list:1",
        operation: "list",
        result: {
          type: "ok",
          success: {
            operation: "list",
            value: {
              entries: [
                {
                  worktreeGitRoot: "/managed/abcd/repo",
                  repositoryPath: "/repo",
                  createdAtMs: 1_786_664_741_550.375,
                  ownerThreadId: "thread-1",
                  ownerReadFailed: false,
                },
              ],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isCodexWorktreeWorkerThreadMessage({
        type: "result",
        id: "list:2",
        operation: "list",
        result: {
          type: "ok",
          success: {
            operation: "list",
            value: {
              entries: [
                {
                  worktreeGitRoot: "/managed/abcd/repo",
                  repositoryPath: "/repo",
                  createdAtMs: Number.NaN,
                  ownerThreadId: null,
                  ownerReadFailed: false,
                },
              ],
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("validates cross-host rollout placement and cleanup containment", () => {
    const importRequest = {
      type: "request",
      protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      id: "import:1",
      request: {
        operation: "import-handoff",
        input: {
          requestId: "import:1",
          hostId: "ssh:destination",
          transferId: "transfer-1",
          bundlePath: "/remote/.codex/nodex-handoffs/transfer-1/source.bundle",
          rolloutPath: "/remote/.codex/nodex-handoffs/transfer-1/rollout.jsonl",
          rolloutRelativePath: "sessions/2026/08/14/thread.jsonl",
          destinationCodexHome: "/remote/.codex",
          sourceCommit: "abcdef",
          repositoryIdentity: {
            displayName: "repo",
            keys: ["a".repeat(64)],
          },
          candidateRepositoryPaths: ["/remote/src/repo"],
          managedRoot: "/remote/.nodex/worktrees",
          nodexHome: "/remote/.nodex",
          projectId: "project",
          threadId: "thread",
          threadTitle: "Task",
        },
      },
    } as const;
    expect(isCodexWorktreeWorkerHostMessage(importRequest)).toBe(true);
    expect(
      isCodexWorktreeWorkerHostMessage({
        ...importRequest,
        request: {
          ...importRequest.request,
          input: {
            ...importRequest.request.input,
            rolloutRelativePath: "../../outside.jsonl",
          },
        },
      }),
    ).toBe(false);

    expect(
      isCodexWorktreeWorkerHostMessage({
        type: "request",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
        id: "cleanup:1",
        request: {
          operation: "cleanup-transfer-handoff",
          input: {
            requestId: "cleanup:1",
            hostId: "ssh:destination",
            transferId: "transfer-1",
            stagingRoot: "/remote/.codex/nodex-handoffs",
            repositoryPath: "/remote/src/repo",
            temporaryRef: "refs/codex/handoff/destination/transfer-1",
            managedRoot: "/remote/.nodex/worktrees",
            createdWorktreePath: "/remote/.nodex/worktrees/abcd/repo",
            createdRolloutPath: "/remote/.codex/sessions/2026/08/14/thread.jsonl",
            destinationCodexHome: "/remote/.codex",
            outcome: "rolled-back",
          },
        },
      }),
    ).toBe(true);
  });
});
