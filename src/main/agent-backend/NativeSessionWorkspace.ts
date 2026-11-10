import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { PageRunInTarget } from "../../shared/types";
import type { CodexPendingWorktreeStartingState } from "../../shared/codex-pending-worktree";
import { MainConfig } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { SessionFolders } from "./SessionFolders";
import {
  loadCodexWorktreeShellEnvironmentAtGitPath,
  persistCodexWorktreeShellEnvironmentAtGitPath,
  type CodexStoredShellEnvironment,
} from "../codex/codex-worktree-shell-environment";
import { managedWorktreeGitRootContaining } from "../codex/codex-managed-worktree-effects";
import { readManagedWorktreeOwnerThread } from "../codex/git-worktree-service";

export interface NativeSessionWorkspaceInput {
  readonly projectId: string | null;
  readonly targetId: string;
  readonly title: string;
  readonly prompt: string;
  readonly sourceCwd: string | null;
  readonly sourceRoots?: readonly string[];
  readonly runInTarget?: Exclude<PageRunInTarget, "cloud">;
  readonly worktreeStartingState?: CodexPendingWorktreeStartingState | null;
  readonly localEnvironmentConfigPath?: string | null;
  readonly operationId: string;
  readonly pageWorkspacePath?: string;
  readonly reusePageWorkspace?: { readonly worktreeGitRoot: string; readonly branchName: string };
  readonly pageWorkspace?: import("../codex/codex-worktree-worker-protocol").CodexWorktreeWorkerCreateInput["pageWorkspace"];
}

export interface NativeSessionWorkspaceLocation {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly managedWorktreePath: string | null;
  readonly projectlessOutputDirectory: string | null;
  readonly projectlessWorkspaceBrowserRoot: string | null;
}

export interface NativeSessionWorkspaceLease {
  readonly location: NativeSessionWorkspaceLocation;
  readonly branchName?: string | null;
  /** Prevent cleanup when a Core admission may have committed but cannot yet be verified. */
  readonly retain: Effect.Effect<void>;
  /** Call immediately after the durable Thread link is admitted. */
  readonly attach: (threadId: string) => Effect.Effect<void>;
}

export interface NativeSessionWorkspaceReconcileInput {
  readonly cwd: string;
  readonly sharedWorkspace?: boolean;
  readonly threadId: string;
}

