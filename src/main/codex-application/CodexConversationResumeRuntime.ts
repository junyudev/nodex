import type { CanonicalResumeOverrides } from "../../shared/codex-conversation-state/codex-resume-permissions";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ConversationResumePreparationOptions } from "../../shared/codex-conversation-state/codex-resume-request";
import { isDeepStrictEqual } from "node:util";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import type { CodexRendererResumePreparation } from "../../shared/codex-renderer-resume";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import type { CodexThreadSummary } from "../../shared/types";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexConversationRelationships } from "./CodexConversationRelationships";
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

export class CodexConversationResumeRuntime extends Context.Service<
  CodexConversationResumeRuntime,
  {
    readonly prepareRendererResume: (
      threadId: string,
      senderId: number,
      metadata?: Thread | null,
      overrides?: CanonicalResumeOverrides,
      options?: ConversationResumePreparationOptions,
    ) => Effect.Effect<CodexRendererResumePreparation, CodexConversationResumeError>;
    readonly observeRendererResume: (input: {
      senderId: number;
      requestId: string;
      hostId: string;
      params: unknown;
      response: ThreadResumeResponse;
    }) => Effect.Effect<void, CodexConversationResumeError>;
    readonly retryRendererResume: (
      receiptId: string,
      senderId: number,
    ) => Effect.Effect<string, CodexConversationResumeError>;
    readonly acceptRendererResume: (
      receiptId: string,
      senderId: number,
    ) => Effect.Effect<CodexThreadSummary, CodexConversationResumeError>;
    readonly releaseRendererResume: (receiptId: string, senderId: number) => void;
    readonly resume: (
      input: CodexConversationResumeInput,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError>;
    readonly snapshot: (
      threadId: string,
    ) => Effect.Effect<CodexConversationSnapshot | null, CodexConversationResumeError>;
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

export const make: Effect.Effect<
  CodexConversationResumeRuntime["Service"],
  never,
  | CodexConversationRelationships
  | CodexMainConversationResume
  | CodexThreadDirectory
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const relationships = yield* CodexConversationRelationships;
  const mainResume = yield* CodexMainConversationResume;
  const threadDirectory = yield* CodexThreadDirectory;
  const conversations = yield* ConversationEntityMap;
  const preparations = new Map<
    string,
    {
      senderId: number;
      preparation: CodexRendererResumePreparation;
      capability: Effect.Success<
        ReturnType<CodexThreadDirectory["Service"]["prepareResume"]>
      >["capability"];
      response?: ThreadResumeResponse;
      accepting?: boolean;
      accepted?: CodexThreadSummary;
    }
  >();
  const prepareRendererResume = (
    threadId: string,
    senderId: number,
    metadata?: Thread | null,
    overrides?: CanonicalResumeOverrides,
    options?: ConversationResumePreparationOptions,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* threadDirectory
        .prepareResume(threadId, metadata, overrides, options)
        .pipe(Effect.mapError((cause) => new CodexConversationResumeError({ cause })));
      const receiptId = crypto.randomUUID();
      const preparation: CodexRendererResumePreparation = {
        receiptId,
        nativeRequestId: `thread/resume:${crypto.randomUUID()}`,
        hostId: prepared.capability.hostId,
        generation: prepared.capability.generation,
        supportsPaginatedHistory: prepared.capability.flags.paginatedHistory,
        params: prepared.params,
        requestedCwd: prepared.requestedCwd,
        summary: prepared.summary,
      };
      preparations.set(receiptId, { senderId, preparation, capability: prepared.capability });
      return preparation;
    });
  const retryRendererResume = Effect.fn("CodexConversationResumeRuntime.retryRendererResume")(
    function* (receiptId: string, senderId: number) {
      const pending = preparations.get(receiptId);
      if (!pending || pending.senderId !== senderId || pending.accepting || pending.accepted)
        return yield* new CodexConversationResumeError({
          cause: new Error("Resume preparation is not available for another attempt"),
        });
      pending.preparation = {
        ...pending.preparation,
        nativeRequestId: `thread/resume:${crypto.randomUUID()}`,
      };
      delete pending.response;
      return pending.preparation.nativeRequestId;
    },
  );
  const observeRendererResume = (input: {
    senderId: number;
    requestId: string;
    hostId: string;
    params: unknown;
    response: ThreadResumeResponse;
  }) =>
    Effect.gen(function* () {
      const pending = [...preparations.values()].find(
        (entry) => entry.preparation.nativeRequestId === input.requestId,
      );
      if (!pending) return;
      if (
        pending.senderId !== input.senderId ||
        pending.preparation.hostId !== input.hostId ||
        !isDeepStrictEqual(pending.preparation.params, input.params) ||
        pending.preparation.params.threadId !== input.response.thread.id
      )
        return yield* new CodexConversationResumeError({
          cause: new Error("Prepared resume identity does not match native response"),
        });
      pending.response = input.response;
    });
  const acceptRendererResume = (receiptId: string, senderId: number) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const pending = preparations.get(receiptId);
        if (!pending || pending.senderId !== senderId || !pending.response)
          return yield* new CodexConversationResumeError({
            cause: new Error("No observed native resume for this receipt"),
          });
        if (pending.accepted) return pending.accepted;
        const response = pending.response;
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            pending.accepting = true;
          }),
          () =>
            threadDirectory
              .acceptRendererResume({
                threadId: pending.preparation.params.threadId,
                requestedCwd: pending.preparation.requestedCwd,
                response,
                capability: pending.capability,
              })
              .pipe(
                Effect.tap((summary) =>
                  Effect.sync(() => {
                    pending.accepted = summary;
                  }),
                ),
                Effect.mapError((cause) => new CodexConversationResumeError({ cause })),
              ),
          () =>
            Effect.sync(() => {
              pending.accepting = false;
            }),
        );
      }),
    );
  const releaseRendererResume = (receiptId: string, senderId: number) => {
    if (preparations.get(receiptId)?.senderId === senderId) preparations.delete(receiptId);
  };

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
  const active = new Map<string, ActiveResume>();

  const runPhysical = Effect.fn("CodexConversationResumeRuntime.runPhysical")(function* (
    demand: CodexConversationResumeDemand,
  ) {
    const threadId = demand.threadId.trim();
    if (!threadId) return yield* invalidIdentity("Thread");
    const result = yield* mainResume
      .resume(threadId)
      .pipe(Effect.mapError((cause) => new CodexConversationResumeError({ cause })));
    return result.status === "ready" ? result.snapshot : null;
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

  const clear = (threadId: string): void => {
    active.delete(threadId);
    for (const [receiptId, pending] of preparations)
      if (pending.preparation.params.threadId === threadId) preparations.delete(receiptId);
    runResume(threadId, Effect.succeed(null));
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active.clear();
      preparations.clear();
    }),
  );

  return CodexConversationResumeRuntime.of({
    prepareRendererResume,
    retryRendererResume,
    observeRendererResume,
    acceptRendererResume,
    releaseRendererResume,
    resume,
    snapshot,
    clear,
  });
});
