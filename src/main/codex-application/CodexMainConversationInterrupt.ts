import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  CodexServerRequestResponses,
  type CodexServerRequestResponseProjectionError,
} from "./CodexServerRequestResponses";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexNodeReplRuntime } from "./CodexNodeReplRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { interruptCanonicalConversationTurn } from "../../shared/codex-conversation-state/codex-conversation-interrupt";
import { mutateCodexBackgroundTerminalCleanup } from "../../shared/codex-conversation-state/codex-background-terminal-cleanup";

export type ConversationInterruptMode = "system" | "user-stop" | "descendant-cleanup";
export interface ConversationInterruptResult {
  readonly interruptedTurnId: string | null;
  readonly goalPauseError?: string;
}
export class CodexMainConversationInterrupt extends Context.Service<
  CodexMainConversationInterrupt,
  {
    readonly interrupt: (
      hostId: string,
      id: string,
      mode: ConversationInterruptMode,
      expectedTurnId?: string,
    ) => Effect.Effect<ConversationInterruptResult, MainConversationManagerError>;
  }
>()("nodex/main/codex-application/CodexMainConversationInterrupt") {}
const errorMessage = (error: unknown): string => {
  if (Schema.is(CodexRuntimeError)(error) && Schema.is(CodexAppServerRequestError)(error.cause))
    return error.cause.message;
  return error instanceof Error ? error.message : String(error);
};

