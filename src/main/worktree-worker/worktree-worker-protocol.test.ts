import { describe, expect, test } from "vite-plus/test";
import { createSessionSchema } from "../../shared/nodex-app-tools/session-launch-schema";
import { AgentRuntimeLaunchSchema } from "../../shared/schemas/agent-runtime-api";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  decodeCodexWorktreeWorkerHostMessage,
  decodeCodexWorktreeWorkerThreadMessage,
} from "./worktree-worker-protocol";

const acceptsHostMessage = (message: unknown) => decodeCodexWorktreeWorkerHostMessage(message).ok;
const acceptsThreadMessage = (message: unknown) =>
  decodeCodexWorktreeWorkerThreadMessage(message).ok;

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
  test("accepts git-root paths from POSIX and Windows execution hosts", () => {
    const request = {
      type: "request",
      protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      id: "git-root:1",
      request: {
        operation: "git-root",
        input: {
          requestId: "git-root:1",
          hostId: "ssh:builder",
          cwd: "/remote/workspace",
        },
      },
    } as const;
    expect(acceptsHostMessage(request)).toBe(true);
    expect(
      acceptsHostMessage({
        ...request,
        request: {
          ...request.request,
          input: { ...request.request.input, cwd: String.raw`C:\remote\workspace` },
        },
      }),
    ).toBe(true);
    expect(
      acceptsHostMessage({
        ...request,
        request: { ...request.request, input: { ...request.request.input, cwd: "relative/path" } },
      }),
    ).toBe(false);

    for (const root of [
      "/remote/workspace",
      String.raw`C:\remote\workspace`,
      String.raw`\\builder\workspace`,
      null,
    ] as const) {
      expect(
        acceptsThreadMessage({
          type: "result",
          id: "git-root:1",
          operation: "git-root",
          result: {
            type: "ok",
            success: { operation: "git-root", value: { root } },
          },
        }),
      ).toBe(true);
    }
    expect(
      acceptsThreadMessage({
        type: "result",
        id: "git-root:1",
        operation: "git-root",
        result: {
          type: "ok",
          success: { operation: "git-root", value: { root: "relative/path" } },
        },
      }),
    ).toBe(false);
  });

  test("accepts a versioned create request with an exact operation discriminator", () => {
    expect(acceptsHostMessage(createRequest())).toBe(true);
  });

  test("decodes create_session and launch API starting states without rewriting them", () => {
    const agentStates = [
      { type: "working-tree" },
      { type: "branch", branchName: "feature" },
      { type: "branch", branchName: "feature", onMissing: "error" },
      { type: "branch", branchName: "feature", onMissing: "create-branch" },
    ];
    const remoteState = {
      type: "branch",
      branchName: "feature",
      remoteRef: "refs/remotes/origin/feature",
    };
    const spacedBranch = { type: "branch", branchName: " feature " };
    const parseAgent = (startingState: unknown) =>
      createSessionSchema.safeParse({
        prompt: "Start a worktree",
        target: {
          type: "project",
          projectId: "project-1",
          environment: { type: "worktree", startingState },
        },
      });
    const parseLaunch = (worktreeStartingState: unknown) =>
      AgentRuntimeLaunchSchema.safeParse({
        launchId: "launch-1",
        acceptedAt: 0,
        sessionId: "session-1",
        projectId: "project-1",
        title: "Start a worktree",
        modelSelection: { instanceId: "instance-1", model: "model-1" },
        interactionMode: "default",
        runInTarget: "newWorktree",
        message: { messageId: "message-1", text: "Start a worktree" },
        worktreeStartingState,
      });
    const expectCreateRoundTrip = (startingState: unknown) => {
      const message = createRequest();
      const withState = {
        ...message,
        request: {
          ...message.request,
          input: { ...message.request.input, startingState },
        },
      };
      expect(decodeCodexWorktreeWorkerHostMessage(withState)).toEqual({
        ok: true,
        value: withState,
      });
    };

    for (const startingState of agentStates) {
      const session = parseAgent(startingState);
      if (!session.success) throw session.error;
      const { target } = session.data;
      if (target.type !== "project" || target.environment.type !== "worktree") {
        throw new Error("Expected a Project worktree target");
      }
      expect(target.environment.startingState).toEqual(startingState);
      expectCreateRoundTrip(target.environment.startingState);
    }
    for (const startingState of [...agentStates, remoteState]) {
      const launch = parseLaunch(startingState);
      if (!launch.success) throw launch.error;
      expect(launch.data.worktreeStartingState).toEqual(startingState);
      expectCreateRoundTrip(launch.data.worktreeStartingState);
    }
    expect(parseAgent(remoteState).success).toBe(false);
    expect(parseAgent(spacedBranch).success).toBe(false);
    expect(parseLaunch(spacedBranch).success).toBe(false);
  });

  test("preserves empty and untrimmed title hints up to 4096 characters", () => {
    const message = createRequest();
    const withTitle = (threadTitle: string) => ({
      ...message,
      request: { ...message.request, input: { ...message.request.input, threadTitle } },
    });
    for (const threadTitle of ["", "  Implement feature  ", "x".repeat(4_096)]) {
      expect(decodeCodexWorktreeWorkerHostMessage(withTitle(threadTitle))).toEqual({
        ok: true,
        value: withTitle(threadTitle),
      });
    }
    expect(decodeCodexWorktreeWorkerHostMessage(withTitle("x".repeat(4_097)))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^request\.input\.threadTitle:/u),
    });
  });

  test("reports the path of an unknown key in a strict request body", () => {
    const message = createRequest();
    const decoded = decodeCodexWorktreeWorkerHostMessage({
      ...message,
      request: {
        ...message.request,
        input: {
          ...message.request.input,
          startingState: { ...message.request.input.startingState, missingBranch: "error" },
        },
      },
    });
    expect(decoded).toMatchObject({
      ok: false,
      error: "request.input.startingState.missingBranch: Unrecognized key",
    });
  });

  test("requires an absolute claimed checkout path in a Page Workspace create request", () => {
    const message = createRequest();
    const pageWorkspace = {
      workspaceId: "workspace",
      operationId: "claim",
      branchName: "nodex-12",
      baseCommitOid: "a".repeat(40),
    };
    for (const [worktreePath, valid] of [
      ["/nodex-home/worktrees/abcdef012345/repo", true],
      ["worktrees/abcdef012345/repo", false],
      [undefined, false],
    ] as const) {
      expect(
        acceptsHostMessage({
          ...message,
          request: {
            ...message.request,
            input: { ...message.request.input, pageWorkspace: { ...pageWorkspace, worktreePath } },
          },
        }),
      ).toBe(valid);
    }
  });

  test("rejects absolute and escaping environment selections", () => {
    for (const localEnvironmentConfigPath of [
      "/repo/.codex/environments/environment.toml",
      ".codex/environments/../outside.toml",
    ]) {
      expect(
        acceptsHostMessage({
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
    const protocolVersion = CODEX_WORKTREE_WORKER_PROTOCOL_VERSION - 1;
    const mismatch = {
      ok: false,
      error: `protocolVersion: Worktree worker protocol version mismatch (expected ${CODEX_WORKTREE_WORKER_PROTOCOL_VERSION}, received ${protocolVersion})`,
    };
    expect(decodeCodexWorktreeWorkerHostMessage({ ...createRequest(), protocolVersion })).toEqual(
      mismatch,
    );
    expect(
      decodeCodexWorktreeWorkerThreadMessage({
        type: "ready",
        epoch: 1,
        hostId: "local",
        protocolVersion,
      }),
    ).toEqual(mismatch);
    expect(
      acceptsHostMessage({
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
    expect(acceptsHostMessage(removeRequest)).toBe(true);
    expect(
      acceptsHostMessage({
        ...removeRequest,
        request: {
          ...removeRequest.request,
          input: {
            ...removeRequest.request.input,
            managedRoot: "/current-managed-root",
            allocatedWorktreePath: null,
          },
        },
      }),
    ).toBe(false);
  });

  test("allows handoff from an old root into the current destination root", () => {
    expect(
      acceptsHostMessage({
        type: "request",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
        id: "prepare-handoff:1",
        request: {
          operation: "prepare-handoff",
          input: {
            requestId: "prepare-handoff:1",
            hostId: "local",
            managedRoot: "/current-managed-root",
            allocatedWorktreePath: null,
            nodexHome: "/nodex-home",
            projectId: "project-1",
            threadId: "thread-1",
            threadTitle: "",
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
      acceptsThreadMessage({
        type: "ready",
        epoch: 2,
        hostId: "local",
        protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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

  test("retains every create result field consumed by Main", () => {
    const message = {
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
            branchName: "feature",
            setupError: null,
            shellEnvironment: { version: 1, set: { PATH: "/bin" }, exclude: ["TMPDIR"] },
          },
        },
      },
    };
    expect(decodeCodexWorktreeWorkerThreadMessage(message)).toEqual({ ok: true, value: message });
  });

  test("accepts filesystem birth timestamps with sub-millisecond precision", () => {
    expect(
      acceptsThreadMessage({
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
      acceptsThreadMessage({
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
          allocatedWorktreePath: "/remote/.nodex/worktrees/deadbeef1234/repo",
          nodexHome: "/remote/.nodex",
          projectId: "project",
          threadId: "thread",
          threadTitle: "  Task  ",
        },
      },
    } as const;
    const { hostId, repositoryIdentity, candidateRepositoryPaths } = importRequest.request.input;
    const resolutionRequest = {
      ...importRequest,
      request: {
        operation: "resolve-handoff-repository",
        input: { requestId: "resolve:1", hostId, repositoryIdentity, candidateRepositoryPaths },
      },
    };
    expect(acceptsHostMessage(resolutionRequest)).toBe(true);
    expect(
      acceptsHostMessage({
        ...resolutionRequest,
        request: {
          ...resolutionRequest.request,
          input: { ...resolutionRequest.request.input, candidateRepositoryPaths: [] },
        },
      }),
    ).toBe(false);
    expect(acceptsHostMessage(importRequest)).toBe(true);
    expect(
      acceptsHostMessage({
        ...importRequest,
        request: {
          ...importRequest.request,
          input: { ...importRequest.request.input, allocatedWorktreePath: "/outside/task" },
        },
      }),
    ).toBe(false);
    expect(
      acceptsHostMessage({
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
      acceptsHostMessage({
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

test("validates handoff branch context before forwarding worker progress", () => {
  const message = {
    type: "event",
    id: "handoff:1",
    operation: "prepare-handoff",
    event: {
      operation: "prepare-handoff",
      type: "handoff-progress",
      step: "checkout-local-branch",
      status: "started",
      branchContext: {
        sourceBranch: "feature/task",
        localBranch: "main",
        worktreeBranch: "feature/task",
      },
    },
  };
  expect(acceptsThreadMessage(message)).toBe(true);
  expect(
    acceptsThreadMessage({
      ...message,
      event: {
        ...message.event,
        branchContext: { ...message.event.branchContext, localBranch: 123 },
      },
    }),
  ).toBe(false);
  expect(
    acceptsThreadMessage({
      ...message,
      event: { ...message.event, branchContext: { sourceBranch: "main" } },
    }),
  ).toBe(false);
});

test("accepts restoration proof only for a typed handoff preparation failure", () => {
  const message = {
    type: "result",
    id: "handoff:proof",
    operation: "prepare-handoff",
    result: {
      type: "error",
      code: "operation-failed",
      message: "Destination dirty",
      retryable: true,
      preparationRestored: true,
    },
  };
  expect(acceptsThreadMessage(message)).toBe(true);
  expect(acceptsThreadMessage({ ...message, operation: "create" })).toBe(false);
  expect(
    acceptsThreadMessage({
      ...message,
      result: { ...message.result, preparationRestored: "yes" },
    }),
  ).toBe(false);
});

test("accepts a native release outcome independently of cancellation", () => {
  const message = {
    type: "result",
    id: "create:release",
    operation: "create",
    result: {
      type: "error",
      code: "release-unconfirmed",
      message: "Git process handles remain unconfirmed",
      retryable: true,
    },
  };
  expect(acceptsThreadMessage(message)).toBe(true);
  expect(
    acceptsThreadMessage({
      ...message,
      result: { ...message.result, code: "unknown-release-state" },
    }),
  ).toBe(false);
});
