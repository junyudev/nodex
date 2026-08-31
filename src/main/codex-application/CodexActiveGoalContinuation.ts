import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { resolveCodexReasoningSummary } from "../../shared/codex-reasoning-summary-policy";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export const DEFAULT_ACTIVE_GOAL_CONTINUATION_DELAY = "250 millis";

export class CodexActiveGoalContinuation extends Context.Service<
  CodexActiveGoalContinuation,
  {
    readonly request: (conversationId: string) => Effect.Effect<void>;
    readonly clear: (conversationId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexActiveGoalContinuation") {}

export const isCodexActiveGoalContinuationEligible = (
  conversation: ConversationEntityState | null,
): boolean => {
  if (!conversation || conversation.readResumeState() !== "resumed") return false;
  const snapshot = conversation.readSnapshot();
  const canonical = conversation.readCanonicalState();
  if (!snapshot || !canonical || snapshot.threadGoal?.status !== "active") return false;
  if (conversation.readServerRequests().length > 0) return false;
  if (snapshot.pendingSteers.length > 0) return false;
  if (conversation.readStreamRole() !== "owner" || !conversation.isStreaming()) return false;
  if (snapshot.statusType === "active" || snapshot.statusActiveFlags.length > 0) return false;
  return !canonical.turns.some(
    (turn) =>
      turn.protocol.status === "inProgress" ||
      turn.items.some(
        (item) => item.type === "collabAgentToolCall" && item.status === "inProgress",
      ),
  );
};

export const make: Effect.Effect<
  CodexActiveGoalContinuation["Service"],
  never,
  | CodexThreadGoalRuntime
  | CodexThreadSettingsRuntime
  | CodexSubagentDirectory
  | CodexApplicationEventHub
  | CodexTurnCommands
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const events = yield* CodexApplicationEventHub;
  const threadGoals = yield* CodexThreadGoalRuntime;
  const threadSettings = yield* CodexThreadSettingsRuntime;
  const subagents = yield* CodexSubagentDirectory;
  const turnCommands = yield* CodexTurnCommands;
  const continuations = yield* FiberMap.make<string, void, never>();
  const admission = yield* Semaphore.make(1);
  const pendingReruns = new Set<string>();

  const isEligible = (conversationId: string): boolean =>
    isCodexActiveGoalContinuationEligible(conversations.current(conversationId));

  const isSubagentTreeSettled = Effect.fn("CodexActiveGoalContinuation.isSubagentTreeSettled")(
    function* (conversationId: string) {
      const overview = yield* subagents.readOverview({
        rootThreadId: conversationId,
        mode: "initial",
      });
      return overview.completeness === "complete" && overview.active.knownCount === 0;
    },
  );

  const continueGoal = Effect.fn("CodexActiveGoalContinuation.continueGoal")(function* (
    conversationId: string,
  ) {
    if (!isEligible(conversationId)) return true;
    yield* threadSettings.awaitCurrent(conversationId);
    if (!isEligible(conversationId)) return true;
    if (!(yield* isSubagentTreeSettled(conversationId))) return false;
    if (!isEligible(conversationId)) return true;

    const snapshot = conversations.current(conversationId)?.readSnapshot();
    const summary = resolveCodexReasoningSummary({
      configuredSummary: snapshot?.latestThreadSettings?.summary,
    });
    if (snapshot?.latestThreadSettings?.summary !== summary) {
      yield* threadSettings.update({ threadId: conversationId, patch: { summary } });
    }
    if (!isEligible(conversationId)) return true;
    if (threadSettings.remoteUpdateSupport() === "unsupported") {
      yield* turnCommands.continueGoal(conversationId);
      return true;
    }
    yield* threadGoals.set({ threadId: conversationId, status: "active" });
    return true;
  });

  const runContinuation = (conversationId: string) =>
    Effect.gen(function* () {
      while (isEligible(conversationId)) {
        pendingReruns.delete(conversationId);
        yield* Effect.sleep(DEFAULT_ACTIVE_GOAL_CONTINUATION_DELAY);
        if (!isEligible(conversationId)) return;
        const finished = yield* continueGoal(conversationId);
        if (finished || !pendingReruns.has(conversationId)) return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to continue active Codex thread goal").pipe(
          Effect.annotateLogs({
            cause,
            conversationId,
          }),
        ),
      ),
    );

  const request = (conversationId: string) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        if (!isEligible(conversationId)) return;
        if (yield* FiberMap.has(continuations, conversationId)) return;
        yield* FiberMap.run(continuations, conversationId, runContinuation(conversationId), {
          startImmediately: true,
        });
      }),
    );

  yield* events.events.pipe(
    Stream.runForEach((event) => {
      if (event.kind !== "codex" || event.value.type !== "subagentOverviewInvalidated") {
        return Effect.void;
      }
      const conversationId = event.value.rootThreadId;
      pendingReruns.add(conversationId);
      return FiberMap.has(continuations, conversationId).pipe(
        Effect.flatMap((running) => (running ? Effect.void : request(conversationId))),
      );
    }),
    Effect.forkScoped,
  );

  return CodexActiveGoalContinuation.of({
    request,
    clear: (conversationId) =>
      Effect.sync(() => pendingReruns.delete(conversationId)).pipe(
        Effect.andThen(FiberMap.remove(continuations, conversationId)),
      ),
  });
});
