import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { codexRuntimeError } from "./CodexRuntimeError";
import { CodexRendererResponseMetrics } from "./CodexHostRequestMetrics";
import {
  CodexRendererDispatchState,
  type CodexRendererDispatchStateValue,
} from "./CodexRendererRequestOrigin";

/** A retained caller signals its timeout; the scheduler decides whether native dispatch occurred. */
export const CodexRetainedRequestTimeout = Context.Reference<Effect.Effect<void> | null>(
  "nodex/main/codex-runtime/CodexRetainedRequestTimeout",
  { defaultValue: () => null },
);

/** Logical renderer abandonment drops unsent work while preserving already-dispatched native replies. */
export const makeCodexRendererRequestLifetimes = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<string, unknown, object>();
  const retained = new Map<string, Deferred.Deferred<void>>();
  const abandonment = new Map<string, (reason: "timeout" | "disposed") => void>();
  const dispatchStates = new Map<string, CodexRendererDispatchStateValue>();
  const responseStates = new Map<string, { abandonmentReason?: "timeout" | "disposed" }>();
  const markAbandoned = (key: string, reason: "timeout" | "disposed"): void => {
    abandonment.get(key)?.(reason);
    const response = responseStates.get(key);
    if (response) response.abandonmentReason = reason;
  };
  return {
    start: <TResult, TError extends object>(
      key: string,
      retainResponse: boolean,
      operation: Effect.Effect<TResult, TError>,
      onAbandon?: (reason: "timeout" | "disposed") => void,
    ) =>
      Effect.gen(function* () {
        if (yield* FiberMap.has(fibers, key))
          return yield* codexRuntimeError({
            operation: "renderer-request.duplicate",
            reason: "host-unavailable",
            retryable: false,
          });
        const timeout = retainResponse ? yield* Deferred.make<void>() : null;
        const dispatchState = yield* CodexRendererDispatchState;
        const responseState = yield* CodexRendererResponseMetrics;
        if (timeout) retained.set(key, timeout);
        if (onAbandon) abandonment.set(key, onAbandon);
        if (dispatchState) dispatchStates.set(key, dispatchState);
        if (responseState) responseStates.set(key, responseState);
        return yield* FiberMap.run(
          fibers,
          key,
          operation.pipe(
            Effect.provideService(
              CodexRetainedRequestTimeout,
              timeout ? Deferred.await(timeout) : null,
            ),
            Effect.ensuring(
              Effect.sync(() => {
                retained.delete(key);
                abandonment.delete(key);
                dispatchStates.delete(key);
                responseStates.delete(key);
              }),
            ),
          ),
          { onlyIfMissing: true, startImmediately: true },
        );
      }),
    abandon: (key: string) =>
      Effect.suspend(() => {
        markAbandoned(key, "timeout");
        const timeout = retained.get(key);
        if (timeout) return Deferred.succeed(timeout, undefined).pipe(Effect.asVoid);
        const dispatchState = dispatchStates.get(key);
        if (dispatchState?.dispatched !== true) return FiberMap.remove(fibers, key);
        if (dispatchState.detachOnTimeout || dispatchState.isCoalescedFollower)
          return FiberMap.remove(fibers, key);
        return Effect.void;
      }),
    closeRenderer: (key: string) =>
      Effect.suspend(() => {
        markAbandoned(key, "disposed");
        return FiberMap.remove(fibers, key);
      }),
    close: (key: string) =>
      Effect.suspend(() => {
        markAbandoned(key, "disposed");
        return FiberMap.remove(fibers, key);
      }),
  };
});
