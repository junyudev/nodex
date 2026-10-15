import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  extractCodexThreadSubagentMetadata,
  hasCodexSubagentSource,
} from "../../shared/codex-subagent-metadata";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CoreModules } from "../core-runtime/CoreModules";
import { readCodexLinkedRootSession } from "./CodexLinkedRootSession";

export type CodexNotificationAdmissionDecision =
  | { readonly _tag: "Admit" }
  | {
      readonly _tag: "Drop";
      readonly reason: "internal-thread" | "unopened-background-subagent-delta";
      readonly threadId: string;
    };

export interface CodexNotificationAdmissionInput {
  readonly notification: CodexServerNotification;
  readonly threadId: string | null;
  readonly hostId?: string;
}

export class CodexNotificationAdmission extends Context.Service<
  CodexNotificationAdmission,
  {
    /** Observes protocol authority and presentation identity before projection becomes visible. */
    readonly decide: (
      input: CodexNotificationAdmissionInput,
    ) => Effect.Effect<CodexNotificationAdmissionDecision>;
  }
>()("nodex/main/codex-application/CodexNotificationAdmission") {}

const admitted: CodexNotificationAdmissionDecision = { _tag: "Admit" };

/**
 * Owns notification preconditions that must commit in the same per-Thread causal lane before
 * durable or renderer-visible projection runs.
 */
export const make: Effect.Effect<
  CodexNotificationAdmission["Service"],
  never,
  | CodexInternalThreadRegistry
  | CodexSubagentDirectory
  | CodexTurnAuthority
  | CodexTurnPresentation
  | CoreModules
> = Effect.gen(function* () {
  const internalThreads = yield* CodexInternalThreadRegistry;
  const subagents = yield* CodexSubagentDirectory;
  const authority = yield* CodexTurnAuthority;
  const presentation = yield* CodexTurnPresentation;
  const core = yield* CoreModules;
  const logAuthorityFailure = (
    operation: "bind-started-turn",
    threadId: string,
    cause: unknown,
  ): Effect.Effect<void> =>
    Effect.logError("Failed to admit Codex Turn authority").pipe(
      Effect.annotateLogs({ operation, threadId, cause }),
    );

  const observeStartedTurn = (
    notification: Extract<CodexServerNotification, { method: "turn/started" }>,
  ): Effect.Effect<void> => {
    const threadId = notification.params.threadId;
    const turnId = notification.params.turn.id;
    return authority
      .observeStarted(threadId, turnId)
      .pipe(
        Effect.catchCause((cause) => logAuthorityFailure("bind-started-turn", threadId, cause)),
      );
  };

  const observeStartedThread = (
    notification: Extract<CodexServerNotification, { method: "thread/started" }>,
    linkedRoot: boolean,
  ): Effect.Effect<void> => {
    const thread = notification.params.thread;
    internalThreads.observeStarted(thread);
    if (linkedRoot) {
      internalThreads.observeLinkedRoot(thread.id);
      subagents.clear(thread.id);
      return Effect.void;
    }

    const metadata = extractCodexThreadSubagentMetadata(thread);
    const isSubagent =
      metadata.parentThreadId !== null ||
      metadata.hasAnySubagentSource ||
      hasCodexSubagentSource(thread.source);
    if (!isSubagent) return Effect.void;

    const threadId = thread.id.trim();
    if (!threadId) return Effect.void;
    subagents.observe(threadId);
    return Effect.void;
  };

  return CodexNotificationAdmission.of({
    decide: ({ notification, threadId, hostId }) =>
      Effect.gen(function* () {
        if (notification.method === "turn/started") {
          for (const item of notification.params.turn.items) {
            if (item.type !== "userMessage") continue;
            yield* presentation
              .observeUserMessage(
                notification.params.threadId,
                notification.params.turn.id,
                item.clientId,
              )
              .pipe(
                Effect.catchCause((cause) =>
                  logAuthorityFailure("bind-started-turn", notification.params.threadId, cause),
                ),
              );
          }
        }
        if (
          notification.method === "item/started" &&
          notification.params.item.type === "userMessage"
        ) {
          yield* presentation
            .observeUserMessage(
              notification.params.threadId,
              notification.params.turnId,
              notification.params.item.clientId,
            )
            .pipe(
              Effect.catchCause((cause) =>
                logAuthorityFailure("bind-started-turn", notification.params.threadId, cause),
              ),
            );
        }
        if (notification.method === "turn/completed") {
          presentation.finish(notification.params.threadId, notification.params.turn.id);
        }
        if (notification.method === "turn/started") yield* observeStartedTurn(notification);
        const started =
          notification.method === "thread/started" ? notification.params.thread : null;
        const hardInternal =
          started?.ephemeral ||
          started?.threadSource === "system" ||
          started?.threadSource === "composer_predictions" ||
          (started !== null &&
            extractCodexThreadSubagentMetadata(started).parentThreadId !== null) ||
          (threadId !== null && internalThreads.classification(threadId) === "structured-title");
        const sourceLabel =
          started?.threadSource === "subagent" ||
          (started !== null && hasCodexSubagentSource(started.source));
        const linked =
          hostId &&
          threadId &&
          !hardInternal &&
          (sourceLabel || internalThreads.shouldSuppress(threadId))
            ? yield* readCodexLinkedRootSession(core, { hostId, threadId }).pipe(
                Effect.catchCause(() => Effect.succeed(null)),
              )
            : null;
        const linkedRoot =
          linked !== null &&
          threadId !== null &&
          internalThreads.classification(threadId) !== "structured-title";
        if (linkedRoot && threadId !== null) {
          internalThreads.observeLinkedRoot(threadId);
          subagents.clear(threadId);
        }
        if (notification.method === "thread/started")
          yield* observeStartedThread(notification, linkedRoot);

        const suppressInternal = internalThreads.shouldSuppress(threadId);
        const closesThread =
          notification.method === "thread/closed" || notification.method === "thread/deleted";
        if (notification.method === "thread/deleted" && threadId) subagents.clear(threadId);
        if (suppressInternal && threadId) {
          const decision: CodexNotificationAdmissionDecision = {
            _tag: "Drop",
            reason: "internal-thread",
            threadId,
          };
          if (closesThread) internalThreads.clear(threadId);
          return decision;
        }
        if (subagents.shouldDropDelta(notification.method, threadId)) {
          return {
            _tag: "Drop",
            reason: "unopened-background-subagent-delta",
            threadId: threadId ?? "",
          };
        }
        return admitted;
      }),
  });
});
