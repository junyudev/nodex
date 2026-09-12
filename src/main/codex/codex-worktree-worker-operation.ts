import { stat } from "node:fs/promises";
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
import { isCodexNonGitRepositoryMessage, runCodexGitCommand } from "./codex-git-command";
import type {
  CodexWorktreeWorkerCreateInput,
  CodexWorktreeWorkerCreateResult,
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerRequest,
  CodexWorktreeWorkerOperationOptions,
  CodexWorktreeWorkerSuccess,
} from "./codex-worktree-worker-protocol";

const GIT_ROOT_TIMEOUT_MS = 60_000;
const SAFE_FSMONITOR_CACHE_MS = 1_000;
const safeFsmonitorCache = new Map<
  string,
  { readonly expiresAtMs: number; readonly value: "" | "true" }
>();

function shouldResolveSafeFsmonitor(hostId: string): boolean {
  if (hostId !== "local") return process.platform === "linux";
  return process.platform === "darwin" || process.platform === "win32";
}

function gitRootEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function readSafeFsmonitorOverride(
  input: Extract<CodexWorktreeWorkerRequest, { readonly operation: "git-root" }>["input"],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<"" | "true"> {
  if (!shouldResolveSafeFsmonitor(input.hostId)) return "";
  const cacheKey = JSON.stringify([
    input.hostId,
    input.cwd,
    Object.entries(env)
      .filter(([key]) => key !== "GIT_INDEX_FILE")
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
  const now = performance.now();
  const cached = safeFsmonitorCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.value;
  if (cached) safeFsmonitorCache.delete(cacheKey);

  const expiresAtMs = now + SAFE_FSMONITOR_CACHE_MS;
  let value: "" | "true" = "";
  try {
    const runProbe = (args: readonly string[], allowedExitCodes?: readonly number[]) =>
      runCodexGitCommand(["-c", "safe.bareRepository=explicit", ...args], input.cwd, {
        allowedExitCodes,
        env,
        signal,
        timeoutMs: GIT_ROOT_TIMEOUT_MS,
      });
    const config = await runProbe(["config", "--null", "--get", "core.fsmonitor"], [0, 1]);
    if (config.stdout.endsWith("\0")) {
      const configuredValue = config.stdout.slice(0, -1);
      if (configuredValue && !configuredValue.includes("\0")) {
        const normalized = configuredValue.toLowerCase();
        let enabled = ["true", "yes", "on"].includes(normalized);
        if (!["true", "yes", "on", "false", "no", "off"].includes(normalized)) {
          const parsed = await runProbe(
            [
              "config",
              "--null",
              "--type=bool",
              "--fixed-value",
              "--get",
              "core.fsmonitor",
              configuredValue,
            ],
            [0, 1],
          );
          enabled = parsed.stdout === "true\0";
        }
        if (enabled) {
          const buildOptions = await runProbe(["version", "--build-options"]);
          value = buildOptions.stdout
            .split(/\r?\n/)
            .some((line) => line.trim() === "feature: fsmonitor--daemon")
            ? "true"
            : "";
        }
      }
    }
  } catch {
    value = "";
  }

  if (!signal.aborted && performance.now() < expiresAtMs) {
    safeFsmonitorCache.set(cacheKey, { expiresAtMs, value });
    const cleanup = setTimeout(
      () => {
        if (safeFsmonitorCache.get(cacheKey)?.expiresAtMs === expiresAtMs) {
          safeFsmonitorCache.delete(cacheKey);
        }
      },
      Math.max(0, expiresAtMs - performance.now()),
    );
    cleanup.unref();
  }
  return value;
}

async function resolveGitRoot(
  input: Extract<CodexWorktreeWorkerRequest, { readonly operation: "git-root" }>["input"],
  signal: AbortSignal,
): Promise<{ readonly root: string | null }> {
  const cwd = input.cwd.trim();
  if (!cwd) return { root: null };
  if (input.hostId === "local") {
    try {
      await stat(cwd);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { root: null };
      throw cause;
    }
  }
  try {
    const env = gitRootEnvironment();
    const fsmonitorOverride = await readSafeFsmonitorOverride(input, signal, env);
    const result = await runCodexGitCommand(
      [
        "-c",
        "safe.bareRepository=explicit",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        `core.fsmonitor=${fsmonitorOverride}`,
        "rev-parse",
        "--show-toplevel",
      ],
      cwd,
      {
        allowedExitCodes: [0, 128],
        env,
        signal,
        timeoutMs: GIT_ROOT_TIMEOUT_MS,
      },
    );
    const root = result.stdout.trim();
    if (root) return { root };
    if (isCodexNonGitRepositoryMessage(result.stderr)) return { root: null };
    throw new Error(`Failed to resolve git root: ${result.stderr.trim() || "Unknown error"}`);
  } catch (cause) {
    if (signal.aborted) throw cause;
    if (isCodexNonGitRepositoryMessage(cause instanceof Error ? cause.message : String(cause))) {
      return { root: null };
    }
    throw cause;
  }
}

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
    case "git-root":
      return {
        operation: "git-root",
        value: await resolveGitRoot(request.input, options.signal),
      };
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
