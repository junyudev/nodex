import { isSteerTurnInactiveError } from "../../shared/codex-steer-errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as RcMap from "effect/RcMap";
import type { ConversationFollowerRequest } from "../../shared/codex-client-coordination";
import { latestConversationTurn } from "../../shared/codex-conversation-state/codex-turn-selectors";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { isDeepStrictEqual } from "node:util";
import type { CodexCanonicalPermissionContext } from "../../shared/types";
import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexTurnCommands, type CodexTurnStartOverrides } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
export class DelegatedMessageError extends Schema.TaggedError<DelegatedMessageError>()(
  "DelegatedMessageError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}
export interface NativeMessageDelivery {
  readonly messageId: string;
  readonly runId: string | null;
  readonly status: string;
  readonly delivery: "started" | "steered" | "queued" | "restarted" | "replayed" | "unconfirmed";
}
export interface NativeMessageOptions {
  readonly mode?: "auto" | "queue" | "steer" | "restart";
  readonly expectedPermissions?: CodexCanonicalPermissionContext;
  readonly expectedInteractionMode?: "plan" | "default";
  readonly interactionModeCeiling?: "plan";
  readonly expectedHostId?: string;
  /** The application binding owner revalidates immediately before every producer mutation. */
  readonly beforeNativeDispatch?: Effect.Effect<void, unknown>;
  readonly onNativeDispatch?: () => void;
}
export class CodexDelegatedMessages extends Context.Service<
  CodexDelegatedMessages,
  {
    reconcile(input: {
      readonly hostId: string;
      readonly threadId: string;
      readonly messageId: string;
    }): Effect.Effect<NativeMessageDelivery, DelegatedMessageError>;
    send(
      threadId: string,
      sourceThreadId: string,
      prompt: string,
      overrides?: CodexTurnStartOverrides,
      options?: NativeMessageOptions,
    ): Effect.Effect<NativeMessageDelivery, DelegatedMessageError>;
  }
>()("nodex/main/codex-application/CodexDelegatedMessages") {}
export const make = Effect.gen(function* () {
  const resume = yield* CodexMainConversationResume;
  const managers = yield* CodexMainConversationManagers;
  const hosts = yield* CodexThreadHostResolver;
  const turns = yield* CodexTurnCommands;
  const entities = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const lanes = yield* RcMap.make({ lookup: (_threadId: string) => Semaphore.make(1) });
  const inLane = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(lanes, threadId);
        return yield* lane.withPermit(effect);
      }),
    );
  return CodexDelegatedMessages.of({
    reconcile: ({ hostId, threadId, messageId }) =>
      inLane(
        threadId,
        Effect.gen(function* () {
          const manager = yield* managers.get(hostId);
          const generation = manager.generation;
          const scheduling = {
            expectedHostId: hostId,
            expectedGeneration: generation,
            timeoutMs: 10_000,
          };
          const capability = yield* capabilities.forHost(hostId);
          if (capability.generation !== generation)
            return yield* new DelegatedMessageError({
              threadId,
              cause: new Error("Native connection changed during delivery reconciliation"),
            });
          if (capability.flags.threadQueue) {
            let cursor: string | null = null;
            for (let index = 0; index < 20; index++) {
              const page: ClientRequestResponsesByMethod["thread/queue/list"] =
                yield* gateway.requestOnHost(
                  hostId,
                  "thread/queue/list",
                  { threadId, cursor, limit: 100 },
                  scheduling,
                );
              if (page.data.some((item) => item.clientUserMessageId === messageId))
                return { messageId, runId: null, status: "queued", delivery: "replayed" as const };
              if (!page.nextCursor || page.nextCursor === cursor) break;
              cursor = page.nextCursor;
            }
          }
          let cursor: string | null = null;
          for (let index = 0; index < 4; index++) {
            const page: ClientRequestResponsesByMethod["thread/turns/list"] =
              yield* gateway.requestOnHost(
                hostId,
                "thread/turns/list",
                { threadId, cursor, limit: 25, itemsView: "summary" },
                scheduling,
              );
            const prior = page.data.find((turn) =>
              turn.items.some((item) => item.type === "userMessage" && item.id === messageId),
            );
            if (prior)
              return {
                messageId,
                runId: prior.id,
                status: prior.status,
                delivery: "replayed" as const,
              };
            if (!page.nextCursor || page.nextCursor === cursor) break;
            cursor = page.nextCursor;
          }
          return { messageId, runId: null, status: "unknown", delivery: "unconfirmed" as const };
        }).pipe(Effect.mapError((cause) => new DelegatedMessageError({ threadId, cause }))),
      ),
    send: (threadId, sourceThreadId, prompt, overrides, options) =>
      inLane(
        threadId,
        Effect.gen(function* () {
          const assertHost = Effect.gen(function* () {
            const currentHostId = yield* hosts.resolve(threadId);
            if (options?.expectedHostId && currentHostId !== options.expectedHostId)
              return yield* new DelegatedMessageError({
                threadId,
                cause: new Error("Target execution host changed before message delivery"),
              });
            return currentHostId;
          });
          yield* options?.beforeNativeDispatch ?? Effect.void;
          yield* assertHost;
          const resumed = yield* resume.resume(threadId, { serviceTier: overrides?.serviceTier });
          if (resumed.status === "not-ready")
            return yield* new DelegatedMessageError({
              threadId,
              cause: new Error(`Conversation is not ready: ${resumed.reason}`),
            });
          const hostId = yield* assertHost;
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
              if (state.hostId !== hostId)
                throw new Error("Target canonical execution host changed before message delivery");
              if (
                options?.expectedPermissions &&
                !isDeepStrictEqual(state.currentPermissions, options.expectedPermissions)
              )
                throw new Error("Target permissions changed before message delivery");
              if (
                options?.expectedInteractionMode &&
                (state.latestCollaborationMode.mode === "plan" ? "plan" : "default") !==
                  options.expectedInteractionMode
              )
                throw new Error("Target interaction mode changed before message delivery");
              return state;
            },
            catch: (cause) => new DelegatedMessageError({ threadId, cause }),
          });
          const dispatch = Effect.fn("CodexDelegatedMessages.dispatch")(function* (
            request: ConversationFollowerRequest,
          ) {
            yield* options?.beforeNativeDispatch ?? Effect.void;
            yield* assertHost;
            yield* readCurrent;
            if (request.method !== "thread-follower-update-thread-settings")
              options?.onNativeDispatch?.();
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
              return result.result;
            }
            if (role?.role !== "owner")
              return yield* Effect.fail(
                new DelegatedMessageError({
                  threadId,
                  cause: new Error("Conversation has no owner"),
                }),
              );
            const result = yield* managers.dispatchFollowerRequest(hostId, request);
            yield* readCurrent;
            return result;
          });
          const state = yield* readCurrent;
          const suppliedId = overrides?.clientUserMessageId;
          const existing = suppliedId
            ? state.turns.find(
                (turn) =>
                  turn.params.clientUserMessageId === suppliedId ||
                  turn.items.some((item) => item.id === suppliedId),
              )
            : undefined;
          if (existing)
            return {
              messageId: suppliedId!,
              runId: existing.turnId,
              status: existing.status,
              delivery: "replayed" as const,
            };
          if (
            suppliedId &&
            state.unconfirmedTurnSubmissions?.some(
              (item) => item.clientUserMessageId === suppliedId,
            )
          )
            return {
              messageId: suppliedId,
              runId: null,
              status: "unknown",
              delivery: "unconfirmed" as const,
            };
          const mode = options?.mode ?? "auto";
          if (mode === "steer" && latestConversationTurn(state)?.status !== "inProgress")
            return yield* new DelegatedMessageError({
              threadId,
              cause: new Error("No active native Turn to steer"),
            });
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
          let latest = latestConversationTurn(yield* readCurrent);
          const active = latest?.status === "inProgress";
          if (mode === "steer" && !active)
            return yield* new DelegatedMessageError({
              threadId,
              cause: new Error("No active native Turn to steer"),
            });
          if (mode === "restart" && active) {
            yield* dispatch({
              method: "thread-follower-interrupt-turn",
              params: {
                conversationId: threadId,
                mode: "system",
                ...(latest?.turnId ? { expectedTurnId: latest.turnId } : {}),
              },
            });
            latest = latestConversationTurn(yield* readCurrent);
            if (latest?.status === "inProgress")
              return yield* new DelegatedMessageError({
                threadId,
                cause: new Error("Native interruption has not settled"),
              });
          }
          let prepared = yield* turns.prepareNativeToolMessage(
            threadId,
            sourceThreadId,
            prompt,
            active && mode !== "restart" && mode !== "queue" ? "steer" : "start",
            overrides,
          );
          const messageId = prepared.steer.clientUserMessageId;
          const assertPreparedMode = Effect.gen(function* () {
            if (
              options?.interactionModeCeiling === "plan" &&
              prepared.start &&
              prepared.start.request.collaborationMode?.mode !== "plan"
            )
              return yield* new DelegatedMessageError({
                threadId,
                cause: new Error("interaction_mode_escalation_denied"),
              });
          });
          yield* assertPreparedMode.pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                turns.releasePreparedNativeStart(messageId);
                turns.releasePreparedNativeSteer(messageId);
              }),
            ),
          );
          if (mode === "queue") {
            return yield* Effect.gen(function* () {
              const capability = yield* capabilities.forHost(hostId);
              if (!capability.flags.threadQueue || capability.generation !== generation)
                return yield* new DelegatedMessageError({
                  threadId,
                  cause: new Error("Native message queue is unavailable"),
                });
              const capturedInput = prepared.steer.toolOutput
                ? [
                    {
                      type: "text" as const,
                      text: prepared.steer.toolOutput.output,
                      text_elements: [],
                    },
                    ...prepared.steer.input,
                  ]
                : [...prepared.steer.input];
              const input = structuredClone(capturedInput) as unknown as UserInput[];
              let cursor: string | null = null;
              for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
                const page: ClientRequestResponsesByMethod["thread/queue/list"] =
                  yield* gateway.requestOnHost(
                    hostId,
                    "thread/queue/list",
                    { threadId, cursor, limit: 100 },
                    { expectedHostId: hostId, expectedGeneration: generation, timeoutMs: 10_000 },
                  );
                const prior = page.data.find((item) => item.clientUserMessageId === messageId);
                if (prior) {
                  if (!isDeepStrictEqual(prior.input, input))
                    return yield* new DelegatedMessageError({
                      threadId,
                      cause: new Error("Native message identity has different input"),
                    });
                  return {
                    messageId,
                    runId: null,
                    status: "queued",
                    delivery: "replayed" as const,
                  };
                }
                if (!page.nextCursor) break;
                if (page.nextCursor === cursor || pageIndex === 19)
                  return yield* new DelegatedMessageError({
                    threadId,
                    cause: new Error("Native queue identity could not be proven"),
                  });
                cursor = page.nextCursor;
              }
              yield* readCurrent;
              yield* options?.beforeNativeDispatch ?? Effect.void;
              yield* assertHost;
              yield* readCurrent;
              const queued = yield* gateway.requestOnHost(
                hostId,
                "thread/queue/add",
                { threadId, clientUserMessageId: messageId, input },
                {
                  expectedHostId: hostId,
                  expectedGeneration: generation,
                  timeoutMs: 10_000,
                  onNativeDispatch: options?.onNativeDispatch,
                },
              );
              yield* readCurrent;
              if (
                queued.queuedSubmission.clientUserMessageId !== messageId ||
                !isDeepStrictEqual(queued.queuedSubmission.input, input)
              )
                return yield* new DelegatedMessageError({
                  threadId,
                  cause: new Error("Native queue did not confirm the captured message"),
                });
              return { messageId, runId: null, status: "queued", delivery: "queued" as const };
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  turns.releasePreparedNativeStart(messageId);
                  turns.releasePreparedNativeSteer(messageId);
                }),
              ),
            );
          }
          let delivered: unknown;
          const execute = () =>
            Effect.gen(function* () {
              const request: ConversationFollowerRequest = prepared.start
                ? {
                    method: "thread-follower-start-turn",
                    params: { conversationId: threadId, turnStart: prepared.start },
                  }
                : { method: "thread-follower-steer-turn", params: prepared.steer };
              delivered = yield* dispatch(request);
            });
          yield* execute().pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* readCurrent;
                if (prepared.start || mode === "steer" || !isSteerTurnInactiveError(cause))
                  return yield* Effect.fail(cause);
                turns.releasePreparedNativeSteer(prepared.steer.clientUserMessageId);
                prepared = yield* turns.prepareNativeToolMessage(
                  threadId,
                  sourceThreadId,
                  prompt,
                  "start",
                  overrides,
                );
                yield* assertPreparedMode;
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
          const result =
            delivered && typeof delivered === "object"
              ? (delivered as Record<string, unknown>)
              : {};
          const response =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : result;
          const turn =
            response.turn && typeof response.turn === "object"
              ? (response.turn as Record<string, unknown>)
              : null;
          const runId =
            typeof turn?.id === "string"
              ? turn.id
              : typeof response.turnId === "string"
                ? response.turnId
                : prepared.start
                  ? ((yield* readCurrent).turns.find(
                      (turn) => turn.params.clientUserMessageId === messageId,
                    )?.turnId ?? null)
                  : (latest?.turnId ?? null);
          return {
            messageId,
            runId,
            status: runId === null ? "unknown" : "running",
            delivery:
              runId === null
                ? ("unconfirmed" as const)
                : mode === "restart"
                  ? ("restarted" as const)
                  : prepared.start
                    ? ("started" as const)
                    : ("steered" as const),
          };
        }).pipe(Effect.mapError((cause) => new DelegatedMessageError({ threadId, cause }))),
      ),
  });
});