export const make = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const entities = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const callbacks = yield* ScopedCallbackRuntime;
  const responses = yield* CodexServerRequestResponses;
  const subagents = yield* CodexSubagentDirectory;
  const repl = yield* CodexNodeReplRuntime;
  const events = yield* CodexApplicationEventHub;
  return CodexMainConversationInterrupt.of({
    interrupt: (hostId, id, mode, expectedTurnId) =>
      Effect.gen(function* () {
        const manager = yield* managers.get(hostId);
        const nativeGeneration = manager.generation;
        const entity = entities.current(id);
        const owner = manager.stream.getRole(id);
        const assertOwner = () => {
          manager.assertCurrent(nativeGeneration);
          if (
            !entity ||
            entities.current(id) !== entity ||
            entity.readCanonicalState()?.hostId !== hostId ||
            owner?.role !== "owner" ||
            manager.stream.getRole(id) !== owner
          )
            throw new Error("Conversation owner changed during interruption");
        };
        const check = Effect.try({
          try: assertOwner,
          catch: (cause) => new MainConversationManagerError({ hostId, cause }),
        });
        const isCurrent = () => {
          try {
            assertOwner();
            return true;
          } catch {
            return false;
          }
        };
        yield* check;
        const options = { expectedHostId: hostId, expectedGeneration: nativeGeneration };
        const pause = (critical = false) =>
          Effect.gen(function* () {
            yield* check;
            const result = yield* gateway.requestOnHost(
              hostId,
              "thread/goal/set",
              { threadId: id, status: "paused" },
              {
                ...options,
                ...(critical ? { priority: "critical" as const, timeoutMs: 500 } : {}),
              },
            );
            yield* check;
            entity?.mutateCanonicalState((draft) => {
              draft.threadGoal = result.goal as ThreadGoal | null;
              draft.threadGoalResumeConfirmation = null;
            }, Date.now());
          });
        const activeGoal =
          expectedTurnId == null && entity?.readCanonicalState()?.threadGoal?.status === "active";
        let goalPauseFailed = false;
        let interruptedTurnId: string | null = null;
        const operation = Effect.gen(function* () {
          if (activeGoal && mode === "system") yield* pause();
          if (activeGoal && mode === "user-stop") {
            const result = yield* pause(true).pipe(Effect.result);
            goalPauseFailed = result._tag === "Failure";
            if (result._tag === "Failure")
              yield* Effect.logWarning("Failed to pause thread goal before interrupt").pipe(
                Effect.annotateLogs({ threadId: id, cause: result.failure }),
              );
          }
          if (expectedTurnId == null) {
            yield* check;
            const pending = [...(entity?.readServerRequests() ?? [])];
            for (const request of pending) {
              const input = { threadId: id, requestId: request.id };
              const response: Effect.Effect<unknown, CodexServerRequestResponseProjectionError> =
                (() => {
                  switch (request.method) {
                    case "item/commandExecution/requestApproval":
                      return responses.approval({
                        ...input,
                        response: { kind: "command", decision: "decline" },
                      });
                    case "item/fileChange/requestApproval":
                      return responses.approval({
                        ...input,
                        response: { kind: "file", decision: "decline" },
                      });
                    case "item/permissions/requestApproval":
                      return responses.permission({
                        ...input,
                        response: { permissions: {}, scope: "turn" },
                      });
                    case "item/tool/requestUserInput":
                      return responses.userInput({ ...input, answers: {} });
                    case "item/tool/requestOptionPicker":
                      return responses.optionPicker({
                        ...input,
                        response: { action: "dismiss", selectedOptions: [], freeformAnswer: null },
                      });
                    case "mcpServer/elicitation/request":
                      return responses.mcpElicitation({ ...input, response: "decline" });
                    default:
                      return Effect.void;
                  }
                })();
              callbacks.fork(
                check.pipe(
                  Effect.andThen(response),
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to decline pending request during interrupt").pipe(
                      Effect.annotateLogs({ threadId: id, cause }),
                    ),
                  ),
                ),
              );
            }
          }
          interruptedTurnId = yield* Effect.tryPromise({
            try: () =>
              interruptCanonicalConversationTurn(
                {
                  getConversation: () => {
                    assertOwner();
                    return entity?.readCanonicalState() ?? undefined;
                  },
                  updateConversation: (_id, recipe) => {
                    assertOwner();
                    entity?.mutateCanonicalState(recipe, Date.now());
                  },
                  sendInterrupt: (threadId, turnId) =>
                    callbacks.runPromise(
                      check.pipe(
                        Effect.andThen(
                          gateway.requestOnHost(
                            hostId,
                            "turn/interrupt",
                            { threadId, turnId },
                            options,
                          ),
                        ),
                      ),
                    ),
                  cleanBackgroundTerminals: () =>
                    callbacks.runPromise(
                      Effect.gen(function* () {
                        yield* check;
                        yield* gateway.requestOnHost(
                          hostId,
                          "thread/backgroundTerminals/clean",
                          { threadId: id },
                          options,
                        );
                        yield* check;
                        entity?.mutateCanonicalState(
                          mutateCodexBackgroundTerminalCleanup,
                          Date.now(),
                          false,
                        );
                      }),
                    ),
                  killNodeReplExecutions: (sessionId, turnId) =>
                    isCurrent()
                      ? callbacks.runPromise(
                          repl.cleanup(hostId, sessionId, turnId, nativeGeneration),
                        )
                      : Promise.resolve(),
                  onInterruptStarted: () => {
                    if (isCurrent())
                      events.publish({ kind: "conversationTurnInterruptStarted", value: id });
                  },
                  errorMessage,
                  warn: (cause) => {
                    callbacks.fork(
                      Effect.logWarning(
                        "Failed to clean background terminals after interrupt",
                      ).pipe(Effect.annotateLogs({ threadId: id, cause })),
                    );
                  },
                },
                id,
                expectedTurnId,
                mode === "user-stop" && expectedTurnId == null,
              ),
            catch: (cause) => new MainConversationManagerError({ hostId, cause }),
          });
          yield* check;
          if (activeGoal && mode === "descendant-cleanup")
            yield* pause().pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to pause thread goal after interrupt").pipe(
                  Effect.annotateLogs({ threadId: id, cause }),
                ),
              ),
            );
          yield* check;
          if (goalPauseFailed && interruptedTurnId === null)
            return yield* new MainConversationManagerError({
              hostId,
              cause: new Error("Failed to pause thread goal"),
            });
          return {
            interruptedTurnId,
            ...(goalPauseFailed ? { goalPauseError: "Failed to pause thread goal" } : {}),
          };
        });
        return yield* operation.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (
                !isCurrent() ||
                (expectedTurnId != null && interruptedTurnId == null) ||
                mode === "descendant-cleanup" ||
                manager.stream.getRole(id)?.role === "follower"
              )
                return Effect.void;
              const cleanup = Effect.suspend(() =>
                isCurrent() ? subagents.settleInterruptedSubtree(id) : Effect.void,
              ).pipe(
                Effect.asVoid,
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to interrupt subagent descendants").pipe(
                    Effect.annotateLogs({ threadId: id, cause }),
                  ),
                ),
              );
              if (mode !== "user-stop") return cleanup;
              return Effect.sync(() => {
                callbacks.fork(cleanup);
              });
            }),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MainConversationManagerError
            ? cause
            : new MainConversationManagerError({ hostId, cause }),
        ),
      ),
  });
});
