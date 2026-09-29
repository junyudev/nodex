import * as path from "node:path";
import { rm } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { CodexScheduledAutomation } from "../../shared/types";
import { MainConfig } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";

export interface NativeAutomationWorkspaceLocation {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly managedWorktreePath: string | null;
  readonly projectlessOutputDirectory: string | null;
  readonly projectlessWorkspaceBrowserRoot: string | null;
}

export interface NativeAutomationWorkspaceLease {
  readonly location: NativeAutomationWorkspaceLocation;
  /** Call immediately after the durable Thread link is admitted. */
  readonly attach: (threadId: string) => Effect.Effect<void>;
}

export class NativeAutomationWorkspaceError extends Schema.TaggedError<NativeAutomationWorkspaceError>()(
  "NativeAutomationWorkspaceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class NativeAutomationWorkspace extends Context.Service<
  NativeAutomationWorkspace,
  {
    readonly prepare: (input: {
      readonly definition: CodexScheduledAutomation;
      readonly sourceCwd: string | null;
      readonly operationId: string;
    }) => Effect.Effect<
      NativeAutomationWorkspaceLease,
      NativeAutomationWorkspaceError,
      Scope.Scope
    >;
  }
>()("nodex/main/automation-application/NativeAutomationWorkspace") {}

/** Filesystem/Git ownership is shared with all native backends; no Agent process is launched. */
export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const hosts = yield* ExecutionHostRuntime;
  const worktrees = yield* ManagedWorktreeRuntime;
  const git = yield* CodexGitProbe;
  return NativeAutomationWorkspace.of({
    prepare: (input) =>
      Effect.gen(function* () {
        const { definition, sourceCwd, operationId } = input;
        if (definition.localEnvironmentConfigPath)
          return yield* new NativeAutomationWorkspaceError({
            operation: "workspace.environment",
            cause: new Error("Claude automation uses its profile environment"),
          });
        if (definition.projectId === null) {
          let attached = false;
          const projectless = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                createCodexProjectlessWorkspace({
                  createSplitDirectories: true,
                  prompt: definition.prompt,
                  homeDirectory: config.homeDirectory,
                }),
              catch: (cause) =>
                new NativeAutomationWorkspaceError({ operation: "projectless.create", cause }),
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
            attach: () =>
              Effect.sync(() => {
                attached = true;
              }),
          };
        }
        if (!sourceCwd)
          return yield* new NativeAutomationWorkspaceError({
            operation: "workspace.resolve",
            cause: new Error("Project folder is unavailable"),
          });
        if (definition.executionEnvironment !== "worktree")
          return {
            location: {
              cwd: sourceCwd,
              workspaceRoots: [sourceCwd],
              managedWorktreePath: null,
              projectlessOutputDirectory: null,
              projectlessWorkspaceBrowserRoot: null,
            },
            attach: () => Effect.void,
          };
        const host = yield* hosts
          .resolve("local", "create")
          .pipe(
            Effect.mapError(
              (cause) => new NativeAutomationWorkspaceError({ operation: "worktree.host", cause }),
            ),
          );
        const branchName = yield* git.readPath(sourceCwd, ["branch", "--show-current"]);
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
                projectId: definition.projectId,
                targetId: definition.id,
                threadTitle: definition.name,
                startingState: branchName ? { type: "branch", branchName } : null,
                localEnvironmentConfigPath: null,
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
              (cause) =>
                new NativeAutomationWorkspaceError({ operation: "worktree.create", cause }),
            ),
          );
        allocated = path.resolve(worker.worktreeGitRoot);
        if (worker.setupError)
          return yield* new NativeAutomationWorkspaceError({
            operation: "worktree.setup",
            cause: new Error(worker.setupError),
          });
        const cwd = path.resolve(worker.worktreeWorkspaceRoot);
        const roots = [cwd, allocated];
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

export const layer = Layer.effect(NativeAutomationWorkspace, make);
