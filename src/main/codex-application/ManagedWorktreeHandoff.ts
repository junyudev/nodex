import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  isExecutionWorkspacePathWithinRoot,
  rewriteExecutionWorkspaceRoots,
} from "../codex/codex-execution-workspace-roots";
import type {
  CodexThreadExecutionLocation,
  CodexThreadHandoffJournalEntry,
  CodexThreadHandoffPreparedArtifact,
} from "../codex/codex-thread-handoff-journal";
import type { CodexWorktreeWorkerEvent } from "../codex/codex-worktree-worker-protocol";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  CrossHostThreadHandoff,
  type CrossHostThreadHandoffProgress,
} from "./CrossHostThreadHandoff";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeRetentionRuntime } from "./ManagedWorktreeRetentionRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

export interface ManagedWorktreeHandoffPreparation {
  readonly destination: CodexThreadExecutionLocation;
  readonly prepared: CodexThreadHandoffPreparedArtifact;
}

export class ManagedWorktreeHandoffError extends Schema.TaggedError<ManagedWorktreeHandoffError>()(
  "ManagedWorktreeHandoffError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ManagedWorktreeHandoff extends Context.Service<
  ManagedWorktreeHandoff,
  {
    readonly prepare: (
      entry: CodexThreadHandoffJournalEntry,
      onProgress?: (progress: CrossHostThreadHandoffProgress) => Effect.Effect<void>,
    ) => Effect.Effect<ManagedWorktreeHandoffPreparation, ManagedWorktreeHandoffError>;
    readonly transferOwner: (
      threadId: string,
      preparation: ManagedWorktreeHandoffPreparation,
    ) => Effect.Effect<void, ManagedWorktreeHandoffError>;
    readonly rollback: (
      threadId: string,
      preparation: ManagedWorktreeHandoffPreparation,
    ) => Effect.Effect<readonly string[], ManagedWorktreeHandoffError>;
    readonly cleanup: (
      threadId: string,
      preparation: ManagedWorktreeHandoffPreparation,
      outcome: "committed" | "rolled-back",
    ) => Effect.Effect<readonly string[]>;
  }
>()("nodex/main/codex-application/ManagedWorktreeHandoff") {}

const resolveDestinationCwd = (input: {
  readonly source: CodexThreadExecutionLocation;
  readonly sourcePrimary: string;
  readonly targetPrimary: string;
}): string => {
  const relative = path.relative(input.sourcePrimary, input.source.cwd);
  if (relative === "") return input.targetPrimary;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return input.source.cwd;
  return path.join(input.targetPrimary, relative);
};

const progressFromEvent = (
  event: CodexWorktreeWorkerEvent,
): CrossHostThreadHandoffProgress | null => {
  if (event.type !== "handoff-progress") return null;
  return {
    phase: event.step,
    status:
      event.status === "failed"
        ? "error"
        : event.status === "completed" || event.status === "skipped"
          ? "success"
          : "running",
  };
};

export const live: Layer.Layer<
  ManagedWorktreeHandoff,
  never,
  | CodexGateway
  | CoreModules
  | CrossHostThreadHandoff
  | ExecutionHostRuntime
  | ManagedWorktreeRetentionRuntime
  | ManagedWorktreeRuntime
> = Layer.effect(
  ManagedWorktreeHandoff,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const core = yield* CoreModules;
    const crossHost = yield* CrossHostThreadHandoff;
    const executionHosts = yield* ExecutionHostRuntime;
    const managedWorktrees = yield* ManagedWorktreeRuntime;
    const retention = yield* ManagedWorktreeRetentionRuntime;

    const error = (operation: string, threadId: string, cause: unknown) =>
      new ManagedWorktreeHandoffError({ operation, threadId, cause });
    const publish = (
      event: CodexWorktreeWorkerEvent,
      onProgress: (progress: CrossHostThreadHandoffProgress) => Effect.Effect<void>,
    ) => {
      const progress = progressFromEvent(event);
      return progress ? onProgress(progress) : Effect.void;
    };
    const threadTitle = (entry: CodexThreadHandoffJournalEntry) =>
      core.workspace.read({ kind: "thread", thread_id: entry.threadId }).pipe(
        Effect.mapError((cause) => error("read-thread", entry.threadId, cause)),
        Effect.flatMap((snapshot) =>
          snapshot.value.kind === "thread"
            ? Effect.succeed(
                snapshot.value.thread.thread_name?.trim() ||
                  snapshot.value.thread.thread_preview.trim() ||
                  entry.threadId,
              )
            : Effect.fail(
                error(
                  "read-thread",
                  entry.threadId,
                  new Error("Core returned a non-thread Workspace read variant"),
                ),
              ),
        ),
      );
    const project = (entry: CodexThreadHandoffJournalEntry) => {
      if (!entry.source.projectId) {
        return Effect.fail(
          error(
            "read-project",
            entry.threadId,
            new Error("Move this task into a Project before handing it to a managed worktree"),
          ),
        );
      }
      return core.workspace
        .read(
          { kind: "project", project_id: entry.source.projectId },
          undefined,
          entry.source.projectId,
        )
        .pipe(
          Effect.mapError((cause) => error("read-project", entry.threadId, cause)),
          Effect.flatMap((snapshot) =>
            snapshot.value.kind === "project"
              ? Effect.succeed(snapshot.value.project)
              : Effect.fail(
                  error(
                    "read-project",
                    entry.threadId,
                    new Error("Core returned a non-project Workspace read variant"),
                  ),
                ),
          ),
        );
    };

    const prepare = (
      entry: CodexThreadHandoffJournalEntry,
      onProgress: (progress: CrossHostThreadHandoffProgress) => Effect.Effect<void> = () =>
        Effect.void,
    ): Effect.Effect<ManagedWorktreeHandoffPreparation, ManagedWorktreeHandoffError> =>
      Effect.gen(function* () {
        const owningProject = yield* project(entry);
        const title = yield* threadTitle(entry);
        const destinationHostId = entry.requestedDestinationHostId ?? entry.source.hostId;
        const destinationHost = yield* executionHosts
          .resolve(
            destinationHostId,
            destinationHostId === entry.source.hostId ? "prepare-handoff" : "import-handoff",
          )
          .pipe(
            Effect.mapError((cause) => error("resolve-destination-host", entry.threadId, cause)),
          );
        const sourcePrimary =
          entry.source.workspaceRoots[0] ?? entry.source.managedWorktreePath ?? entry.source.cwd;

        if (destinationHostId !== entry.source.hostId) {
          const metadata = yield* gateway
            .requestOnHost(entry.source.hostId, "thread/read", {
              threadId: entry.threadId,
              includeTurns: false,
            })
            .pipe(Effect.mapError((cause) => error("read-source-rollout", entry.threadId, cause)));
          const sourceRolloutPath = metadata.thread.path?.trim() ?? "";
          if (!sourceRolloutPath || !path.isAbsolute(sourceRolloutPath)) {
            return yield* error(
              "read-source-rollout",
              entry.threadId,
              new Error("Cross-host handoff requires a persisted source rollout"),
            );
          }
          const destinationRepositoryPaths =
            destinationHost.descriptor.kind === "local"
              ? owningProject.sources
                  .map((source) => source.root.trim())
                  .filter((root) => path.isAbsolute(root))
              : destinationHost.descriptor.repositoryRoots;
          const additionalRoots = entry.source.workspaceRoots.filter(
            (root) => !isExecutionWorkspacePathWithinRoot(root, sourcePrimary),
          );
          yield* Effect.forEach(
            additionalRoots,
            (root) =>
              gateway.requestOnHost(destinationHostId, "fs/getMetadata", { path: root }).pipe(
                Effect.mapError((cause) =>
                  error(
                    "validate-additional-root",
                    entry.threadId,
                    new Error(
                      `Destination host cannot preserve additional workspace root ${root}`,
                      { cause },
                    ),
                  ),
                ),
                Effect.flatMap((metadata) =>
                  metadata.isDirectory && !metadata.isSymlink
                    ? Effect.void
                    : Effect.fail(
                        error(
                          "validate-additional-root",
                          entry.threadId,
                          new Error(
                            `Destination host additional workspace root is not a safe directory: ${root}`,
                          ),
                        ),
                      ),
                ),
              ),
            { discard: true },
          );
          const prepared = yield* crossHost
            .prepare(
              {
                operationId: entry.operationId,
                threadId: entry.threadId,
                threadTitle: title,
                projectId: entry.source.projectId!,
                sourceHostId: entry.source.hostId,
                destinationHostId,
                sourceCwd: entry.source.cwd,
                sourceWorkspaceRoot: sourcePrimary,
                sourceManagedWorktreePath: entry.source.managedWorktreePath,
                sourceRolloutPath,
                destinationRepositoryPaths,
              },
              onProgress,
            )
            .pipe(Effect.mapError((cause) => error("prepare-cross-host", entry.threadId, cause)));
          const targetPrimary = prepared.destinationWorkspaceRoot;
          return {
            prepared,
            destination: {
              ...entry.source,
              hostId: destinationHostId,
              cwd: resolveDestinationCwd({ source: entry.source, sourcePrimary, targetPrimary }),
              workspaceRoots: rewriteExecutionWorkspaceRoots({
                sourcePrimary,
                targetPrimary,
                workspaceRoots: entry.source.workspaceRoots,
              }),
              managedWorktreePath: prepared.managedWorktreePath,
            },
          };
        }

        if (destinationHost.descriptor.kind !== "local") {
          return yield* error(
            "prepare-current-host",
            entry.threadId,
            new Error("Current-host checkout/worktree toggling is only configured locally"),
          );
        }
        const checkoutRoot = owningProject.sources[0]?.root.trim() ?? "";
        if (!checkoutRoot || !path.isAbsolute(checkoutRoot)) {
          return yield* error(
            "prepare-current-host",
            entry.threadId,
            new Error("The task Project has no local checkout destination"),
          );
        }
        const localSourcePrimary =
          entry.source.workspaceRoots[0] ?? entry.source.managedWorktreePath ?? checkoutRoot;
        const allocated = yield* Ref.make<string | null>(null);
        const prepared = yield* destinationHost
          .request(
            {
              operation: "prepare-handoff",
              input: {
                requestId: entry.operationId,
                hostId: destinationHostId,
                managedRoot: destinationHost.descriptor.managedRoot,
                nodexHome: destinationHost.descriptor.nodexHome,
                projectId: entry.source.projectId!,
                threadId: entry.threadId,
                threadTitle: title,
                sourceCwd: entry.source.cwd,
                sourceWorkspaceRoot: localSourcePrimary,
                sourceManagedWorktreePath: entry.source.managedWorktreePath,
                destinationCheckoutRoot: entry.source.managedWorktreePath ? checkoutRoot : null,
              },
            },
            {
              onEvent: (event) => {
                if (event.type !== "path-allocated") return publish(event, onProgress);
                return Ref.set(allocated, event.worktreeGitRoot).pipe(
                  Effect.andThen(
                    managedWorktrees.registerNewborn({
                      hostId: destinationHostId,
                      worktreeGitRoot: event.worktreeGitRoot,
                    }),
                  ),
                );
              },
            },
          )
          .pipe(
            Effect.mapError((cause) => error("prepare-current-host", entry.threadId, cause)),
            Effect.onError(() =>
              Ref.get(allocated).pipe(
                Effect.flatMap((worktreeGitRoot) =>
                  worktreeGitRoot
                    ? managedWorktrees.releaseNewborn({
                        hostId: destinationHostId,
                        worktreeGitRoot,
                      })
                    : Effect.void,
                ),
              ),
            ),
          );
        const targetPrimary = prepared.destinationWorkspaceRoot;
        return {
          prepared,
          destination: {
            ...entry.source,
            cwd: resolveDestinationCwd({
              source: entry.source,
              sourcePrimary: localSourcePrimary,
              targetPrimary,
            }),
            workspaceRoots: rewriteExecutionWorkspaceRoots({
              sourcePrimary: localSourcePrimary,
              targetPrimary,
              workspaceRoots: entry.source.workspaceRoots,
            }),
            managedWorktreePath:
              prepared.direction === "to-worktree" ? prepared.managedWorktreePath : null,
          },
        };
      });

    const transferOwner = (threadId: string, preparation: ManagedWorktreeHandoffPreparation) =>
      managedWorktrees
        .setOwner({
          hostId: preparation.destination.hostId,
          worktreeGitRoot: preparation.prepared.managedWorktreePath,
          ownerThreadId: threadId,
        })
        .pipe(
          Effect.mapError((cause) => error("transfer-owner", threadId, cause)),
          Effect.ensuring(
            (preparation.prepared.direction === "to-worktree" ||
            preparation.prepared.direction === "cross-host"
              ? managedWorktrees.releaseNewborn({
                  hostId: preparation.destination.hostId,
                  worktreeGitRoot: preparation.prepared.managedWorktreePath,
                })
              : Effect.void
            ).pipe(Effect.andThen(retention.request)),
          ),
        );

    const rollback = (
      threadId: string,
      preparation: ManagedWorktreeHandoffPreparation,
    ): Effect.Effect<readonly string[], ManagedWorktreeHandoffError> => {
      if (preparation.prepared.direction === "cross-host") return Effect.succeed([]);
      const prepared = preparation.prepared;
      return Effect.gen(function* () {
        const host = yield* executionHosts
          .resolve(preparation.destination.hostId, "rollback-handoff")
          .pipe(Effect.mapError((cause) => error("resolve-rollback-host", threadId, cause)));
        return yield* host
          .request({
            operation: "rollback-handoff",
            input: {
              requestId: `handoff:rollback:${randomUUID()}`,
              hostId: preparation.destination.hostId,
              prepared,
            },
          })
          .pipe(
            Effect.map((result) => result.warnings),
            Effect.mapError((cause) => error("rollback", threadId, cause)),
            Effect.ensuring(
              preparation.prepared.direction === "to-worktree"
                ? managedWorktrees.releaseNewborn({
                    hostId: preparation.destination.hostId,
                    worktreeGitRoot: preparation.prepared.managedWorktreePath,
                  })
                : Effect.void,
            ),
          );
      });
    };

    const cleanup = (
      threadId: string,
      preparation: ManagedWorktreeHandoffPreparation,
      outcome: "committed" | "rolled-back",
    ): Effect.Effect<readonly string[]> => {
      if (preparation.prepared.direction !== "cross-host") {
        const prepared = preparation.prepared;
        return executionHosts.resolve(preparation.destination.hostId, "cleanup-handoff").pipe(
          Effect.flatMap((host) =>
            host.request({
              operation: "cleanup-handoff",
              input: {
                requestId: `handoff:cleanup:${randomUUID()}`,
                hostId: preparation.destination.hostId,
                prepared,
                outcome,
              },
            }),
          ),
          Effect.map((result) => result.warnings),
          Effect.catch((cause) =>
            Effect.succeed([
              `artifact cleanup: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}`,
            ]),
          ),
        );
      }
      const prepared = preparation.prepared;
      return Effect.gen(function* () {
        const warnings: string[] = [];
        if (outcome === "committed" && prepared.sourceManagedWorktreePath) {
          const removed = yield* Effect.exit(
            managedWorktrees.remove({
              hostId: prepared.sourceHostId,
              worktreeGitRoot: prepared.sourceManagedWorktreePath,
              reason: "handoff",
            }),
          );
          if (Exit.isSuccess(removed)) warnings.push(...removed.value.warnings);
          else warnings.push(`source worktree cleanup: ${Cause.pretty(removed.cause)}`);
        }
        warnings.push(...(yield* crossHost.cleanup(prepared, outcome)));
        return warnings;
      });
    };

    return ManagedWorktreeHandoff.of({ prepare, transferOwner, rollback, cleanup });
  }),
);
