import {
  createManagedWorktree,
  removeManagedWorktree,
  resolveManagedWorktreeDefaultStartingState,
  setManagedWorktreeOwnerThread,
} from "./git-worktree-service";
import { readWorktreeEnvironmentDefinition } from "./worktree-environment-service";
import { runCodexWorktreeSetupScript } from "./codex-worktree-shell-environment";
import {
  inspectManagedWorktree,
  listManagedWorktreesOnHost,
  removeRetainedManagedWorktree,
  restoreManagedWorktree,
  snapshotManagedWorktree,
} from "./codex-managed-worktree-effects";
import {
  cleanupLocalThreadHandoff,
  prepareLocalThreadHandoff,
  rollbackLocalThreadHandoff,
} from "./codex-local-thread-handoff-git";
import {
  cleanupCrossHostThreadHandoff,
  exportCrossHostThreadHandoff,
  importCrossHostThreadHandoff,
} from "./codex-cross-host-thread-handoff-git";
import type {
  CodexWorktreeWorkerCreateInput,
  CodexWorktreeWorkerCreateResult,
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerRequest,
  CodexWorktreeWorkerOperationOptions,
  CodexWorktreeWorkerSuccess,
} from "./codex-worktree-worker-protocol";

function canceled(signal: AbortSignal): never {
  void signal;
  throw new Error("Request canceled");
}

function isCanceled(signal: AbortSignal, error: unknown): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.message.includes("canceled")))
  );
}

export async function executeCodexWorktreeWorkerCreate(
  input: CodexWorktreeWorkerCreateInput,
  options: {
    readonly signal: AbortSignal;
    readonly onEvent: (event: CodexWorktreeWorkerEvent) => void;
    readonly loadBaseEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  },
): Promise<CodexWorktreeWorkerCreateResult> {
  const { signal } = options;
  if (signal.aborted) return canceled(signal);
  const startingState =
    input.startingState ??
    (await resolveManagedWorktreeDefaultStartingState(input.repositoryPath, signal));
  const created = await createManagedWorktree({
    repositoryPath: input.repositoryPath,
    nodexHome: input.nodexHome,
    managedRoot: input.managedRoot,
    projectId: input.projectId,
    targetId: input.targetId,
    threadTitle: input.threadTitle,
    branchPrefix: input.branchPrefix ?? null,
    preferredBaseBranch: null,
    mode: input.mode ?? "detachedHead",
    startingState,
    localEnvironmentConfigPath: input.localEnvironmentConfigPath,
    setUpSyncedBranch: input.setUpSyncedBranch,
    propagateLocalWorkspaceFiles: input.propagateLocalWorkspaceFiles,
    signal,
    onPathAllocated: (paths) => {
      options.onEvent({
        operation: "create",
        type: "path-allocated",
        worktreeGitRoot: paths.worktreeGitRoot,
        worktreeWorkspaceRoot: paths.worktreeWorkspaceRoot,
      });
    },
    onLog: (output) => {
      if (!output.data) return;
      options.onEvent({
        operation: "create",
        type: "output",
        phase: "worktree",
        stream: output.stream,
        data: output.data,
      });
    },
  });
  const paths = {
    worktreeGitRoot: created.worktreeGitRoot,
    worktreeWorkspaceRoot: created.worktreeWorkspaceRoot,
  };
  if (signal.aborted) {
    await removeManagedWorktree(created.worktreeGitRoot).catch(() => undefined);
    return canceled(signal);
  }
  if (input.localEnvironmentConfigPath === null) {
    return {
      ...paths,
      setupError: null,
      shellEnvironment: null,
    };
  }

  options.onEvent({ operation: "create", type: "setup-started" });
  try {
    const environment = await readWorktreeEnvironmentDefinition({
      workspacePath: input.repositoryPath,
      environmentPath: input.localEnvironmentConfigPath,
    });
    signal.throwIfAborted();
    const shellEnvironment =
      environment.setupScript === null
        ? null
        : await runCodexWorktreeSetupScript({
            script: environment.setupScript,
            cwd: created.worktreeGitRoot,
            loadBaseEnvironment: options.loadBaseEnvironment,
            signal,
            environment: {
              CODEX_SOURCE_TREE_PATH: input.repositoryPath,
              CODEX_WORKTREE_PATH: created.worktreeWorkspaceRoot,
            },
            onOutput: (output) => {
              if (!output.data) return;
              options.onEvent({
                operation: "create",
                type: "output",
                phase: "setup",
                stream: output.stream,
                data: output.data,
              });
            },
          });
    signal.throwIfAborted();
    return {
      ...paths,
      setupError: null,
      shellEnvironment,
    };
  } catch (error) {
    if (isCanceled(signal, error)) {
      await removeManagedWorktree(created.worktreeGitRoot).catch(() => undefined);
      return canceled(signal);
    }
    return {
      ...paths,
      setupError: error instanceof Error ? error.message : String(error),
      shellEnvironment: null,
    };
  }
}

