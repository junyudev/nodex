import * as Context from "effect/Context";
import type { ConversationResumePreparationOptions } from "../../shared/codex-conversation-state/codex-resume-request";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Clock from "effect/Clock";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import {
  createCodexCanonicalHydratedConversationState,
  resolveCodexCanonicalHydratedCwd,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { allowsAutomaticResumeHistoryDrain } from "../../shared/codex-conversation-state/codex-history-resume";
import { conversationResumeRequestOptions } from "../../shared/codex-conversation-resume-retry";
import {
  projectCodexGatewayThreadReadThread,
  projectCodexGatewayThreadResumeResponse,
  projectCodexGatewayThreadResumeParams,
} from "../codex-runtime/CodexGatewayProtocolProjection";
import { requestMainConversationResume } from "./CodexConversationResumeRequest";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationHistory } from "./CodexMainConversationHistory";
import { CodexResumeIngress } from "./CodexResumeIngress";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
export class MainConversationResumeError extends Schema.TaggedError<MainConversationResumeError>()(
  "MainConversationResumeError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}
export type MainConversationResumeResult =
  | { readonly status: "ready"; readonly snapshot: CodexConversationSnapshot | null }
  | { readonly status: "not-ready"; readonly reason: "owner-recovering" | "canceled" };
export interface MainConversationResumeOptions extends ConversationResumePreparationOptions {
  readonly drainRemainingHistory?: boolean;
  readonly isReconnectRecovery?: boolean;
}
export class CodexMainConversationResume extends Context.Service<
  CodexMainConversationResume,
  {
    resume(
      threadId: string,
      options?: MainConversationResumeOptions,
    ): Effect.Effect<MainConversationResumeResult, MainConversationResumeError>;
  }
>()("nodex/main/codex-application/CodexMainConversationResume") {}
/** Ordinary Main resumes share peer ownership and native ingress ordering with windows. */
export const make = Effect.gen(function* () {
  const hosts = yield* CodexThreadHostResolver;
  const gateway = yield* CodexGateway;
  const scope = yield* Scope.Scope;
  const goalHydrations = new Map<string, object>();
  yield* Effect.addFinalizer(() => Effect.sync(() => goalHydrations.clear()));
  const managers = yield* CodexMainConversationManagers;
  const directory = yield* CodexThreadDirectory;
  const entities = yield* ConversationEntityMap;
  const ingress = yield* CodexResumeIngress;
  const history = yield* CodexMainConversationHistory;
  const lanes = yield* RcMap.make({ lookup: (_threadId: string) => Semaphore.make(1) });
  return CodexMainConversationResume.of({
    resume: (threadId, options = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* RcMap.get(lanes, threadId);
          const requestOptions = conversationResumeRequestOptions(
            options.isReconnectRecovery === true,
          );
          return yield* lane.withPermit(
            Effect.scoped(
              Effect.gen(function* () {
                const durable = yield* directory.resolve({ threadId, fidelity: "durable" });
                if (durable?.durable.archived)
                  return {
                    status: "ready",
                    snapshot:
                      (yield* directory.resolve({ threadId, fidelity: "tail" }))?.snapshot ?? null,
                  } as const;
                const hostId = yield* hosts.resolve(threadId);
                const manager = yield* managers.get(hostId);
                const nativeGeneration = manager.generation;
                const entity = entities.entity(threadId);
                let invalidated = false;
                let retiringEntity = false;
                const assertNative = () => {
                  manager.assertCurrent(nativeGeneration);
                  if (invalidated || entities.current(threadId) !== entity)
                    throw new Error("Conversation retired during resume");
                };
                const checkCurrent = Effect.try(assertNative);
                const initialRole = manager.stream.getRole(threadId);
                if (initialRole?.role === "follower" && entity.readResumeState() !== "resumed")
                  return { status: "not-ready", reason: "owner-recovering" } as const;
                if (
                  initialRole &&
                  entity.readCanonicalState() &&
                  entity.readResumeState() !== "needs_resume"
                )
                  return { status: "ready", snapshot: entity.readSnapshot() } as const;
                let connectionListener: Disposable | undefined;
                let retirementListener: Disposable | undefined;
                const retired = Effect.callback<never, MainConversationResumeError>((resume) => {
                  const retireAttempt = () => {
                    invalidated = true;
                    resume(
                      Effect.fail(
                        new MainConversationResumeError({
                          threadId,
                          cause: new Error("Conversation retired during resume"),
                        }),
                      ),
                    );
                  };
                  connectionListener = manager.onConnectionReset(retireAttempt);
                  retirementListener = entities.subscribeRetired((id, generation) => {
                    if (!retiringEntity && id === threadId && generation === entity.generation)
                      retireAttempt();
                  });
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      retirementListener?.[Symbol.dispose]();
                      connectionListener?.[Symbol.dispose]();
                    }),
                  ),
                );
                let ownsBuffer = false;
                let acquiredRole = false;
                let completed = false;
                yield* Effect.addFinalizer(() =>
                  !completed
                    ? (ownsBuffer
                        ? ingress.discard(threadId, new Error("Resume interrupted"))
                        : Effect.void
                      ).pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            if (
                              invalidated ||
                              entities.current(threadId) !== entity ||
                              managers.current(hostId) !== manager ||
                              manager.generation !== nativeGeneration ||
                              manager.stream.getRole(threadId)?.role === "follower"
                            )
                              return;
                            entity.setResumeState("needs_resume");
                            entity.setStreaming(false);
                            if (
                              acquiredRole &&
                              managers.current(hostId) === manager &&
                              manager.generation === nativeGeneration &&
                              manager.stream.getRole(threadId)?.role === "owner"
                            )
                              manager.stream.setRole(threadId, null);
                          }),
                        ),
                      )
                    : Effect.void,
                );
                const prepareAndResume = Effect.gen(function* () {
                  yield* checkCurrent;
                  manager.stream.setFollowing(threadId, true);
                  const metadataRead = yield* gateway
                    .requestOnHost(
                      hostId,
                      "thread/read",
                      {
                        threadId,
                        includeTurns: false,
                      },
                      {
                        source: "thread_hydration",
                        priority: requestOptions.priority,
                        timeoutMs: 30_000,
                        expectedHostId: hostId,
                        expectedGeneration: nativeGeneration,
                      },
                    )
                    .pipe(
                      Effect.map((response) =>
                        projectCodexGatewayThreadReadThread(response.thread),
                      ),
                      Effect.catch((cause) =>
                        Effect.logWarning("Failed to read thread metadata before resume").pipe(
                          Effect.annotateLogs({ threadId, cause }),
                          Effect.as(null),
                        ),
                      ),
                      Effect.forkChild({ startImmediately: true }),
                    );
                  const workspace = yield* directory.prepareHistoryHydration(threadId);
                  yield* checkCurrent;
                  ownsBuffer = ingress.begin(threadId, { hostId, generation: nativeGeneration });
                  if (!ownsBuffer)
                    return yield* new MainConversationResumeError({
                      threadId,
                      cause: new Error("Conversation resume is already buffering native events"),
                    });
                  entity.setResumeState("resuming");
                  const metadata = yield* Fiber.join(metadataRead);
                  yield* checkCurrent;
                  if (metadata && metadata.id !== threadId)
                    return yield* new MainConversationResumeError({
                      threadId,
                      cause: new Error("Resume metadata belongs to another thread"),
                    });
                  if (metadata && !entity.readCanonicalState()) {
                    const cwd =
                      resolveCodexCanonicalHydratedCwd({
                        requestedCwd: workspace.context.cwd,
                        responseCwd: null,
                        threadCwd: metadata.cwd,
                        fallbackCwd: workspace.context.cwd,
                      }) ?? "/";
                    entity.acceptCanonicalState({
                      ...createCodexCanonicalHydratedConversationState(
                        { ...metadata, cwd },
                        { ...workspace.context, cwd },
                      ),
                      resumeState: "resuming",
                    });
                  }
                  const prepared = yield* directory.prepareResume(
                    threadId,
                    metadata,
                    undefined,
                    options,
                  );
                  yield* checkCurrent;
                  if (
                    prepared.capability.hostId !== hostId ||
                    prepared.capability.generation !== nativeGeneration
                  )
                    return yield* new MainConversationResumeError({
                      threadId,
                      cause: new Error("Resume preparation belongs to another native connection"),
                    });
                  const role = manager.stream.getRole(threadId);
                  if (role?.role === "follower") {
                    if (entity.readResumeState() === "resuming") entity.setResumeState("resumed");
                    return { entry: null, followed: true, drainRemainingHistory: false };
                  }
                  if (!role) {
                    manager.stream.setRole(threadId, { role: "owner" });
                    acquiredRole = true;
                  }
                  const environmentSelectionEvidenceAtDispatch =
                    entity.readCanonicalState()?.environmentSelectionEvidence;
                  const response = yield* requestMainConversationResume(
                    gateway,
                    hostId,
                    projectCodexGatewayThreadResumeParams(prepared.params),
                    {
                      source: "thread_hydration",
                      ...requestOptions,
                      expectedHostId: hostId,
                      expectedGeneration: nativeGeneration,
                    },
                  );
                  yield* checkCurrent;
                  if (response.thread.id !== threadId)
                    return yield* new MainConversationResumeError({
                      threadId,
                      cause: new Error("Resume returned another thread"),
                    });
                  const entry = yield* directory.acceptResumeResult({
                    response: projectCodexGatewayThreadResumeResponse(response),
                    requestedCwd: prepared.requestedCwd,
                    environmentSelectionEvidenceAtDispatch,
                    permissionContext: prepared.permissionContext,
                    requestOptions: {
                      source: "thread_hydration",
                      priority: requestOptions.priority,
                    },
                    ...(hostId === "durable"
                      ? {}
                      : {
                          historyMode:
                            prepared.params.initialTurnsPage == null
                              ? ("paginated" as const)
                              : ("legacy" as const),
                        }),
                    capability: prepared.capability,
                    executionHostId: hostId,
                    fallbackCwd: prepared.requestedCwd ?? workspace.context.cwd ?? "/",
                  });
                  yield* checkCurrent;
                  return {
                    entry,
                    followed: false,
                    drainRemainingHistory: allowsAutomaticResumeHistoryDrain({
                      hostId,
                      tailHydration: prepared.params.excludeTurns === true,
                      paginated: hostId !== "durable" && prepared.params.initialTurnsPage == null,
                      requested: options.drainRemainingHistory !== false,
                      reconnectRecovery: options.isReconnectRecovery === true,
                      suppressed: prepared.capability.flags.paginatedHistory,
                    }),
                  };
                });
                const finishResume = Effect.gen(function* () {
                  const result = yield* prepareAndResume;
                  yield* checkCurrent;
                  if (result.followed) {
                    const remove = yield* ingress.release(threadId, entity.readCanonicalState());
                    ownsBuffer = false;
                    yield* checkCurrent;
                    completed = true;
                    if (remove) {
                      retiringEntity = true;
                      yield* entities.retire(threadId);
                      return { status: "not-ready", reason: "canceled" } as const;
                    }
                    return { status: "ready", snapshot: entity.readSnapshot() } as const;
                  }
                  const goalBefore = entity.readCanonicalState()?.threadGoal;
                  const hydration = {};
                  const historyDrainReady = yield* Deferred.make<boolean>();
                  yield* Effect.addFinalizer(() => Deferred.succeed(historyDrainReady, false));
                  goalHydrations.set(threadId, hydration);
                  const goalDisposal = manager.onConnectionReset(() => {
                    if (goalHydrations.get(threadId) === hydration) goalHydrations.delete(threadId);
                  });
                  yield* Effect.gen(function* () {
                    const result = yield* gateway
                      .requestOnHost(
                        hostId,
                        "thread/goal/get",
                        { threadId },
                        {
                          ...(options.isReconnectRecovery === true
                            ? {
                                source: "thread_hydration" as const,
                                priority: requestOptions.priority,
                              }
                            : {}),
                          expectedHostId: hostId,
                          expectedGeneration: nativeGeneration,
                        },
                      )
                      .pipe(Effect.result);
                    if (result._tag === "Failure") {
                      yield* Effect.logWarning("Failed to hydrate thread goal after resume").pipe(
                        Effect.annotateLogs({ threadId, cause: result.failure }),
                      );
                    }
                    // Goal I/O may finish during ingress replay. Admission waits for publication.
                    const drainRemainingHistory = yield* Deferred.await(historyDrainReady);
                    yield* Effect.yieldNow;
                    if (
                      !completed ||
                      invalidated ||
                      goalHydrations.get(threadId) !== hydration ||
                      managers.current(hostId) !== manager ||
                      manager.generation !== nativeGeneration ||
                      entities.current(threadId) !== entity
                    )
                      return;
                    if (
                      result._tag === "Success" &&
                      entity.readCanonicalState()?.threadGoal === goalBefore
                    ) {
                      const now = yield* Clock.currentTimeMillis;
                      entity.mutateCanonicalState((draft) => {
                        draft.threadGoal = result.success.goal
                          ? {
                              ...result.success.goal,
                              tokenBudget: result.success.goal.tokenBudget ?? null,
                            }
                          : null;
                        draft.threadGoalResumeConfirmation = null;
                      }, now);
                    }
                    goalHydrations.delete(threadId);
                    if (!drainRemainingHistory) return;
                    yield* history
                      .loadComplete(hostId, threadId)
                      .pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning(
                            "Failed to load remaining thread turns after resume",
                          ).pipe(Effect.annotateLogs({ threadId, cause })),
                        ),
                      );
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        goalDisposal[Symbol.dispose]();
                        if (goalHydrations.get(threadId) === hydration)
                          goalHydrations.delete(threadId);
                      }),
                    ),
                    Effect.forkIn(scope, { startImmediately: true }),
                  );
                  const retire = yield* ingress.release(threadId, entity.readCanonicalState());
                  ownsBuffer = false;
                  yield* checkCurrent;
                  completed = true;
                  if (retire) {
                    retiringEntity = true;
                    yield* entities.retire(threadId);
                    return { status: "not-ready", reason: "canceled" } as const;
                  }
                  entity.setResumeState(entity.readCanonicalState() ? "resumed" : "needs_resume");
                  manager.stream.setRole(threadId, { role: "owner" });
                  manager.stream.broadcastSnapshot(threadId);
                  yield* Deferred.succeed(
                    historyDrainReady,
                    result.drainRemainingHistory &&
                      entity.readCanonicalState()?.turnsPagination?.olderCursor != null,
                  );
                  return {
                    status: "ready",
                    snapshot: entity.readSnapshot() ?? result.entry?.snapshot ?? null,
                  } as const;
                });
                return yield* Effect.raceFirst(retired, finishResume);
              }),
            ),
          );
        }),
      ).pipe(Effect.mapError((cause) => new MainConversationResumeError({ threadId, cause }))),
  });
});
