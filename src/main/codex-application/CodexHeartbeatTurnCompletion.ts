import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
  ServerNotificationParamsByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import { automationNotificationDecision } from "../../shared/automation-notification-policy";
import type { CodexHeartbeatDecision } from "../../shared/codex-turn-notification";
import type { CodexScheduledAutomationNotificationPolicy } from "../../shared/types";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { MAIN_RELIABLE_COMMAND_CAPACITY } from "../runtime-limits";

type GenerationFence = { readonly expectedHostId?: string; readonly expectedGeneration?: number };

type TurnCompletedNotification = ServerNotificationParamsByMethod["turn/completed"];
type TurnStartParams = ClientRequestParamsByMethod["turn/start"];
type TurnStartResponse = ClientRequestResponsesByMethod["turn/start"];

export const DEFAULT_CODEX_HEARTBEAT_TURN_COMPLETION_TIMEOUT = "10 minutes";

export class CodexHeartbeatTurnCompletionError extends Data.TaggedError(
  "CodexHeartbeatTurnCompletionError",
)<{
  readonly reason: "request-failed" | "runtime-closed" | "turn-failed";
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: string;
  readonly threadId?: string;
  readonly turnId?: string;
}> {}

export interface CodexHeartbeatTurnCompletionOptions {
  readonly events: Stream.Stream<CodexEndpointEvent>;
  readonly resolveHost: (
    threadId: string,
  ) => Effect.Effect<string, CodexHeartbeatTurnCompletionError>;
  readonly request: (
    hostId: string,
    params: TurnStartParams,
    fence?: GenerationFence,
  ) => Effect.Effect<TurnStartResponse, CodexHeartbeatTurnCompletionError>;
  readonly timeout?: Duration.Input;
}

export class CodexHeartbeatTurnCompletion extends Context.Service<
  CodexHeartbeatTurnCompletion,
  {
    readonly notificationDecision: (
      threadId: string,
      turnId: string,
      status: Turn["status"],
    ) => Effect.Effect<{ readonly decision: CodexHeartbeatDecision | null } | null>;
    readonly start: (
      params: TurnStartParams,
      policy?: CodexScheduledAutomationNotificationPolicy | null,
      fence?: GenerationFence,
    ) => Effect.Effect<TurnStartResponse, CodexHeartbeatTurnCompletionError>;
    readonly startAndWait: (
      params: TurnStartParams,
      policy?: CodexScheduledAutomationNotificationPolicy | null,
      fence?: GenerationFence,
    ) => Effect.Effect<TurnStartResponse, CodexHeartbeatTurnCompletionError>;
  }
>()("nodex/main/codex-application/CodexHeartbeatTurnCompletion") {}

const completionNotification = (
  event: CodexEndpointEvent,
): { readonly hostId: string; readonly notification: TurnCompletedNotification } | null => {
  if (event.kind !== "notification" || event.value.method !== "turn/completed") {
    return null;
  }
  return {
    hostId: event.hostId,
    notification: event.value.params as TurnCompletedNotification,
  };
};

