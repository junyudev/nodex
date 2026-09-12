import { parseCodexAppServerMessage } from "../codex/codex-app-server-message-parser";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ThreadStatus,
  Turn,
} from "@nodex/codex-app-server-protocol/v2";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexNativeThreadLookup } from "./CodexNativeThreadLookup";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ThreadPollCache } from "../../shared/codex-thread-poll";
import {
  waitForThreads,
  type ThreadWaitClient,
  type ThreadWaitManager,
} from "../../shared/codex-thread-wait";
import {
  buildCodexAppDynamicToolFailure,
  buildCodexAppDynamicToolSuccess,
} from "../codex/codex-app-meta-thread-tools";

export class CodexWaitThreads extends Context.Service<
  CodexWaitThreads,
  {
    readonly execute: (
      params: DynamicToolCallParams,
    ) => Effect.Effect<DynamicToolCallResponse | null>;
  }
>()("nodex/main/codex-application/CodexWaitThreads") {}
class ThreadWaitError extends Data.TaggedError("ThreadWaitError")<{ readonly cause: unknown }> {}
interface WaitArguments {
  readonly targets: readonly {
    readonly threadId: string;
    readonly hostId?: string;
    readonly afterCursor?: string;
  }[];
  readonly timeoutMs?: number;
}
function argumentsFor(value: unknown): WaitArguments | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("targets" in value) ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > 8
  )
    return null;
  for (const target of value.targets) {
    if (
      !target ||
      typeof target !== "object" ||
      typeof target.threadId !== "string" ||
      !target.threadId.length
    )
      return null;
    if (target.hostId !== undefined && (typeof target.hostId !== "string" || !target.hostId.length))
      return null;
    if (
      target.afterCursor !== undefined &&
      (typeof target.afterCursor !== "string" || !target.afterCursor.length)
    )
      return null;
  }
  if (
    "timeoutMs" in value &&
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 0 ||
      value.timeoutMs > 120000)
  )
    return null;
  return value as WaitArguments;
}
export const make = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const nativeManagers = yield* CodexMainConversationManagers;
  const lookup = yield* CodexNativeThreadLookup;
  const hosts = yield* CodexThreadHostResolver;
  const callbacks = yield* ScopedCallbackRuntime;
  const events = yield* CodexApplicationEventHub;
  // Listeners are scoped to a single waiting operation; the native stream owns their delivery order.
  const listeners = new Set<(event: CodexEndpointEvent) => void>();
  const steerListeners = new Set<(threadId: string) => void>();
  const managers = new Map<
    string,
    {
      readonly native: MainConversationManager;
      readonly generation: number;
      readonly manager: ThreadWaitManager;
      readonly disposal: Disposable;
    }
  >();
  const managerListeners = new Map<string, Set<(manager: ThreadWaitManager) => void>>();
  const managerFor = (native: MainConversationManager): ThreadWaitManager => {
    const { hostId, generation } = native;
    const previous = managers.get(hostId);
    if (previous?.native === native && previous.generation === generation) return previous.manager;
    previous?.disposal[Symbol.dispose]();
    const manager: ThreadWaitManager = {
      hostId,
      read: (threadId) =>
        callbacks.runPromise(
          Effect.try({
            try: () => native.assertCurrent(generation),
            catch: (cause) => new ThreadWaitError({ cause }),
          }).pipe(
            Effect.andThen(
              Effect.all(
                [
                  gateway.requestOnHost(
                    hostId,
                    "thread/read",
                    { threadId, includeTurns: false },
                    {
                      expectedHostId: hostId,
                      expectedGeneration: generation,
                      priority: "background",
                      source: "tail_history",
                      timeoutMs: 15000,
                    },
                  ),
                  gateway.requestOnHost(
                    hostId,
                    "thread/turns/list",
                    { threadId, itemsView: "full", limit: 1 },
                    {
                      expectedHostId: hostId,
                      expectedGeneration: generation,
                      priority: "background",
                      source: "tail_history",
                      timeoutMs: 15000,
                    },
                  ),
                ],
                { concurrency: "unbounded" },
              ),
            ),
            Effect.flatMap(([thread, turns]) =>
              Effect.try({
                try: () => {
                  native.assertCurrent(generation);
                  return {
                    status: thread.thread.status as ThreadStatus,
                    latestTurn: (turns.data[0] as unknown as Turn | undefined) ?? null,
                  };
                },
                catch: (cause) => new ThreadWaitError({ cause }),
              }),
            ),
          ),
        ),
      subscribe: (threadId, notify) => {
        const listener = (event: CodexEndpointEvent) => {
          if (
            event.kind === "connection" ||
            event.hostId !== hostId ||
            event.generation !== generation ||
            nativeManagers.current(hostId) !== native
          )
            return;
          const parsed = parseCodexAppServerMessage(event.value);
          if (!parsed.success || parsed.data.kind !== "notification") return;
          const notification = parsed.data.notification;
          if (notification.method === "turn/completed" && notification.params.threadId === threadId)
            notify({ type: "completed", turn: notification.params.turn });
          if (
            notification.method === "thread/status/changed" &&
            notification.params.threadId === threadId
          )
            notify({ type: "status", status: notification.params.status });
        };
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const disposal = native.onDispose(() => {
      if (managers.get(hostId)?.manager === manager) managers.delete(hostId);
      if (!managerListeners.get(hostId)?.size) return;
      callbacks.fork(
        gateway.awaitReady(hostId).pipe(
          Effect.andThen(nativeManagers.get(hostId)),
          Effect.tap((replacement) =>
            Effect.sync(() => {
              managerFor(replacement);
            }),
          ),
          Effect.ignore,
        ),
      );
    });
    managers.set(hostId, { native, generation, manager, disposal });
    for (const listener of managerListeners.get(hostId) ?? []) listener(manager);
    return manager;
  };
  yield* gateway.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.kind === "connection" && event.value.kind === "ready")
          callbacks.fork(
            nativeManagers.get(event.value.hostId).pipe(
              Effect.tap((native) =>
                Effect.sync(() => {
                  managerFor(native);
                }),
              ),
              Effect.ignore,
            ),
          );
        for (const listener of listeners) listener(event);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* events.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.kind === "conversationTurnSteered")
          for (const listener of steerListeners) listener(event.value);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const schedule = (callback: () => void, delay: number) => {
    const fiber = callbacks.fork(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(callback))));
    return () => {
      if (fiber) callbacks.fork(Fiber.interrupt(fiber));
    };
  };
  const client: ThreadWaitClient = {
    cache: new ThreadPollCache(),
    resolve: (threadId, preferred) =>
      callbacks.runPromise(
        Effect.gen(function* () {
          if (preferred === undefined) {
            const match = yield* lookup.resolve(threadId, undefined, {
              priority: "background",
              source: "tail_history",
              timeoutMs: 15000,
            });
            return managerFor(match.manager);
          }
          yield* gateway.awaitReady(preferred);
          return managerFor(yield* nativeManagers.get(preferred));
        }),
      ),
    watchManager: (hostId, listener) => {
      const subscribers = managerListeners.get(hostId) ?? new Set();
      subscribers.add(listener);
      managerListeners.set(hostId, subscribers);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) managerListeners.delete(hostId);
      };
    },
    now: Date.now,
    schedule,
    interval: (callback, delay) => {
      let disposed = false;
      let cancel: () => void;
      const tick = () => {
        if (disposed) return;
        callback();
        cancel = schedule(tick, delay);
      };
      cancel = schedule(tick, delay);
      return () => {
        disposed = true;
        cancel();
      };
    },
  };
  return CodexWaitThreads.of({
    execute: (params) =>
      Effect.gen(function* () {
        const args = argumentsFor(params.arguments);
        if (!args)
          return buildCodexAppDynamicToolFailure("wait_threads received invalid arguments.");
        if (args.targets.some((target) => target.threadId === params.threadId))
          return buildCodexAppDynamicToolFailure("wait_threads cannot wait on the calling thread.");
        const sourceHost = yield* hosts
          .resolve(params.threadId)
          .pipe(Effect.catch(() => Effect.succeed(gateway.localHostId)));
        const sourceManager = yield* nativeManagers
          .get(sourceHost)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const targets = args.targets.map((target) => ({
          ...target,
          hostId: target.hostId ?? sourceHost,
        }));
        if (
          new Set(targets.map((target) => JSON.stringify([target.hostId, target.threadId])))
            .size !== targets.length
        )
          return buildCodexAppDynamicToolFailure(
            "wait_threads received duplicate targets. Each threadId and hostId pair must be unique.",
          );
        let reason: "steered" | "turnCompleted" | null = null;
        const sourceGeneration = sourceManager?.generation;
        let notifyInterrupted: () => void = () => {};
        const completed = (event: CodexEndpointEvent) => {
          if (
            event.kind === "connection" ||
            event.hostId !== sourceHost ||
            event.value.method !== "turn/completed" ||
            !sourceManager ||
            event.generation !== sourceGeneration ||
            nativeManagers.current(sourceHost) !== sourceManager
          )
            return;
          const parsed = parseCodexAppServerMessage(event.value);
          if (
            !parsed.success ||
            parsed.data.kind !== "notification" ||
            parsed.data.notification.method !== "turn/completed"
          )
            return;
          if (
            parsed.data.notification.params.threadId === params.threadId &&
            parsed.data.notification.params.turn.id === params.turnId
          ) {
            reason = "turnCompleted";
            notifyInterrupted();
          }
        };
        const steered = (threadId: string) => {
          if (threadId === params.threadId && reason !== "turnCompleted") {
            reason = "steered";
            notifyInterrupted();
          }
        };
        const interrupted = Effect.callback<void>((resume) => {
          notifyInterrupted = () => resume(Effect.void);
          listeners.add(completed);
          steerListeners.add(steered);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              listeners.delete(completed);
              steerListeners.delete(steered);
            }),
          ),
        );
        const waiting = Effect.tryPromise({
          try: (signal) => waitForThreads(client, targets, args.timeoutMs ?? 120000, signal),
          catch: (cause) => new ThreadWaitError({ cause }),
        }).pipe(
          Effect.match({
            onFailure: (cause) =>
              buildCodexAppDynamicToolFailure(
                cause.cause instanceof Error ? cause.cause.message : String(cause.cause),
              ),
            onSuccess: buildCodexAppDynamicToolSuccess,
          }),
        );
        return yield* Effect.raceFirst(interrupted, waiting).pipe(
          Effect.map((result) =>
            reason === "turnCompleted"
              ? null
              : reason === "steered"
                ? buildCodexAppDynamicToolSuccess({
                    message: "Wait interrupted by new input.",
                    timedOut: false,
                  })
                : (result ?? null),
          ),
        );
      }),
  });
});
