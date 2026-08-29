import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  CodexManagedWorktreeRemovalReason,
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerInspectResult,
  CodexWorktreeWorkerListResult,
  CodexWorktreeWorkerRemoveResult,
  CodexWorktreeWorkerRestoreResult,
} from "../codex/codex-worktree-worker-protocol";
import { normalizeWorktreePathForIdentity } from "../codex/codex-managed-worktree-effects";
import { snapshotPolicyForManagedWorktreeRemoval } from "../codex/codex-managed-worktree-lifecycle";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";

export interface ManagedWorktreeRemoveInput {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly reason: CodexManagedWorktreeRemovalReason;
  readonly onEvent?: (event: CodexWorktreeWorkerEvent) => Effect.Effect<void>;
}

export interface ManagedWorktreeInspectInput {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly cwd: string;
  readonly candidateRepositoryPaths: readonly string[];
}

export interface ManagedWorktreeRestoreInput extends ManagedWorktreeInspectInput {
  readonly ownerThreadId: string | null;
  readonly onEvent?: (event: CodexWorktreeWorkerEvent) => Effect.Effect<void>;
}

export interface ManagedWorktreeSetOwnerInput {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly ownerThreadId: string;
}

export interface ManagedWorktreeNewborn {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
}

export class ManagedWorktreeRuntimeError extends Schema.TaggedError<ManagedWorktreeRuntimeError>()(
  "ManagedWorktreeRuntimeError",
  {
    operation: Schema.String,
    hostId: Schema.String,
    worktreeGitRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ManagedWorktreeRuntime extends Context.Service<
  ManagedWorktreeRuntime,
  {
    readonly remove: (
      input: ManagedWorktreeRemoveInput,
    ) => Effect.Effect<CodexWorktreeWorkerRemoveResult, ManagedWorktreeRuntimeError>;
    readonly inspect: (
      input: ManagedWorktreeInspectInput,
    ) => Effect.Effect<CodexWorktreeWorkerInspectResult, ManagedWorktreeRuntimeError>;
    readonly list: (
      hostId: string,
    ) => Effect.Effect<CodexWorktreeWorkerListResult, ManagedWorktreeRuntimeError>;
    readonly restore: (
      input: ManagedWorktreeRestoreInput,
    ) => Effect.Effect<CodexWorktreeWorkerRestoreResult, ManagedWorktreeRuntimeError>;
    readonly setOwner: (
      input: ManagedWorktreeSetOwnerInput,
    ) => Effect.Effect<void, ManagedWorktreeRuntimeError>;
    readonly registerNewborn: (input: ManagedWorktreeNewborn) => Effect.Effect<void>;
    readonly releaseNewborn: (input: ManagedWorktreeNewborn) => Effect.Effect<void>;
    readonly isNewborn: (input: ManagedWorktreeNewborn) => Effect.Effect<boolean>;
    readonly newborns: Effect.Effect<readonly ManagedWorktreeNewborn[]>;
  }
>()("nodex/main/codex-application/ManagedWorktreeRuntime") {}

export const live: Layer.Layer<ManagedWorktreeRuntime, never, ExecutionHostRuntime> = Layer.effect(
  ManagedWorktreeRuntime,
  Effect.gen(function* () {
    const executionHosts = yield* ExecutionHostRuntime;
    const scope = yield* Scope.Scope;
    const removalLock = yield* Semaphore.make(1);
    const inspectionLock = yield* Semaphore.make(1);
    const removals = yield* Ref.make<
      ReadonlyMap<
        string,
        Deferred.Deferred<CodexWorktreeWorkerRemoveResult, ManagedWorktreeRuntimeError>
      >
    >(new Map());
    const inspections = yield* Ref.make<
      ReadonlyMap<
        string,
        Deferred.Deferred<CodexWorktreeWorkerInspectResult, ManagedWorktreeRuntimeError>
      >
    >(new Map());
    const newborns = yield* Ref.make<ReadonlyMap<string, ManagedWorktreeNewborn>>(new Map());

    const key = (hostId: string, worktreeGitRoot: string): string =>
      `${hostId.trim()}\0${normalizeWorktreePathForIdentity(path.resolve(worktreeGitRoot))}`;
    const error = (operation: string, hostId: string, cause: unknown, worktreeGitRoot?: string) =>
      new ManagedWorktreeRuntimeError({
        operation,
        hostId,
        cause,
        ...(worktreeGitRoot ? { worktreeGitRoot } : {}),
      });
    const host = (
      hostId: string,
      operation: import("../codex/codex-worktree-worker-protocol").CodexWorktreeWorkerOperation,
    ) =>
      executionHosts
        .resolve(hostId, operation)
        .pipe(Effect.mapError((cause) => error(`resolve-${operation}-host`, hostId, cause)));
    const inspectionKey = (input: ManagedWorktreeInspectInput): string =>
      [
        key(input.hostId, input.worktreeGitRoot),
        normalizeWorktreePathForIdentity(path.resolve(input.cwd)),
        ...input.candidateRepositoryPaths
          .map((candidate) => normalizeWorktreePathForIdentity(path.resolve(candidate)))
          .sort(),
      ].join("\0");

    const runRemoval = Effect.fn("ManagedWorktreeRuntime.runRemoval")(function* (
      input: ManagedWorktreeRemoveInput,
      removalKey: string,
      deferred: Deferred.Deferred<CodexWorktreeWorkerRemoveResult, ManagedWorktreeRuntimeError>,
    ) {
      const operation = Effect.gen(function* () {
        const target = yield* host(input.hostId, "remove");
        return yield* target
          .request(
            {
              operation: "remove",
              input: {
                requestId: `lifecycle:remove:${randomUUID()}`,
                hostId: input.hostId,
                worktreeGitRoot: input.worktreeGitRoot,
                reason: input.reason,
                snapshotPolicy: snapshotPolicyForManagedWorktreeRemoval(input.reason),
              },
            },
            { onEvent: input.onEvent },
          )
          .pipe(
            Effect.mapError((cause) => error("remove", input.hostId, cause, input.worktreeGitRoot)),
          );
      }).pipe(
        Effect.ensuring(
          Ref.update(removals, (current) => {
            if (current.get(removalKey) !== deferred) return current;
            const next = new Map(current);
            next.delete(removalKey);
            return next;
          }).pipe(
            Effect.andThen(
              Ref.update(newborns, (current) => {
                const next = new Map(current);
                next.delete(removalKey);
                return next;
              }),
            ),
          ),
        ),
        Effect.onExit((exit) => Deferred.done(deferred, exit)),
      );
      yield* Effect.forkIn(operation, scope, { startImmediately: true });
    });

    const remove = (
      input: ManagedWorktreeRemoveInput,
    ): Effect.Effect<CodexWorktreeWorkerRemoveResult, ManagedWorktreeRuntimeError> =>
      Effect.gen(function* () {
        const removalKey = key(input.hostId, input.worktreeGitRoot);
        const deferred = yield* removalLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(removals);
            const existing = current.get(removalKey);
            if (existing !== undefined) return existing;
            const created = yield* Deferred.make<
              CodexWorktreeWorkerRemoveResult,
              ManagedWorktreeRuntimeError
            >();
            yield* Ref.update(removals, (state) => new Map(state).set(removalKey, created));
            yield* runRemoval(input, removalKey, created);
            return created;
          }),
        );
        return yield* Deferred.await(deferred);
      });

    const runInspection = Effect.fn("ManagedWorktreeRuntime.runInspection")(function* (
      input: ManagedWorktreeInspectInput,
      operationKey: string,
      deferred: Deferred.Deferred<CodexWorktreeWorkerInspectResult, ManagedWorktreeRuntimeError>,
    ) {
      const operation = Effect.gen(function* () {
        const target = yield* host(input.hostId, "inspect");
        return yield* target
          .request({
            operation: "inspect",
            input: {
              requestId: `lifecycle:inspect:${randomUUID()}`,
              hostId: input.hostId,
              worktreeGitRoot: input.worktreeGitRoot,
              cwd: input.cwd,
              candidateRepositoryPaths: input.candidateRepositoryPaths,
            },
          })
          .pipe(
            Effect.mapError((cause) =>
              error("inspect", input.hostId, cause, input.worktreeGitRoot),
            ),
          );
      }).pipe(
        Effect.ensuring(
          Ref.update(inspections, (current) => {
            if (current.get(operationKey) !== deferred) return current;
            const next = new Map(current);
            next.delete(operationKey);
            return next;
          }),
        ),
        Effect.onExit((exit) => Deferred.done(deferred, exit)),
      );
      yield* Effect.forkIn(operation, scope, { startImmediately: true });
    });

    const inspect = (
      input: ManagedWorktreeInspectInput,
    ): Effect.Effect<CodexWorktreeWorkerInspectResult, ManagedWorktreeRuntimeError> =>
      Effect.gen(function* () {
        const operationKey = inspectionKey(input);
        const deferred = yield* inspectionLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(inspections);
            const existing = current.get(operationKey);
            if (existing !== undefined) return existing;
            const created = yield* Deferred.make<
              CodexWorktreeWorkerInspectResult,
              ManagedWorktreeRuntimeError
            >();
            yield* Ref.update(inspections, (state) => new Map(state).set(operationKey, created));
            yield* runInspection(input, operationKey, created);
            return created;
          }),
        );
        return yield* Deferred.await(deferred);
      });

    const list = (
      hostId: string,
    ): Effect.Effect<CodexWorktreeWorkerListResult, ManagedWorktreeRuntimeError> =>
      Effect.gen(function* () {
        const target = yield* host(hostId, "list");
        return yield* target
          .request({
            operation: "list",
            input: {
              requestId: `lifecycle:list:${randomUUID()}`,
              hostId,
              managedRoot: target.descriptor.managedRoot,
            },
          })
          .pipe(Effect.mapError((cause) => error("list", hostId, cause)));
      });

    const restore = (
      input: ManagedWorktreeRestoreInput,
    ): Effect.Effect<CodexWorktreeWorkerRestoreResult, ManagedWorktreeRuntimeError> =>
      Effect.gen(function* () {
        const target = yield* host(input.hostId, "restore");
        return yield* target
          .request(
            {
              operation: "restore",
              input: {
                requestId: `lifecycle:restore:${randomUUID()}`,
                hostId: input.hostId,
                worktreeGitRoot: input.worktreeGitRoot,
                cwd: input.cwd,
                candidateRepositoryPaths: input.candidateRepositoryPaths,
                ownerThreadId: input.ownerThreadId,
              },
            },
            { onEvent: input.onEvent },
          )
          .pipe(
            Effect.mapError((cause) =>
              error("restore", input.hostId, cause, input.worktreeGitRoot),
            ),
          );
      });

    const setOwner = (
      input: ManagedWorktreeSetOwnerInput,
    ): Effect.Effect<void, ManagedWorktreeRuntimeError> =>
      Effect.gen(function* () {
        const target = yield* host(input.hostId, "set-owner");
        yield* target
          .request({
            operation: "set-owner",
            input: {
              requestId: `lifecycle:set-owner:${randomUUID()}`,
              hostId: input.hostId,
              worktreeGitRoot: input.worktreeGitRoot,
              ownerThreadId: input.ownerThreadId,
            },
          })
          .pipe(
            Effect.mapError((cause) =>
              error("set-owner", input.hostId, cause, input.worktreeGitRoot),
            ),
          );
      });

    return ManagedWorktreeRuntime.of({
      remove,
      inspect,
      list,
      restore,
      setOwner,
      registerNewborn: (input) =>
        Ref.update(newborns, (current) =>
          new Map(current).set(key(input.hostId, input.worktreeGitRoot), input),
        ),
      releaseNewborn: (input) =>
        Ref.update(newborns, (current) => {
          const next = new Map(current);
          next.delete(key(input.hostId, input.worktreeGitRoot));
          return next;
        }),
      isNewborn: (input) =>
        Ref.get(newborns).pipe(
          Effect.map((current) => current.has(key(input.hostId, input.worktreeGitRoot))),
        ),
      newborns: Ref.get(newborns).pipe(Effect.map((current) => [...current.values()])),
    });
  }),
);
