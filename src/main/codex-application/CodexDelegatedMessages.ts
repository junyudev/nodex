import { isSteerTurnInactiveError } from "../../shared/codex-steer-errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ConversationFollowerRequest } from "../../shared/codex-client-coordination";
import { latestConversationTurn } from "../../shared/codex-conversation-state/codex-turn-selectors";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexTurnCommands, type CodexTurnStartOverrides } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
export class DelegatedMessageError extends Schema.TaggedError<DelegatedMessageError>()(
  "DelegatedMessageError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}
export class CodexDelegatedMessages extends Context.Service<
  CodexDelegatedMessages,
  {
    send(
      threadId: string,
      sourceThreadId: string,
      prompt: string,
      overrides?: CodexTurnStartOverrides,
    ): Effect.Effect<void, DelegatedMessageError>;
  }
>()("nodex/main/codex-application/CodexDelegatedMessages") {}
export const make = Effect.gen(function* () {
  const resume = yield* CodexMainConversationResume;
  const managers = yield* CodexMainConversationManagers;
  const hosts = yield* CodexThreadHostResolver;
  const turns = yield* CodexTurnCommands;
  const entities = yield* ConversationEntityMap;
  return CodexDelegatedMessages.of({
    send: (threadId, sourceThreadId, prompt, overrides) =>
      Effect.gen(function* () {
        const resumed = yield* resume.resume(threadId, { serviceTier: overrides?.serviceTier });
        if (resumed.status === "not-ready")
          return yield* new DelegatedMessageError({
            threadId,
            cause: new Error(`Conversation is not ready: ${resumed.reason}`),
          });
        const hostId = yield* hosts.resolve(threadId);
        const manager = yield* managers.get(hostId);
        const generation = manager.generation;
        const entity = entities.current(threadId);
        const role = manager.stream.getRole(threadId);
        const readCurrent = Effect.try({
          try: () => {
            manager.assertCurrent(generation);
            if (
              !entity ||
              entities.current(threadId) !== entity ||
              !role ||
              manager.stream.getRole(threadId) !== role
            )
              throw new Error("Delegated message conversation ownership changed");
            const state = entity.readCanonicalState();
            if (!state) throw new Error("Delegated message conversation is unavailable");
            return state;
          },
          catch: (cause) => new DelegatedMessageError({ threadId, cause }),
        });
        const dispatch = Effect.fn("CodexDelegatedMessages.dispatch")(function* (
          request: ConversationFollowerRequest,
        ) {
          yield* readCurrent;
          if (role?.role === "follower") {
            const result = yield* Effect.tryPromise(() =>
              manager.coordination.requestThreadFollower({
                hostId,
                request,
                targetClientId: role.ownerClientId,
              }),
            );
            yield* readCurrent;
            if (result.resultType === "error")
              return yield* Effect.fail(
                new DelegatedMessageError({ threadId, cause: new Error(result.error) }),
              );
            return;
          }
          if (role?.role !== "owner")
            return yield* Effect.fail(
              new DelegatedMessageError({
                threadId,
                cause: new Error("Conversation has no owner"),
              }),
            );
          yield* managers.dispatchFollowerRequest(hostId, request);
          yield* readCurrent;
        });
        const state = yield* readCurrent;
        if (overrides?.model != null || overrides?.reasoningEffort !== undefined) {
          const model = overrides?.model ?? state?.latestModel;
          if (!model?.trim())
            return yield* new DelegatedMessageError({
              threadId,
              cause: new Error("Cannot set reasoning without a thread model."),
            });
          yield* dispatch({
            method: "thread-follower-update-thread-settings",
            params: {
              conversationId: threadId,
              threadSettings: {
                model,
                effort:
                  overrides?.reasoningEffort === undefined
                    ? (state?.latestReasoningEffort ?? null)
                    : overrides.reasoningEffort,
              },
            },
          });
        }
        const active = latestConversationTurn(yield* readCurrent)?.status === "inProgress";
        let prepared = yield* turns.prepareNativeToolMessage(
          threadId,
          sourceThreadId,
          prompt,
          active ? "steer" : "start",
          overrides,
        );
        const execute = () =>
          Effect.gen(function* () {
            const request: ConversationFollowerRequest = prepared.start
              ? {
                  method: "thread-follower-start-turn",
                  params: { conversationId: threadId, turnStart: prepared.start },
                }
              : { method: "thread-follower-steer-turn", params: prepared.steer };
            yield* dispatch(request);
          });
        yield* execute().pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* readCurrent;
              if (prepared.start || !isSteerTurnInactiveError(cause))
                return yield* Effect.fail(cause);
              turns.releasePreparedNativeSteer(prepared.steer.clientUserMessageId);
              prepared = yield* turns.prepareNativeToolMessage(
                threadId,
                sourceThreadId,
                prompt,
                "start",
                overrides,
              );
              yield* execute();
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              turns.releasePreparedNativeStart(prepared.steer.clientUserMessageId);
              turns.releasePreparedNativeSteer(prepared.steer.clientUserMessageId);
            }),
          ),
        );
      }).pipe(Effect.mapError((cause) => new DelegatedMessageError({ threadId, cause }))),
  });
});
