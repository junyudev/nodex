import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexThreadSummary } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexConversationArchive,
  type CodexConversationArchiveError,
} from "./CodexConversationArchive";
import {
  CodexConversationProjection,
  type CodexConversationProjectionError,
} from "./CodexConversationProjection";
import {
  CodexServerRequestResponses,
  type CodexServerRequestResponseProjectionError,
} from "./CodexServerRequestResponses";
import { type CodexThreadGoalError, CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadDirectory, CodexThreadDirectoryError } from "./CodexThreadDirectory";
import { CodexSubagentDirectory, CodexSubagentDirectoryError } from "./CodexSubagentDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type BackgroundTerminal =
  ClientRequestResponsesByMethod["thread/backgroundTerminals/list"]["data"][number];

type ConversationCommandsError =
  | CodexRuntimeError
  | CodexConversationArchiveError
  | CodexConversationProjectionError
  | CodexServerRequestResponseProjectionError
  | CodexSubagentDirectoryError
  | CodexThreadDirectoryError
  | CodexThreadGoalError;

type ConversationThreadCommandError = CodexRuntimeError | CodexThreadDirectoryError;

const INTERRUPT_TOTAL_DEADLINE_MS = 5_000;
const INTERRUPT_SUBTREE_HEADROOM_MS = 250;

export class ConversationCommands extends Context.Service<
  ConversationCommands,
  {
    readonly archive: (threadId: string) => Effect.Effect<boolean, CodexConversationArchiveError>;
    readonly deleteArchived: (
      threadId: string,
    ) => Effect.Effect<boolean, CodexConversationArchiveError>;
    readonly unarchive: (
      threadId: string,
    ) => Effect.Effect<CodexThreadSummary | null, CodexConversationArchiveError>;
    readonly setMemoryMode: (
      threadId: string,
      mode: ClientRequestParamsByMethod["thread/memoryMode/set"]["mode"],
    ) => Effect.Effect<void, ConversationThreadCommandError>;
    readonly startReview: (
      params: ClientRequestParamsByMethod["review/start"],
    ) => Effect.Effect<
      ClientRequestResponsesByMethod["review/start"],
      ConversationThreadCommandError
    >;
    readonly uploadFeedback: (
      params: ClientRequestParamsByMethod["feedback/upload"],
    ) => Effect.Effect<void, CodexRuntimeError>;
    readonly listBackgroundTerminals: (
      threadId: string,
    ) => Effect.Effect<readonly BackgroundTerminal[], ConversationThreadCommandError>;
    readonly listBackgroundTerminalsPage: (
      threadId: string,
      options?: { readonly cursor?: string | null; readonly limit?: number },
    ) => Effect.Effect<
      ClientRequestResponsesByMethod["thread/backgroundTerminals/list"],
      ConversationThreadCommandError
    >;
    readonly terminateBackgroundTerminal: (
      threadId: string,
      processId: string,
    ) => Effect.Effect<boolean, ConversationThreadCommandError>;
    readonly interrupt: (
      threadId: string,
      turnId?: string,
    ) => Effect.Effect<boolean, ConversationCommandsError>;
    readonly cleanBackgroundTerminals: (
      threadId: string,
    ) => Effect.Effect<boolean, ConversationCommandsError>;
    readonly cleanBackgroundTerminalsSilently: (
      threadId: string,
    ) => Effect.Effect<boolean, ConversationCommandsError>;
  }
>()("nodex/main/codex-application/ConversationCommands") {}

export const live: Layer.Layer<
  ConversationCommands,
  never,
  | CodexConversationArchive
  | CodexConversationProjection
  | CodexGateway
  | CodexServerRequestResponses
  | CodexSubagentDirectory
  | CodexThreadDirectory
  | CodexThreadGoalRuntime
  | ConversationEntityMap