export class NativeSessionWorkspaceError extends Schema.TaggedError<NativeSessionWorkspaceError>()(
  "NativeSessionWorkspaceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class NativeSessionWorkspace extends Context.Service<
  NativeSessionWorkspace,
  {
    readonly prepare: (
      input: NativeSessionWorkspaceInput,
    ) => Effect.Effect<NativeSessionWorkspaceLease, NativeSessionWorkspaceError, Scope.Scope>;
    readonly reconcile: (
      input: NativeSessionWorkspaceReconcileInput,
    ) => Effect.Effect<void, NativeSessionWorkspaceError>;
    /** What a managed worktree's Environment setup changed for processes working in it. */
    readonly environment: (
      cwd: string,
    ) => Effect.Effect<CodexStoredShellEnvironment | null, NativeSessionWorkspaceError>;
  }
>()("nodex/main/agent-backend/NativeSessionWorkspace") {}

/** Filesystem/Git ownership is shared with all native backends; no Agent process is launched. */
export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const folders = yield* SessionFolders;
  const hosts = yield* ExecutionHostRuntime;
  const worktrees = yield* ManagedWorktreeRuntime;
  const git = yield* CodexGitProbe;
  return NativeSessionWorkspace.of({
    environment: Effect.fn("NativeSessionWorkspace.environment")(function* (cwd: string) {
      const gitPath = yield* git.readPath(cwd, [
        "rev-parse",
        "--git-path",
        "codex-shell-environment.json",
      ]);
      if (!gitPath) return null;
      return yield* Effect.tryPromise({
        try: () => loadCodexWorktreeShellEnvironmentAtGitPath({ cwd, gitPath }),
        catch: (cause) =>
          new NativeSessionWorkspaceError({ operation: "workspace.environment", cause }),
      });
    }),
    reconcile: Effect.fn("NativeSessionWorkspace.reconcile")(function* (
      input: NativeSessionWorkspaceReconcileInput,
    ) {
      const root = yield* git.readPath(input.cwd, ["rev-parse", "--show-toplevel"]);
      if (!root) return;
      const error = (cause: unknown) =>
        new NativeSessionWorkspaceError({ operation: "workspace.reconcile", cause });
      const host = yield* hosts.resolve("local", "set-owner").pipe(Effect.mapError(error));
      const roots = yield* Effect.tryPromise(async () => ({
        managed: await realpath(host.descriptor.managedRoot),
        worktree: await realpath(root),
      })).pipe(Effect.orElseSucceed(() => null));
      if (!roots) return;
      // Only an allocation itself is adopted, never a directory inside one.
      if (managedWorktreeGitRootContaining(roots.managed, roots.worktree) !== roots.worktree)
        return;
      // Keep the configured spelling used by newborn ownership while comparing canonical paths.
      const worktreeGitRoot = path.join(
        host.descriptor.managedRoot,
        path.relative(roots.managed, roots.worktree),
      );
      const gitDirectory = yield* git.readPath(worktreeGitRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ]);
      const commonDirectory = yield* git.readPath(worktreeGitRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (
        !gitDirectory ||
        !commonDirectory ||
        path.resolve(gitDirectory) === path.resolve(commonDirectory)
      )
        return;
      const previous = yield* Effect.tryPromise({
        try: (signal) => readManagedWorktreeOwnerThread(worktreeGitRoot, signal),
        catch: (cause) =>
          new NativeSessionWorkspaceError({ operation: "workspace.reconcile", cause }),
      });
      if (previous !== null && input.sharedWorkspace) {
        yield* worktrees.releaseNewborn({ hostId: "local", worktreeGitRoot });
        return;
      }
      if (previous !== null && previous !== input.threadId)
        return yield* new NativeSessionWorkspaceError({
          operation: "workspace.reconcile",
          cause: new Error("Managed worktree belongs to another execution Thread"),
        });
      yield* worktrees
        .setOwner({ hostId: "local", worktreeGitRoot, ownerThreadId: input.threadId })
        .pipe(Effect.mapError(error));
      yield* worktrees.releaseNewborn({ hostId: "local", worktreeGitRoot });
    }),
    prepare: Effect.fn("NativeSessionWorkspace.prepare")(function* (
      input: NativeSessionWorkspaceInput,
    ) {
      const { sourceCwd, operationId } = input;
      const runInTarget = input.runInTarget ?? "localProject";
      if (input.localEnvironmentConfigPath && runInTarget !== "newWorktree")
        return yield* new NativeSessionWorkspaceError({
          operation: "workspace.environment",
          cause: new Error("A local Environment requires a new worktree"),
        });
      if (input.projectId === null && runInTarget === "newWorktree")
        return yield* new NativeSessionWorkspaceError({
          operation: "workspace.projectless",
          cause: new Error("A managed worktree requires a local Project"),
        });
      if (input.projectId === null) {
        const folder = yield* folders
          .ensure(input.targetId, { nameHint: input.prompt })
          .pipe(
            Effect.mapError(
              (cause) =>
                new NativeSessionWorkspaceError({ operation: "projectless.ensure", cause }),
            ),
          );
        return {
          location: {
            cwd: folder.path,
            workspaceRoots: [folder.path],
            managedWorktreePath: null,
            projectlessOutputDirectory: folder.output_directory ?? null,
            projectlessWorkspaceBrowserRoot: folder.path,
          },
          retain: Effect.void,
          attach: () => Effect.void,
        };
      }
      if (!sourceCwd)
        return yield* new NativeSessionWorkspaceError({
          operation: "workspace.resolve",
          cause: new Error("Project folder is unavailable"),
        });
      if (input.reusePageWorkspace) {
        const worktreeGitRoot = input.reusePageWorkspace.worktreeGitRoot;
        const prefix = yield* git.readPath(sourceCwd, ["rev-parse", "--show-prefix"]);
        const cwd = path.resolve(worktreeGitRoot, prefix ?? "");
        const relative = path.relative(worktreeGitRoot, cwd);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return yield* new NativeSessionWorkspaceError({
            operation: "workspace.reuse",
            cause: new Error("Page Workspace directory is outside its checkout"),
          });
        return {
          branchName: input.reusePageWorkspace.branchName,
          location: {
            cwd,
            workspaceRoots: [
              ...new Set([
                cwd,
                worktreeGitRoot,
                ...(input.sourceRoots ?? []).filter((root) => root !== sourceCwd),
              ]),
            ],
            managedWorktreePath: worktreeGitRoot,
            projectlessOutputDirectory: null,
            projectlessWorkspaceBrowserRoot: null,
          },
          retain: Effect.void,
          attach: () => Effect.void,
        };
      }
      if (runInTarget !== "newWorktree")
        return {
          location: {
            cwd: sourceCwd,
            workspaceRoots: [...new Set([sourceCwd, ...(input.sourceRoots ?? [])])],
            managedWorktreePath: null,
            projectlessOutputDirectory: null,
            projectlessWorkspaceBrowserRoot: null,
          },
          retain: Effect.void,
          attach: () => Effect.void,
        };
      const host = yield* hosts
        .resolve("local", "create")
        .pipe(
          Effect.mapError(
            (cause) => new NativeSessionWorkspaceError({ operation: "worktree.host", cause }),
          ),
        );
      const branchName = input.worktreeStartingState
        ? null
        : yield* git.readPath(sourceCwd, ["branch", "--show-current"]);
      let allocated: string | null = null;
      let attached = input.pageWorkspace !== undefined;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!allocated || attached) return;
          yield* worktrees
            .remove({ hostId: "local", worktreeGitRoot: allocated, reason: "failed-create" })
            .pipe(Effect.ignore);
          yield* worktrees.releaseNewborn({ hostId: "local", worktreeGitRoot: allocated });
        }),
      );
      const worker = yield* host
        .request(
          {
            operation: "create",
            input: {
              requestId: operationId,
              pageWorkspace: input.pageWorkspace,
              hostId: "local",
              repositoryPath: sourceCwd,
              nodexHome: config.nodexHome,
              managedRoot: input.pageWorkspacePath
                ? path.dirname(path.dirname(path.resolve(input.pageWorkspacePath)))
                : host.descriptor.managedRoot,
              projectId: input.projectId,
              targetId: input.targetId,
              threadTitle: input.title,
              startingState:
                input.worktreeStartingState ?? (branchName ? { type: "branch", branchName } : null),
              localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
              setUpSyncedBranch: true,
              propagateLocalWorkspaceFiles: true,
            },
          },
          {
            onEvent: (event) => {
              if (event.type !== "path-allocated") return Effect.void;
              allocated = path.resolve(event.worktreeGitRoot);
              return worktrees.registerNewborn({ hostId: "local", worktreeGitRoot: allocated });
            },
          },
        )
        .pipe(
          Effect.mapError(
            (cause) => new NativeSessionWorkspaceError({ operation: "worktree.create", cause }),
          ),
        );
      allocated = path.resolve(worker.worktreeGitRoot);
      if (worker.setupError)
        return yield* new NativeSessionWorkspaceError({
          operation: "worktree.setup",
          cause: new Error(worker.setupError),
        });
      const cwd = path.resolve(worker.worktreeWorkspaceRoot);
      if (worker.shellEnvironment) {
        const gitPath = yield* git.readPath(cwd, [
          "rev-parse",
          "--git-path",
          "codex-shell-environment.json",
        ]);
        if (!gitPath)
          return yield* new NativeSessionWorkspaceError({
            operation: "worktree.environment",
            cause: new Error("The worktree environment location is unavailable"),
          });
        yield* Effect.tryPromise({
          try: () =>
            persistCodexWorktreeShellEnvironmentAtGitPath({
              cwd,
              gitPath,
              shellEnvironment: worker.shellEnvironment,
            }),
          catch: (cause) =>
            new NativeSessionWorkspaceError({ operation: "worktree.environment", cause }),
        });
      }
      const roots = [
        cwd,
        allocated,
        ...(input.sourceRoots ?? []).filter((root) => root !== sourceCwd),
      ];
      const commonDir = yield* git.readPath(cwd, ["rev-parse", "--git-common-dir"]);
      if (commonDir) roots.push(path.resolve(cwd, commonDir));
      return {
        branchName: worker.branchName,
        location: {
          cwd,
          workspaceRoots: [...new Set(roots)],
          managedWorktreePath: allocated,
          projectlessOutputDirectory: null,
          projectlessWorkspaceBrowserRoot: null,
        },
        retain: Effect.sync(() => {
          attached = true;
        }),
        attach: (threadId: string) =>
          Effect.gen(function* () {
            // Core already owns this directory; a metadata repair failure must never delete it.
            attached = true;
            const owner = input.pageWorkspace
              ? yield* Effect.tryPromise(() => readManagedWorktreeOwnerThread(allocated!)).pipe(
                  Effect.orElseSucceed(() => null),
                )
              : null;
            yield* (
              owner
                ? Effect.void
                : worktrees.setOwner({
                    hostId: "local",
                    worktreeGitRoot: allocated!,
                    ownerThreadId: threadId,
                  })
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Worktree owner metadata could not be saved").pipe(
                  Effect.annotateLogs({ threadId, cause }),
                ),
              ),
            );
            yield* worktrees.releaseNewborn({ hostId: "local", worktreeGitRoot: allocated! });
          }),
      };
    }),
  });
});

export const layer = Layer.effect(NativeSessionWorkspace, make);
