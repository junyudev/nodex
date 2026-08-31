import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import {
  extractCodexThreadSubagentMetadata,
  hasCodexSubagentSource,
} from "../../shared/codex-subagent-metadata";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

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

const latestInProgressTurnId = (
  conversations: ConversationEntityMap["Service"],
  threadId: string,
): string | null => {
  const turns = conversations.current(threadId)?.readCanonicalState()?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.protocol.status === "inProgress" && turn.protocol.id) return turn.protocol.id;
  }
  return null;
};

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
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const internalThreads = yield* CodexInternalThreadRegistry;
  const subagents = yield* CodexSubagentDirectory;
  const authority = yield* CodexTurnAuthority;
  const conversations = yield* ConversationEntityMap;
  const inheritedBySubagentThreadId = new Map<string, FrozenNodexAgentTurnAuthority>();

  yield* Effect.addFinalizer(() => Effect.sync(() => inheritedBySubagentThreadId.clear()));

  const logAuthorityFailure = (
    operation: "capture-parent" | "bind-started-turn" | "inherit-started-turn",
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
    const inherited = inheritedBySubagentThreadId.get(threadId);
    if (!inherited) {
      return authority
        .observeStarted(threadId, turnId)
        .pipe(
          Effect.catchCause((cause) => logAuthorityFailure("bind-started-turn", threadId, cause)),
        );
    }
    inheritedBySubagentThreadId.delete(threadId);
    return authority
      .inherit(threadId, turnId, inherited)
      .pipe(
        Effect.catchCause((cause) => logAuthorityFailure("inherit-started-turn", threadId, cause)),
      );
  };

  const observeStartedThread = (
    notification: Extract<CodexServerNotification, { method: "thread/started" }>,
  ): Effect.Effect<void> => {
    const thread = notification.params.thread;
    internalThreads.observeStarted(thread);

    const metadata = extractCodexThreadSubagentMetadata(thread);
    const isSubagent =
      metadata.parentThreadId !== null ||
      metadata.hasAnySubagentSource ||
      hasCodexSubagentSource(thread.source);
    if (!isSubagent) return Effect.void;

    const threadId = thread.id.trim();
    if (!threadId) return Effect.void;
    subagents.observe(threadId);
    const parentThreadId = metadata.parentThreadId;
    if (!parentThreadId || inheritedBySubagentThreadId.has(threadId)) return Effect.void;
    const parentTurnId = latestInProgressTurnId(conversations, parentThreadId);
    if (!parentTurnId) return Effect.void;

    return authority.capture(parentThreadId, parentTurnId).pipe(
      Effect.tap((parentAuthority) =>
        Effect.sync(() => {
          if (parentAuthority?.scope === "library") {
            inheritedBySubagentThreadId.set(threadId, parentAuthority);
          }
        }),
      ),
      Effect.catchCause((cause) => logAuthorityFailure("capture-parent", parentThreadId, cause)),
      Effect.asVoid,
    );
  };

  return CodexNotificationAdmission.of({
    decide: ({ notification, threadId }) =>
      Effect.gen(function* () {
        if (notification.method === "turn/started") yield* observeStartedTurn(notification);
        if (notification.method === "thread/started") yield* observeStartedThread(notification);

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