export const make = (
  options: CodexHeartbeatTurnCompletionOptions,
): Effect.Effect<CodexHeartbeatTurnCompletion["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const closed = yield* Latch.make();
    yield* Effect.addFinalizer(() => closed.open);

    const pending = new Map<string, Set<Deferred.Deferred<string | null>>>();
    const accepted = new Map<string, CodexScheduledAutomationNotificationPolicy | null>();
    const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const requests of pending.values()) {
          for (const request of requests) yield* Deferred.succeed(request, null);
        }
        pending.clear();
        accepted.clear();
      }),
    );

    // Admission precedes the request: completion can arrive before its response.
    const request = Effect.fn("CodexHeartbeatTurnCompletion.request")(function* (
      hostId: string,
      params: TurnStartParams,
      policy?: CodexScheduledAutomationNotificationPolicy | null,
      fence?: GenerationFence,
    ) {
      const admission = yield* Deferred.make<string | null>();
      const requests = pending.get(params.threadId) ?? new Set();
      requests.add(admission);
      pending.set(params.threadId, requests);
      return yield* options.request(hostId, params, fence).pipe(
        Effect.tap((response) =>
          Effect.gen(function* () {
            accepted.set(turnKey(params.threadId, response.turn.id), policy ?? null);
            while (accepted.size > MAIN_RELIABLE_COMMAND_CAPACITY) {
              const oldest = accepted.keys().next().value;
              if (oldest === undefined) break;
              accepted.delete(oldest);
            }
            yield* Deferred.succeed(admission, response.turn.id);
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(admission, null);
            requests.delete(admission);
            if (requests.size === 0) pending.delete(params.threadId);
          }),
        ),
      );
    });

    const startAndWait = (
      params: TurnStartParams,
      policy?: CodexScheduledAutomationNotificationPolicy | null,
      fence?: GenerationFence,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const completions = yield* Queue.bounded<{
            readonly hostId: string;
            readonly notification: TurnCompletedNotification;
          }>(MAIN_RELIABLE_COMMAND_CAPACITY);
          yield* Effect.addFinalizer(() => Queue.shutdown(completions).pipe(Effect.asVoid));
          yield* options.events.pipe(
            Stream.runForEach((event) => {
              const completion = completionNotification(event);
              return completion === null
                ? Effect.void
                : Queue.offer(completions, completion).pipe(Effect.asVoid);
            }),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const deadline = yield* Effect.sleep(
            options.timeout ?? DEFAULT_CODEX_HEARTBEAT_TURN_COMPLETION_TIMEOUT,
          ).pipe(Effect.forkScoped);
          const hostId = yield* options.resolveHost(params.threadId);
          const response = yield* request(hostId, params, policy, fence);
          const awaitMatchingCompletion: Effect.Effect<TurnCompletedNotification> = Effect.suspend(
            () =>
              Queue.take(completions).pipe(
                Effect.flatMap(({ hostId: completionHostId, notification }) =>
                  completionHostId === hostId &&
                  notification.threadId === params.threadId &&
                  notification.turn.id === response.turn.id
                    ? Effect.succeed(notification)
                    : awaitMatchingCompletion,
                ),
              ),
          );
          const outcome = yield* Effect.raceFirst(
            awaitMatchingCompletion.pipe(
              Effect.map((completion) => ({ _tag: "Completed" as const, completion })),
            ),
            Fiber.join(deadline).pipe(Effect.as({ _tag: "Deadline" as const })),
          );
          if (outcome._tag === "Deadline") return response;
          if (outcome.completion.turn.status === "completed") return response;
          return yield* new CodexHeartbeatTurnCompletionError({
            reason: "turn-failed",
            message: "Heartbeat automation did not complete.",
            status: outcome.completion.turn.status,
            threadId: params.threadId,
            turnId: response.turn.id,
          });
        }),
      );

    const whileOpen = (
      params: TurnStartParams,
      effect: Effect.Effect<TurnStartResponse, CodexHeartbeatTurnCompletionError>,
    ) =>
      Effect.raceFirst(
        effect,
        closed.await.pipe(
          Effect.andThen(
            Effect.fail(
              new CodexHeartbeatTurnCompletionError({
                reason: "runtime-closed",
                message: "The heartbeat turn runtime is closing",
                threadId: params.threadId,
              }),
            ),
          ),
        ),
      );

    return CodexHeartbeatTurnCompletion.of({
      notificationDecision: (threadId, turnId, status) =>
        Effect.gen(function* () {
          const key = turnKey(threadId, turnId);
          if (accepted.has(key))
            return { decision: automationNotificationDecision(accepted.get(key), status) };
          for (const admission of [...(pending.get(threadId) ?? [])]) {
            const admittedTurnId = yield* Deferred.await(admission);
            if (admittedTurnId === turnId) break;
          }
          return accepted.has(key)
            ? { decision: automationNotificationDecision(accepted.get(key), status) }
            : null;
        }),
      start: (params, policy, fence) =>
        whileOpen(
          params,
          options
            .resolveHost(params.threadId)
            .pipe(Effect.flatMap((hostId) => request(hostId, params, policy, fence))),
        ),
      startAndWait: (params, policy, fence) =>
        whileOpen(params, startAndWait(params, policy, fence)),
    });
  });