> = Layer.effect(
  ConversationCommands,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const archive = yield* CodexConversationArchive;
    const conversations = yield* ConversationEntityMap;
    const serverRequestResponses = yield* CodexServerRequestResponses;
    const projection = yield* CodexConversationProjection;
    const subagents = yield* CodexSubagentDirectory;
    const directory = yield* CodexThreadDirectory;
    const threadGoals = yield* CodexThreadGoalRuntime;

    const runSerial = <A, E>(threadId: string, operation: Effect.Effect<A, E>) =>
      conversations.runCommand(threadId, operation);
    const requireCodexThread = (threadId: string) =>
      directory.resolve({ threadId, fidelity: "durable" }).pipe(
        Effect.flatMap((entry) =>
          entry
            ? Effect.void
            : Effect.fail(
                new CodexThreadDirectoryError({
                  operation: "read",
                  threadId,
                  cause: new Error(`Thread '${threadId}' is not owned by the Codex backend`),
                }),
              ),
        ),
      );
    const listBackgroundTerminalsPage = (
      threadId: string,
      options?: { readonly cursor?: string | null; readonly limit?: number },
    ) =>
      gateway.requestForThread(threadId, "thread/backgroundTerminals/list", {
        threadId,
        cursor: options?.cursor ?? null,
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
      });
    const listBackgroundTerminals = (
      threadId: string,
      cursor: string | null = null,
      collected: readonly BackgroundTerminal[] = [],
    ): Effect.Effect<readonly BackgroundTerminal[], CodexRuntimeError> =>
      listBackgroundTerminalsPage(threadId, { cursor, limit: 100 }).pipe(
        Effect.flatMap((response) => {
          const next = [...collected, ...response.data];
          return response.nextCursor
            ? listBackgroundTerminals(threadId, response.nextCursor, next)
            : Effect.succeed(next);
        }),
      );
    const pauseActiveGoal = (threadId: string) =>
      threadGoals
        .get(threadId)
        .pipe(
          Effect.flatMap((goal) =>
            goal?.status === "active"
              ? threadGoals
                  .set({ threadId, status: "paused", dismissResumeConfirmation: true })
                  .pipe(Effect.asVoid)
              : Effect.void,
          ),
        );
    const interruptInLane = (
      threadId: string,
      turnId?: string,
      settleSubtree = true,
      subtreeDeadlineAtMs?: number,
    ): Effect.Effect<boolean, ConversationCommandsError> =>
      Effect.gen(function* () {
        const resolvedTurnId = yield* projection.resolveInterruptTurn(threadId, turnId);
        yield* pauseActiveGoal(threadId);
        yield* serverRequestResponses.declineAllInTransaction(threadId);
        yield* Effect.logWarning("Interrupting Codex Turn").pipe(
          Effect.annotateLogs({ threadId, requestedTurnId: turnId ?? null, resolvedTurnId }),
        );
        yield* gateway.requestForThread(threadId, "turn/interrupt", {
          threadId,
          turnId: resolvedTurnId,
        });
        const observedAtMs = yield* Clock.currentTimeMillis;
        yield* projection
          .commitInterruptedTurn({ threadId, turnId: resolvedTurnId, observedAtMs })
          .pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to reconcile an accepted Turn interruption").pipe(
                Effect.annotateLogs({ threadId, turnId: resolvedTurnId, cause }),
              ),
            ),
          );
        if (settleSubtree) {
          const subtree = yield* subagents.settleInterruptedSubtree(
            threadId,
            subtreeDeadlineAtMs === undefined ? undefined : { deadlineAtMs: subtreeDeadlineAtMs },
          );
          if (
            !subtree.discoveryComplete ||
            subtree.failed.length > 0 ||
            subtree.unresolvedThreadIds.length > 0
          ) {
            return yield* new CodexSubagentDirectoryError({
              operation: "lifecycle",
              rootThreadId: threadId,
              cause: new Error(
                `Subagent interruption left ${subtree.failed.length} failed, ${subtree.unresolvedThreadIds.length} unresolved descendants, and discovery ${subtree.discoveryComplete ? "complete" : "incomplete"}`,
              ),
            });
          }
        }
        return true;
      });

    return ConversationCommands.of({
      archive: (threadId) =>
        runSerial(threadId, archive.archive(threadId)).pipe(
          Effect.tap((archived) => (archived ? conversations.retire(threadId) : Effect.void)),
        ),
      deleteArchived: (threadId) =>
        runSerial(threadId, archive.deleteArchived(threadId)).pipe(
          Effect.tap((deleted) => (deleted ? conversations.retire(threadId) : Effect.void)),
        ),
      unarchive: (threadId) => runSerial(threadId, archive.unarchive(threadId)),
      setMemoryMode: (threadId, mode) =>
        requireCodexThread(threadId).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              gateway
                .requestForThread(threadId, "thread/memoryMode/set", { threadId, mode })
                .pipe(Effect.asVoid),
            ),
          ),
        ),
      startReview: (params) =>
        requireCodexThread(params.threadId).pipe(
          Effect.andThen(
            Effect.suspend(() => gateway.requestForThread(params.threadId, "review/start", params)),
          ),
        ),
      uploadFeedback: (params) =>
        gateway.requestLocal("feedback/upload", params).pipe(Effect.asVoid),
      listBackgroundTerminalsPage: (threadId, options) =>
        requireCodexThread(threadId.trim()).pipe(
          Effect.andThen(
            Effect.suspend(() => listBackgroundTerminalsPage(threadId.trim(), options)),
          ),
        ),
      listBackgroundTerminals: (threadId) =>
        requireCodexThread(threadId.trim()).pipe(
          Effect.andThen(Effect.suspend(() => listBackgroundTerminals(threadId.trim()))),
        ),
      terminateBackgroundTerminal: (threadId, processId) =>
        requireCodexThread(threadId).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              gateway
                .requestForThread(threadId, "thread/backgroundTerminals/terminate", {
                  threadId,
                  processId,
                })
                .pipe(Effect.map((response) => response.terminated)),
            ),
          ),
        ),
      interrupt: (threadId, turnId) =>
        requireCodexThread(threadId).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const startedAtMs = yield* Clock.currentTimeMillis;
              return yield* runSerial(
                threadId,
                interruptInLane(
                  threadId,
                  turnId,
                  true,
                  startedAtMs + INTERRUPT_TOTAL_DEADLINE_MS - INTERRUPT_SUBTREE_HEADROOM_MS,
                ),
              );
            }),
          ),
          Effect.timeoutOrElse({
            duration: `${INTERRUPT_TOTAL_DEADLINE_MS} millis`,
            orElse: () =>
              Effect.fail(
                new CodexSubagentDirectoryError({
                  operation: "lifecycle",
                  rootThreadId: threadId,
                  cause: new Error("Thread and Subagent interruption exceeded five seconds"),
                }),
              ),
          }),
        ),
      cleanBackgroundTerminals: (threadId) =>
        requireCodexThread(threadId).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              runSerial(
                threadId,
                projection.backgroundTerminalTurnIds(threadId).pipe(
                  Effect.flatMap((turnIds) => {
                    if (turnIds === null) return Effect.succeed(false);
                    if (turnIds.length === 0) return Effect.succeed(true);
                    return Effect.forEach(
                      turnIds,
                      (turnId) => interruptInLane(threadId, turnId, false),
                      { discard: true },
                    ).pipe(Effect.as(true));
                  }),
                ),
              ),
            ),
          ),
        ),
      cleanBackgroundTerminalsSilently: (threadId) =>
        requireCodexThread(threadId).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              runSerial(
                threadId,
                gateway
                  .requestForThread(threadId, "thread/backgroundTerminals/clean", { threadId })
                  .pipe(
                    Effect.andThen(
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((observedAtMs) =>
                          projection.backgroundTerminalsCleaned(threadId, observedAtMs),
                        ),
                      ),
                    ),
                    Effect.as(true),
                  ),
              ),
            ),
          ),
        ),
    });
  }),
);
