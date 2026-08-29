import { createHash } from "node:crypto";
import * as path from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { CodexCrossHostPreparedHandoff } from "../codex/codex-thread-handoff-journal";
import type {
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerExportHandoffResult,
  CodexWorktreeWorkerImportHandoffResult,
} from "../codex/codex-worktree-worker-protocol";
import {
  type ExecutionHost,
  ExecutionHostRuntime,
  type ExecutionHostRuntimeError,
} from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

export interface PrepareCrossHostThreadHandoffInput {
  readonly operationId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectId: string;
  readonly sourceHostId: string;
  readonly destinationHostId: string;
  readonly sourceCwd: string;
  readonly sourceWorkspaceRoot: string;
  readonly sourceManagedWorktreePath: string | null;
  readonly sourceRolloutPath: string;
  readonly destinationRepositoryPaths: readonly string[];
}

export interface CrossHostThreadHandoffProgress {
  readonly phase: string;
  readonly status: "running" | "success" | "error";
}

export class CrossHostThreadHandoffError extends Schema.TaggedError<CrossHostThreadHandoffError>()(
  "CrossHostThreadHandoffError",
  {
    operation: Schema.String,
    sourceHostId: Schema.String,
    destinationHostId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CrossHostThreadHandoff extends Context.Service<
  CrossHostThreadHandoff,
  {
    readonly prepare: (
      input: PrepareCrossHostThreadHandoffInput,
      onProgress?: (progress: CrossHostThreadHandoffProgress) => Effect.Effect<void>,
    ) => Effect.Effect<CodexCrossHostPreparedHandoff, CrossHostThreadHandoffError>;
    readonly cleanup: (
      prepared: CodexCrossHostPreparedHandoff,
      outcome: "committed" | "rolled-back",
    ) => Effect.Effect<readonly string[]>;
  }
>()("nodex/main/codex-application/CrossHostThreadHandoff") {}

interface PartialHandoff {
  readonly exported: CodexWorktreeWorkerExportHandoffResult | null;
  readonly imported: CodexWorktreeWorkerImportHandoffResult | null;
  readonly allocatedWorktreeGitRoot: string | null;
}

const emptyPartial: PartialHandoff = {
  exported: null,
  imported: null,
  allocatedWorktreeGitRoot: null,
};

const isWithin = (parentPath: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const rolloutRelativePath = (codexHome: string, rolloutPath: string): string => {
  const relative = path.relative(path.resolve(codexHome), path.resolve(rolloutPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Task rollout is outside its execution host Codex home");
  }
  return relative;
};

const transferIdForOperation = (operationId: string): string =>
  createHash("sha256").update(operationId, "utf8").digest("hex").slice(0, 32);

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const eventProgress = (event: CodexWorktreeWorkerEvent): CrossHostThreadHandoffProgress | null => {
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

export const live = (options: {
  readonly relayBaseRoot: string;
}): Layer.Layer<
  CrossHostThreadHandoff,
  never,
  ExecutionHostRuntime | ManagedWorktreeRuntime | FileSystem.FileSystem
> =>
  Layer.effect(
    CrossHostThreadHandoff,
    Effect.gen(function* () {
      const executionHosts = yield* ExecutionHostRuntime;
      const managedWorktrees = yield* ManagedWorktreeRuntime;
      const fs = yield* FileSystem.FileSystem;
      const relayBaseRoot = path.resolve(options.relayBaseRoot);

      const handoffError = (
        operation: string,
        sourceHostId: string,
        destinationHostId: string,
        cause: unknown,
      ) =>
        new CrossHostThreadHandoffError({
          operation,
          sourceHostId,
          destinationHostId,
          cause,
        });
      const resolveHost = (
        hostId: string,
        operation: "export-handoff" | "import-handoff" | "cleanup-transfer-handoff",
        sourceHostId: string,
        destinationHostId: string,
      ): Effect.Effect<ExecutionHost, CrossHostThreadHandoffError> =>
        executionHosts
          .resolve(hostId, operation)
          .pipe(
            Effect.mapError((cause) =>
              handoffError(`resolve-${operation}`, sourceHostId, destinationHostId, cause),
            ),
          );
      const requireTransfer = (
        host: ExecutionHost,
        sourceHostId: string,
        destinationHostId: string,
      ) =>
        host.transfer
          ? Effect.succeed(host.transfer)
          : Effect.fail(
              handoffError(
                "resolve-file-transfer",
                sourceHostId,
                destinationHostId,
                new Error(`Execution host ${host.descriptor.hostId} cannot transfer files`),
              ),
            );
      const mapHostError = (operation: string, sourceHostId: string, destinationHostId: string) =>
        Effect.mapError((cause: ExecutionHostRuntimeError) =>
          handoffError(operation, sourceHostId, destinationHostId, cause),
        );
      const collect = <E>(
        warnings: string[],
        label: string,
        operation: Effect.Effect<readonly string[], E>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(operation);
          if (Exit.isSuccess(exit)) {
            warnings.push(...exit.value);
            return;
          }
          warnings.push(`${label}: ${failureMessage(Cause.squash(exit.cause))}`);
        });

      const cleanup = (
        prepared: CodexCrossHostPreparedHandoff,
        outcome: "committed" | "rolled-back",
      ): Effect.Effect<readonly string[]> =>
        Effect.gen(function* () {
          const warnings: string[] = [];
          const source = yield* Effect.exit(
            executionHosts.resolve(prepared.sourceHostId, "cleanup-transfer-handoff"),
          );
          const destination = yield* Effect.exit(
            executionHosts.resolve(prepared.destinationHostId, "cleanup-transfer-handoff"),
          );
          if (Exit.isFailure(destination)) {
            warnings.push(
              `destination cleanup: ${failureMessage(Cause.squash(destination.cause))}`,
            );
          } else {
            yield* collect(
              warnings,
              "destination cleanup",
              destination.value
                .request({
                  operation: "cleanup-transfer-handoff",
                  input: {
                    requestId: `handoff:cleanup:destination:${prepared.destinationHostId}:${prepared.sourceTemporaryRef}`,
                    hostId: prepared.destinationHostId,
                    transferId: prepared.transferId,
                    stagingRoot: prepared.destinationStagingRoot,
                    repositoryPath: prepared.destinationRepositoryPath,
                    temporaryRef: prepared.destinationTemporaryRef,
                    managedRoot: prepared.destinationManagedRoot,
                    createdWorktreePath: prepared.managedWorktreePath,
                    createdRolloutPath: prepared.destinationRolloutCreated
                      ? prepared.destinationRollout.path
                      : null,
                    destinationCodexHome: prepared.destinationCodexHome,
                    outcome,
                  },
                })
                .pipe(Effect.map((result) => result.warnings)),
            );
            if (destination.value.transfer) {
              yield* collect(
                warnings,
                "destination transfer cleanup",
                destination.value.transfer.cleanup(prepared.transferId).pipe(Effect.as([])),
              );
            }
          }
          if (Exit.isFailure(source)) {
            warnings.push(`source cleanup: ${failureMessage(Cause.squash(source.cause))}`);
          } else {
            yield* collect(
              warnings,
              "source cleanup",
              source.value
                .request({
                  operation: "cleanup-transfer-handoff",
                  input: {
                    requestId: `handoff:cleanup:source:${prepared.sourceHostId}:${prepared.sourceTemporaryRef}`,
                    hostId: prepared.sourceHostId,
                    transferId: prepared.transferId,
                    stagingRoot: prepared.sourceStagingRoot,
                    repositoryPath: prepared.sourceRepositoryPath,
                    temporaryRef: prepared.sourceTemporaryRef,
                    managedRoot: null,
                    createdWorktreePath: null,
                    createdRolloutPath: null,
                    destinationCodexHome: null,
                    outcome,
                  },
                })
                .pipe(Effect.map((result) => result.warnings)),
            );
            if (source.value.transfer) {
              yield* collect(
                warnings,
                "source transfer cleanup",
                source.value.transfer.cleanup(prepared.transferId).pipe(Effect.as([])),
              );
            }
          }
          yield* collect(
            warnings,
            "relay cleanup",
            isWithin(relayBaseRoot, prepared.relayRoot)
              ? fs.remove(prepared.relayRoot, { recursive: true, force: true }).pipe(
                  Effect.mapError((cause) =>
                    handoffError(
                      "cleanup-relay",
                      prepared.sourceHostId,
                      prepared.destinationHostId,
                      cause,
                    ),
                  ),
                  Effect.as<readonly string[]>([]),
                )
              : Effect.fail(
                  handoffError(
                    "cleanup-relay",
                    prepared.sourceHostId,
                    prepared.destinationHostId,
                    new Error("refused to clean relay outside private handoff root"),
                  ),
                ),
          );
          yield* managedWorktrees.releaseNewborn({
            hostId: prepared.destinationHostId,
            worktreeGitRoot: prepared.managedWorktreePath,
          });
          return warnings;
        });

      const cleanupPartial = (input: {
        readonly request: PrepareCrossHostThreadHandoffInput;
        readonly state: PartialHandoff;
        readonly source: ExecutionHost;
        readonly destination: ExecutionHost;
        readonly relayRoot: string;
        readonly relativeRolloutPath: string;
      }): Effect.Effect<readonly string[]> =>
        Effect.gen(function* () {
          const warnings: string[] = [];
          const transferId = transferIdForOperation(input.request.operationId);
          if (input.state.imported) {
            yield* collect(
              warnings,
              "destination prepare cleanup",
              input.destination
                .request({
                  operation: "cleanup-transfer-handoff",
                  input: {
                    requestId: `${input.request.operationId}:prepare-failure:destination`,
                    hostId: input.request.destinationHostId,
                    transferId,
                    stagingRoot: input.destination.descriptor.handoffStagingRoot,
                    repositoryPath: input.state.imported.destinationRepositoryPath,
                    temporaryRef: input.state.imported.temporaryRef,
                    managedRoot: input.destination.descriptor.managedRoot,
                    createdWorktreePath: input.state.imported.managedWorktreePath,
                    createdRolloutPath: input.state.imported.destinationRolloutCreated
                      ? input.state.imported.destinationRolloutPath
                      : null,
                    destinationCodexHome: input.destination.descriptor.codexHome,
                    outcome: "rolled-back",
                  },
                })
                .pipe(Effect.map((result) => result.warnings)),
            );
          } else {
            const destinationRef = `refs/codex/handoff/destination/${transferId}`;
            const destinationRolloutPath = path.resolve(
              input.destination.descriptor.codexHome,
              input.relativeRolloutPath,
            );
            yield* Effect.forEach(
              input.request.destinationRepositoryPaths,
              (repositoryPath, index) =>
                collect(
                  warnings,
                  `destination reconciliation ${repositoryPath}`,
                  input.destination
                    .request({
                      operation: "cleanup-transfer-handoff",
                      input: {
                        requestId: `${input.request.operationId}:prepare-failure:destination:${String(index)}`,
                        hostId: input.request.destinationHostId,
                        transferId,
                        stagingRoot: input.destination.descriptor.handoffStagingRoot,
                        repositoryPath,
                        temporaryRef: destinationRef,
                        managedRoot: input.destination.descriptor.managedRoot,
                        createdWorktreePath: null,
                        createdRolloutPath: index === 0 ? destinationRolloutPath : null,
                        destinationCodexHome: input.destination.descriptor.codexHome,
                        outcome: "rolled-back",
                      },
                    })
                    .pipe(Effect.map((result) => result.warnings)),
                ),
              { discard: true },
            );
          }
          if (input.state.exported) {
            yield* collect(
              warnings,
              "source prepare cleanup",
              input.source
                .request({
                  operation: "cleanup-transfer-handoff",
                  input: {
                    requestId: `${input.request.operationId}:prepare-failure:source`,
                    hostId: input.request.sourceHostId,
                    transferId,
                    stagingRoot: input.source.descriptor.handoffStagingRoot,
                    repositoryPath: input.state.exported.sourceRepositoryPath,
                    temporaryRef: input.state.exported.temporaryRef,
                    managedRoot: null,
                    createdWorktreePath: null,
                    createdRolloutPath: null,
                    destinationCodexHome: null,
                    outcome: "rolled-back",
                  },
                })
                .pipe(Effect.map((result) => result.warnings)),
            );
          }
          if (input.destination.transfer) {
            yield* collect(
              warnings,
              "destination transfer cleanup",
              input.destination.transfer.cleanup(transferId).pipe(Effect.as([])),
            );
          }
          if (input.source.transfer) {
            yield* collect(
              warnings,
              "source transfer cleanup",
              input.source.transfer.cleanup(transferId).pipe(Effect.as([])),
            );
          }
          yield* collect(
            warnings,
            "relay cleanup",
            fs.remove(input.relayRoot, { recursive: true, force: true }).pipe(Effect.as([])),
          );
          if (input.state.allocatedWorktreeGitRoot) {
            yield* managedWorktrees.releaseNewborn({
              hostId: input.request.destinationHostId,
              worktreeGitRoot: input.state.allocatedWorktreeGitRoot,
            });
          }
          return warnings;
        });

      const prepare = (
        input: PrepareCrossHostThreadHandoffInput,
        onProgress: (progress: CrossHostThreadHandoffProgress) => Effect.Effect<void> = () =>
          Effect.void,
      ): Effect.Effect<CodexCrossHostPreparedHandoff, CrossHostThreadHandoffError> =>
        Effect.gen(function* () {
          if (input.sourceHostId === input.destinationHostId) {
            return yield* handoffError(
              "validate",
              input.sourceHostId,
              input.destinationHostId,
              new Error("Cross-host handoff requires two different execution hosts"),
            );
          }
          if (input.destinationRepositoryPaths.length === 0) {
            return yield* handoffError(
              "validate",
              input.sourceHostId,
              input.destinationHostId,
              new Error("Destination host has no authorized repository candidates"),
            );
          }
          const [source, destination] = yield* Effect.all(
            [
              resolveHost(
                input.sourceHostId,
                "export-handoff",
                input.sourceHostId,
                input.destinationHostId,
              ),
              resolveHost(
                input.destinationHostId,
                "import-handoff",
                input.sourceHostId,
                input.destinationHostId,
              ),
            ] as const,
            { concurrency: "unbounded" },
          );
          const [sourceTransfer, destinationTransfer] = yield* Effect.all([
            requireTransfer(source, input.sourceHostId, input.destinationHostId),
            requireTransfer(destination, input.sourceHostId, input.destinationHostId),
          ] as const);
          const relativeRolloutPath = yield* Effect.try({
            try: () => rolloutRelativePath(source.descriptor.codexHome, input.sourceRolloutPath),
            catch: (cause) =>
              handoffError("resolve-rollout", input.sourceHostId, input.destinationHostId, cause),
          });
          const transferId = transferIdForOperation(input.operationId);
          const relayRoot = path.join(relayBaseRoot, transferId, "relay");
          if (!isWithin(relayBaseRoot, relayRoot)) {
            return yield* handoffError(
              "resolve-relay",
              input.sourceHostId,
              input.destinationHostId,
              new Error("Cross-host relay path escapes the private handoff root"),
            );
          }
          yield* fs
            .makeDirectory(relayRoot, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError((cause) =>
                handoffError("create-relay", input.sourceHostId, input.destinationHostId, cause),
              ),
            );
          const partial = yield* Ref.make(emptyPartial);
          const publishWorkerEvent = (event: CodexWorktreeWorkerEvent) => {
            if (event.type === "path-allocated") {
              return Ref.update(partial, (state) => ({
                ...state,
                allocatedWorktreeGitRoot: event.worktreeGitRoot,
              })).pipe(
                Effect.andThen(
                  managedWorktrees.registerNewborn({
                    hostId: input.destinationHostId,
                    worktreeGitRoot: event.worktreeGitRoot,
                  }),
                ),
              );
            }
            const progress = eventProgress(event);
            return progress ? onProgress(progress) : Effect.void;
          };
          const transaction = Effect.gen(function* () {
            const exported = yield* source
              .request(
                {
                  operation: "export-handoff",
                  input: {
                    requestId: `${input.operationId}:export`,
                    hostId: input.sourceHostId,
                    transferId,
                    sourceCwd: input.sourceCwd,
                    sourceWorkspaceRoot: input.sourceWorkspaceRoot,
                    stagingRoot: source.descriptor.handoffStagingRoot,
                  },
                },
                { onEvent: publishWorkerEvent },
              )
              .pipe(
                mapHostError("export", input.sourceHostId, input.destinationHostId),
                Effect.tap((exported) => Ref.update(partial, (state) => ({ ...state, exported }))),
              );
            const sourceRollout = yield* sourceTransfer
              .describe(input.sourceRolloutPath)
              .pipe(mapHostError("describe-rollout", input.sourceHostId, input.destinationHostId));
            yield* onProgress({ phase: "transfer-state", status: "running" });
            const [relayBundle, relayRollout] = yield* Effect.all(
              [
                sourceTransfer.download({
                  source: exported.bundle,
                  destinationPath: path.join(relayRoot, "source.bundle"),
                }),
                sourceTransfer.download({
                  source: sourceRollout,
                  destinationPath: path.join(relayRoot, "rollout.jsonl"),
                }),
              ] as const,
              { concurrency: "unbounded" },
            ).pipe(mapHostError("download", input.sourceHostId, input.destinationHostId));
            const [destinationBundle, stagedDestinationRollout] = yield* Effect.all(
              [
                destinationTransfer.upload({
                  localPath: relayBundle.path,
                  operationId: transferId,
                  fileName: "source.bundle",
                  sha256: relayBundle.sha256,
                  size: relayBundle.size,
                }),
                destinationTransfer.upload({
                  localPath: relayRollout.path,
                  operationId: transferId,
                  fileName: "rollout.jsonl",
                  sha256: relayRollout.sha256,
                  size: relayRollout.size,
                }),
              ] as const,
              { concurrency: "unbounded" },
            ).pipe(mapHostError("upload", input.sourceHostId, input.destinationHostId));
            yield* onProgress({ phase: "transfer-state", status: "success" });
            const imported = yield* destination
              .request(
                {
                  operation: "import-handoff",
                  input: {
                    requestId: `${input.operationId}:import`,
                    hostId: input.destinationHostId,
                    transferId,
                    bundlePath: destinationBundle.path,
                    rolloutPath: stagedDestinationRollout.path,
                    rolloutRelativePath: relativeRolloutPath,
                    destinationCodexHome: destination.descriptor.codexHome,
                    sourceCommit: exported.sourceCommit,
                    repositoryIdentity: exported.repositoryIdentity,
                    candidateRepositoryPaths: input.destinationRepositoryPaths,
                    managedRoot: destination.descriptor.managedRoot,
                    nodexHome: destination.descriptor.nodexHome,
                    projectId: input.projectId,
                    threadId: input.threadId,
                    threadTitle: input.threadTitle,
                  },
                },
                { onEvent: publishWorkerEvent },
              )
              .pipe(
                mapHostError("import", input.sourceHostId, input.destinationHostId),
                Effect.tap((imported) => Ref.update(partial, (state) => ({ ...state, imported }))),
              );
            return {
              direction: "cross-host",
              sourceHostId: input.sourceHostId,
              destinationHostId: input.destinationHostId,
              transferId,
              sourceBranch: exported.sourceBranch,
              sourceWorkspaceRoot: input.sourceWorkspaceRoot,
              sourceManagedWorktreePath: input.sourceManagedWorktreePath,
              destinationWorkspaceRoot: imported.destinationWorkspaceRoot,
              destinationGitRoot: imported.destinationGitRoot,
              managedWorktreePath: imported.managedWorktreePath,
              createdWorktree: true,
              sourceRepositoryPath: exported.sourceRepositoryPath,
              destinationRepositoryPath: imported.destinationRepositoryPath,
              sourceTemporaryRef: exported.temporaryRef,
              destinationTemporaryRef: imported.temporaryRef,
              sourceStagingRoot: source.descriptor.handoffStagingRoot,
              destinationStagingRoot: destination.descriptor.handoffStagingRoot,
              destinationManagedRoot: destination.descriptor.managedRoot,
              destinationCodexHome: destination.descriptor.codexHome,
              relayRoot,
              sourceBundle: exported.bundle,
              destinationBundle,
              sourceRollout,
              destinationRollout: {
                path: imported.destinationRolloutPath,
                sha256: sourceRollout.sha256,
                size: sourceRollout.size,
              },
              destinationRolloutCreated: imported.destinationRolloutCreated,
              warnings: [],
            } satisfies CodexCrossHostPreparedHandoff;
          });
          return yield* transaction.pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                const warnings = yield* cleanupPartial({
                  request: input,
                  state: yield* Ref.get(partial),
                  source,
                  destination,
                  relayRoot,
                  relativeRolloutPath,
                });
                if (warnings.length === 0) return;
                yield* Effect.logWarning("Cross-host handoff cleanup requires attention").pipe(
                  Effect.annotateLogs({
                    operationId: input.operationId,
                    warnings: warnings.join("; "),
                  }),
                );
              }),
            ),
          );
        });

      return CrossHostThreadHandoff.of({ prepare, cleanup });
    }),
  );
