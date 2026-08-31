import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type {
  CodexConversationResumeState,
  CodexConversationSnapshot,
  CodexRendererConversationResumeResult,
  CodexThreadStreamCheckpoint,
} from "../../shared/types";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexPostResumeGoalRuntime } from "./CodexPostResumeGoalRuntime";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexConversationResumeInput {
  readonly threadId: string;
  readonly syncDormantConversationSnapshots?: boolean;
  readonly replayBufferedNotifications?: boolean;
}

export interface CodexConversationResumeDemand {
  readonly threadId: string;
  readonly syncDormantConversationSnapshots: boolean;
  readonly replayBufferedNotifications: boolean;
}

export class CodexConversationResumeError extends Data.TaggedError("CodexConversationResumeError")<{
  readonly cause: unknown;
}> {}

export interface CodexConversationResumeRendererState {
  readonly acceptedConversation: CodexConversationSnapshot | null;
  readonly checkpoint: CodexThreadStreamCheckpoint | null;
  readonly freshLaunchOwnerClientId: string | null;
  readonly ownerClientId: string | null;
  readonly resumeState: CodexConversationResumeState | null;
  readonly revision: number;
  readonly serializedConversation: CodexConversationSnapshot | null;
  readonly threadGeneration: number | null;
}

export class CodexConversationResumeRuntime extends Context.Service<
  CodexConversationResumeRuntime,
  {
    readonly resume: (
      input: CodexConversationResumeInput,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError>;
    readonly snapshot: (
      threadId: string,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError>;
    readonly resumeForRenderer: (
      threadId: string,
      ownerClientId: string,
    ) => Effect.Effect<CodexRendererConversationResumeResult | null, CodexConversationResumeError>;
    readonly releaseBuffer: (
      threadId: string,
    ) => Effect.Effect<boolean, CodexConversationResumeError>;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexConversationResumeRuntime") {}

interface ActiveResume {
  readonly token: object;
  readonly demand: CodexConversationResumeDemand;
}

const normalizeDemand = (input: CodexConversationResumeInput): CodexConversationResumeDemand => ({
  threadId: input.threadId,
  syncDormantConversationSnapshots: input.syncDormantConversationSnapshots !== false,
  replayBufferedNotifications: input.replayBufferedNotifications !== false,
});

const sameDemand = (
  left: CodexConversationResumeDemand,
  right: CodexConversationResumeDemand,
): boolean =>
  left.syncDormantConversationSnapshots === right.syncDormantConversationSnapshots &&
  left.replayBufferedNotifications === right.replayBufferedNotifications;

const invalidIdentity = (kind: "renderer client" | "Thread"): CodexConversationResumeError =>
  new CodexConversationResumeError({ cause: new Error(`${kind} identity is required`) });

const unavailableReplica = (
  threadId: string,
  role: "follower" | "owner" | "generation",
): CodexConversationResumeError =>
  new CodexConversationResumeError({
    cause: new Error(`Accepted ${role} replica is unavailable for '${threadId}'`),
  });

export const make: Effect.Effect<
  CodexConversationResumeRuntime["Service"],
  never,
  | CodexApplicationProtocol
  | CodexConversationRelationships
  | CodexFreshThreadLaunchRuntime
  | CodexOwnerNotificationDrainRuntime
  | CodexPostResumeGoalRuntime
  | CodexQueuedFollowUps
  | CodexRendererConversationCoordinator
  | CodexRendererConversationRegistry
  | CodexThreadDirectory
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const protocol = yield* CodexApplicationProtocol;
  const relationships = yield* CodexConversationRelationships;
  const freshThreadLaunch = yield* CodexFreshThreadLaunchRuntime;
  const ownerNotificationDrain = yield* CodexOwnerNotificationDrainRuntime;
  const postResumeGoals = yield* CodexPostResumeGoalRuntime;
  const queuedFollowUps = yield* CodexQueuedFollowUps;
  const rendererCoordinator = yield* CodexRendererConversationCoordinator;
  const rendererRegistry = yield* CodexRendererConversationRegistry;
  const threadDirectory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;

  const refreshRelationships = (threadId: string): Effect.Effect<void> =>
    relationships.refresh(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not refresh Codex conversation relationships").pipe(
          Effect.annotateLogs({ threadId, cause }),
        ),
      ),
      Effect.asVoid,
    );
  const resumes = yield* FiberMap.make<
    string,
    CodexConversationSnapshot | null,
    CodexConversationResumeError
  >();
  const runResume = yield* FiberMap.runtime(resumes)();
  const admission = yield* Semaphore.make(1);
  const rendererLanes = yield* RcMap.make({
    lookup: (_threadId: string) => Semaphore.make(1),
  });
  const active = new Map<string, ActiveResume>();

  const releasePhysical = Effect.fn("CodexConversationResumeRuntime.releaseBuffer")(function* (
    threadId: string,
  ) {
    yield* protocol.releaseResume(threadId);
    yield* ownerNotificationDrain.awaitCurrent(threadId);
    rendererCoordinator.reconcileOwnership(threadId);
    const revision = conversations.current(threadId)?.read().revision ?? 0;
    postResumeGoals.release(threadId, revision);
    return true;
  });

  const runPhysical = Effect.fn("CodexConversationResumeRuntime.runPhysical")(function* (
    demand: CodexConversationResumeDemand,
  ) {
    const threadId = demand.threadId.trim();
    if (!threadId) return yield* invalidIdentity("Thread");
    const aggregate = conversations.entity(threadId);
    const hydrateQueue = queuedFollowUps
      .read(threadId, { projectionTarget: "replica" })
      .pipe(Effect.mapError((cause) => new CodexConversationResumeError({ cause })));
    const current = aggregate.readSnapshot();
    if (current && (aggregate.readResumeState() !== "needs_resume" || aggregate.isStreaming())) {
      const hadBuffer = protocol.hasResume(threadId);
      if (demand.replayBufferedNotifications && hadBuffer) {
        yield* releasePhysical(threadId);
        const revision = aggregate.read().revision;
        if (!postResumeGoals.release(threadId, revision)) {
          postResumeGoals.request(threadId, revision);
        }
      }
      yield* hydrateQueue;
      return aggregate.readSnapshot();
    }

    const durable = yield* threadDirectory
      .resolve({ threadId, fidelity: "durable" })
      .pipe(Effect.mapError((cause) => new CodexConversationResumeError({ cause })));
    if (durable?.durable.archived) {
      const archived = yield* threadDirectory
        .resolve({ threadId, fidelity: "full" })
        .pipe(Effect.mapError((cause) => new CodexConversationResumeError({ cause })));
      const archivedAggregate = conversations.current(threadId);
      archivedAggregate?.setResumeState("needs_resume");
      yield* hydrateQueue;
      rendererCoordinator.reconcileOwnership(threadId);
      return archivedAggregate?.readSnapshot() ?? archived?.snapshot ?? null;
    }

    const ownsBuffer = protocol.beginResume(threadId);
    if (ownsBuffer) aggregate.setResumeState("resuming");
    const result = yield* threadDirectory.resolve({ threadId, fidelity: "live" }).pipe(
      Effect.mapError((cause) => new CodexConversationResumeError({ cause })),
      Effect.result,
    );
    if (result._tag === "Failure") {
      yield* protocol.discardResume(threadId, result.failure);
      postResumeGoals.clear(threadId);
      aggregate.setResumeState("needs_resume");
      aggregate.setStreamRole(null);
      aggregate.setStreaming(false);
      rendererCoordinator.reconcileOwnership(threadId);
      return yield* Effect.fail(result.failure);
    }

    const snapshot = result.success?.snapshot ?? aggregate.readSnapshot();
    if (!snapshot) {
      if (demand.replayBufferedNotifications) yield* releasePhysical(threadId);
      aggregate.setResumeState("needs_resume");
      rendererCoordinator.reconcileOwnership(threadId);
      return null;
    }
    aggregate.setResumeState("resumed");
    yield* hydrateQueue;
    if (demand.replayBufferedNotifications) {
      yield* releasePhysical(threadId);
      const revision = aggregate.read().revision;
      if (!postResumeGoals.release(threadId, revision)) {
        postResumeGoals.request(threadId, revision);
      }
    } else {
      postResumeGoals.defer(threadId);
    }
    return aggregate.readSnapshot() ?? snapshot;
  });

  const acquire = (demand: CodexConversationResumeDemand) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const current = active.get(demand.threadId);
        if (current) {
          const fiber = yield* FiberMap.get(resumes, demand.threadId);
          if (Option.isSome(fiber)) {
            return {
              fiber: fiber.value,
              compatible: sameDemand(current.demand, demand),
              joined: true,
            } as const;
          }
          active.delete(demand.threadId);
        }

        const token = {};
        active.set(demand.threadId, { token, demand });
        const physical = runPhysical(demand).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (active.get(demand.threadId)?.token === token) active.delete(demand.threadId);
            }),
          ),
        );
        const fiber = yield* FiberMap.run(resumes, demand.threadId, physical, {
          startImmediately: true,
        });
        return { fiber, compatible: true, joined: false } as const;
      }),
    );

  const runDemand = (
    demand: CodexConversationResumeDemand,
  ): Effect.Effect<
    { readonly result: CodexConversationSnapshot | null; readonly joined: boolean },
    CodexConversationResumeError
  > =>
    Effect.gen(function* () {
      let joined = false;
      for (;;) {
        const acquired = yield* acquire(demand);
        joined ||= acquired.joined;
        const result = yield* Fiber.join(acquired.fiber);
        if (acquired.compatible) return { result, joined };
        // A different demand must observe the completed canonical transition,
        // then run its own idempotent replay/projection upgrade.
      }
    });

  const resume = (
    input: CodexConversationResumeInput,
  ): Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError> =>
    Effect.gen(function* () {
      const demand = normalizeDemand(input);
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* runDemand(demand).pipe(Effect.result);
      const completedAt = yield* Clock.currentTimeMillis;
      if (outcome._tag === "Failure") {
        yield* Effect.logWarning("Could not resume Codex Thread").pipe(
          Effect.annotateLogs({
            threadId: demand.threadId,
            join: false,
            durationMs: Math.max(0, completedAt - startedAt),
            cause: String(outcome.failure.cause),
          }),
        );
        return yield* Effect.fail(outcome.failure);
      }
      yield* Effect.logDebug("Resumed Codex Thread").pipe(
        Effect.annotateLogs({
          threadId: demand.threadId,
          join: outcome.success.joined,
          durationMs: Math.max(0, completedAt - startedAt),
          hasSnapshot: outcome.success.result !== null,
        }),
      );
      if (outcome.success.result) {
        yield* refreshRelationships(demand.threadId);
      }
      return outcome.success.result;
    });

  const snapshot = (
    rawThreadId: string,
  ): Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError> => {
    const threadId = rawThreadId.trim();
    if (!threadId) return Effect.succeed(null);
    return threadDirectory.resolve({ threadId, fidelity: "durable" }).pipe(
      Effect.flatMap((entry) => {
        const conversation =
          entry?.snapshot ?? conversations.current(threadId)?.readSnapshot() ?? null;
        return conversation
          ? refreshRelationships(threadId).pipe(Effect.as(conversation))
          : Effect.succeed(null);
      }),
      Effect.mapError((cause) => new CodexConversationResumeError({ cause })),
    );
  };

  const runRendererSerial = <A>(
    threadId: string,
    operation: Effect.Effect<A, CodexConversationResumeError>,
  ): Effect.Effect<A, CodexConversationResumeError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(rendererLanes, threadId);
        return yield* lane.withPermit(operation);
      }),
    );

  const followerResult = (
    threadId: string,
    ownerClientId: string,
    state: CodexConversationResumeRendererState,
  ): Effect.Effect<CodexRendererConversationResumeResult | null, CodexConversationResumeError> => {
    if (!state.acceptedConversation) return Effect.succeed(null);
    if (!state.checkpoint) return Effect.fail(unavailableReplica(threadId, "follower"));
    if (state.threadGeneration === null) {
      return Effect.fail(unavailableReplica(threadId, "generation"));
    }
    return Effect.succeed({
      role: "follower",
      conversation: state.acceptedConversation,
      threadGeneration: state.threadGeneration,
      revision: state.revision,
      ownerClientId,
      checkpoint: state.checkpoint,
    });
  };

  const resumeForRenderer = (
    rawThreadId: string,
    rawOwnerClientId: string,
  ): Effect.Effect<CodexRendererConversationResumeResult | null, CodexConversationResumeError> => {
    const threadId = rawThreadId.trim();
    const ownerClientId = rawOwnerClientId.trim();
    if (!threadId) return Effect.fail(invalidIdentity("Thread"));
    if (!ownerClientId) return Effect.fail(invalidIdentity("renderer client"));

    return runRendererSerial(
      threadId,
      Effect.gen(function* () {
        const readRendererState = (): Effect.Effect<
          CodexConversationResumeRendererState,
          CodexConversationResumeError
        > =>
          snapshot(threadId).pipe(
            Effect.map((serializedConversation) => {
              const state = rendererCoordinator.readRendererState(threadId);
              return {
                ...state,
                freshLaunchOwnerClientId:
                  freshThreadLaunch.reservation(threadId)?.rendererClientId ?? null,
                serializedConversation,
              };
            }),
          );
        const before = yield* readRendererState();
        if (before.freshLaunchOwnerClientId && !before.ownerClientId) {
          if (before.freshLaunchOwnerClientId === ownerClientId) return null;
          return yield* followerResult(threadId, before.freshLaunchOwnerClientId, before);
        }
        if (before.ownerClientId && before.ownerClientId !== ownerClientId) {
          return yield* followerResult(threadId, before.ownerClientId, before);
        }
        if (rendererRegistry.isClientDisposed(ownerClientId)) {
          return yield* Effect.fail(
            new CodexConversationResumeError({
              cause: new Error(`Renderer client '${ownerClientId}' is unavailable`),
            }),
          );
        }

        const conversation =
          before.ownerClientId === ownerClientId && before.resumeState !== "needs_resume"
            ? (before.acceptedConversation ?? before.serializedConversation)
            : null;
        const resumed =
          conversation ??
          (yield* resume({
            threadId,
            syncDormantConversationSnapshots: false,
            replayBufferedNotifications: false,
          }));
        if (!resumed || resumed.resumeState !== "resumed") return null;

        const afterResume = yield* readRendererState();
        if (afterResume.ownerClientId && afterResume.ownerClientId !== ownerClientId) {
          return yield* followerResult(threadId, afterResume.ownerClientId, afterResume);
        }
        if (rendererRegistry.isClientDisposed(ownerClientId)) {
          return yield* Effect.fail(
            new CodexConversationResumeError({
              cause: new Error(
                `Renderer client '${ownerClientId}' became unavailable during resume`,
              ),
            }),
          );
        }

        const adoption = yield* rendererCoordinator.adoptRendererOwner({
          conversationId: threadId,
          ownerClientId,
        });
        if (adoption.ownerClientId !== ownerClientId) {
          return yield* Effect.fail(
            new CodexConversationResumeError({
              cause: new Error(
                `Renderer client '${ownerClientId}' could not adopt conversation '${threadId}'`,
              ),
            }),
          );
        }
        if (!adoption.checkpoint) {
          return yield* Effect.fail(unavailableReplica(threadId, "owner"));
        }
        if (adoption.threadGeneration === null) {
          return yield* Effect.fail(unavailableReplica(threadId, "generation"));
        }
        return {
          role: "owner",
          conversation: resumed,
          threadGeneration: adoption.threadGeneration,
          revision: adoption.revision,
          checkpoint: adoption.checkpoint,
        };
      }),
    );
  };

  const releaseBuffer = (
    rawThreadId: string,
  ): Effect.Effect<boolean, CodexConversationResumeError> => {
    const threadId = rawThreadId.trim();
    if (!threadId) return Effect.fail(invalidIdentity("Thread"));
    return runRendererSerial(threadId, releasePhysical(threadId));
  };

  const clear = (threadId: string): void => {
    active.delete(threadId);
    runResume(threadId, Effect.succeed(null));
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active.clear();
    }),
  );

  return CodexConversationResumeRuntime.of({
    resume,
    snapshot,
    resumeForRenderer,
    releaseBuffer,
    clear,
  });
});
