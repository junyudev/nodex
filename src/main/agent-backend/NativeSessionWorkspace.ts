import * as path from "node:path";
import { rm } from "node:fs/promises";
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
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import { persistCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";

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
  /** Prevent cleanup when a Core admission may have committed but cannot yet be verified. */
  readonly retain: Effect.Effect<void>;
  /** Call immediately after the durable Thread link is admitted. */
  readonly attach: (threadId: string) => Effect.Effect<void>;
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
  }
>()("nodex/main/agent-backend/NativeSessionWorkspace") {}

/** Filesystem/Git ownership is shared with all native backends; no Agent process is launched. */
export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const hosts = yield* ExecutionHostRuntime;
  const worktrees = yield* ManagedWorktreeRuntime;
  const git = yield* CodexGitProbe;
  return NativeSessionWorkspace.of({
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
        let attached = false;
        const projectless = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              createCodexProjectlessWorkspace({
                createSplitDirectories: true,
                prompt: input.prompt,
                homeDirectory: config.homeDirectory,
              }),
            catch: (cause) =>
              new NativeSessionWorkspaceError({ operation: "projectless.create", cause }),
          }),
          (workspace) =>
            attached
              ? Effect.void
              : Effect.promise(() => rm(workspace.cwd, { recursive: true, force: true })).pipe(
                  Effect.ignore,
                ),
        );
        return {
          location: {
            cwd: projectless.cwd,
            workspaceRoots: [projectless.cwd],
            managedWorktreePath: null,
            projectlessOutputDirectory: projectless.outputDirectory,
            projectlessWorkspaceBrowserRoot: projectless.workspaceRoot,
          },
          retain: Effect.sync(() => {
            attached = true;
          }),
          attach: () =>
            Effect.sync(() => {
              attached = true;
            }),
        };
      }
      if (!sourceCwd)
        return yield* new NativeSessionWorkspaceError({
          operation: "workspace.resolve",
          cause: new Error("Project folder is unavailable"),
        });
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
      let attached = false;
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
              hostId: "local",
              repositoryPath: sourceCwd,
              nodexHome: config.nodexHome,
              managedRoot: host.descriptor.managedRoot,
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
            yield* worktrees
              .setOwner({ hostId: "local", worktreeGitRoot: allocated!, ownerThreadId: threadId })
              .pipe(
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