export async function executeCodexWorktreeWorkerOperation(
  request: CodexWorktreeWorkerRequest,
  options: Omit<CodexWorktreeWorkerOperationOptions, "signal"> & {
    readonly signal: AbortSignal;
    readonly loadBaseEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  },
): Promise<CodexWorktreeWorkerSuccess> {
  switch (request.operation) {
    case "create":
      return {
        operation: "create",
        value: await executeCodexWorktreeWorkerCreate(request.input, options),
      };
    case "remove": {
      return {
        operation: "remove",
        value: await removeRetainedManagedWorktree(request.input, options),
      };
    }
    case "set-owner":
      await setManagedWorktreeOwnerThread(
        request.input.worktreeGitRoot,
        request.input.ownerThreadId,
        options.signal,
      );
      return {
        operation: "set-owner",
        value: { ownerThreadId: request.input.ownerThreadId },
      };
    case "list":
      return {
        operation: "list",
        value: await listManagedWorktreesOnHost(request.input, options.signal),
      };
    case "inspect":
      return {
        operation: "inspect",
        value: await inspectManagedWorktree(request.input, options.signal),
      };
    case "snapshot":
      return {
        operation: "snapshot",
        value: await snapshotManagedWorktree(request.input, options),
      };
    case "restore":
      return {
        operation: "restore",
        value: await restoreManagedWorktree(request.input, options),
      };
    case "prepare-handoff":
      return {
        operation: "prepare-handoff",
        value: await prepareLocalThreadHandoff(request.input, {
          signal: options.signal,
          onPathAllocated: (paths) => {
            options.onEvent({
              operation: "prepare-handoff",
              type: "path-allocated",
              ...paths,
            });
          },
          onProgress: (step, status, branchContext) => {
            options.onEvent({
              operation: "prepare-handoff",
              type: "handoff-progress",
              step,
              status,
              branchContext,
            });
          },
        }),
      };
    case "rollback-handoff":
      return {
        operation: "rollback-handoff",
        value: await rollbackLocalThreadHandoff(request.input, {
          signal: options.signal,
          onProgress: (step, status) => {
            options.onEvent({
              operation: "rollback-handoff",
              type: "handoff-progress",
              step,
              status,
            });
          },
        }),
      };
    case "cleanup-handoff":
      return {
        operation: "cleanup-handoff",
        value: await cleanupLocalThreadHandoff(),
      };
    case "export-handoff":
      return {
        operation: "export-handoff",
        value: await exportCrossHostThreadHandoff(request.input, options),
      };
    case "import-handoff":
      return {
        operation: "import-handoff",
        value: await importCrossHostThreadHandoff(request.input, options),
      };
    case "cleanup-transfer-handoff":
      return {
        operation: "cleanup-transfer-handoff",
        value: await cleanupCrossHostThreadHandoff(request.input, options.signal),
      };
  }
}
