import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import type { CodexApplicationRequestInbox } from "./CodexApplicationRequestInbox";
import { CodexEndpoint, live as endpointLive, type CodexEndpointConfig } from "./CodexEndpoint";
import type { CodexEventHub } from "./CodexEventHub";
import type { CodexRequestScheduler } from "./CodexRequestScheduler";
import { codexRuntimeError, type CodexRuntimeError } from "./CodexRuntimeError";

export interface CodexExecutionHostConfig extends CodexEndpointConfig {
  readonly kind: "local" | "remote";
}

export class CodexEndpointMap extends Context.Service<
  CodexEndpointMap,
  {
    readonly localHostId: string;
    readonly endpoint: (
      hostId: string,
    ) => Effect.Effect<CodexEndpoint["Service"], CodexRuntimeError>;
    readonly register: (config: CodexExecutionHostConfig) => Effect.Effect<void, CodexRuntimeError>;
    readonly unregister: (hostId: string) => Effect.Effect<void, CodexRuntimeError>;
    readonly restart: (hostId: string) => Effect.Effect<void, CodexRuntimeError>;
    readonly has: (hostId: string) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-runtime/CodexEndpointMap") {}

const unavailable = (hostId: string) =>
  codexRuntimeError({
    operation: "endpoint-map.lookup",
    reason: "host-unavailable",
    retryable: false,
    hostId,
  });

/**
 * Keeps execution hosts alive until explicit invalidation or application shutdown.
 * A short-lived request Scope only borrows the endpoint; it never owns the child.
 */
export const live = (
  local: CodexExecutionHostConfig,
): Layer.Layer<
  CodexEndpointMap,
  never,
  CodexSessionTransport | CodexEventHub | CodexApplicationRequestInbox | CodexRequestScheduler
> =>
  Layer.effect(
    CodexEndpointMap,
    Effect.gen(function* () {
      const localHostId = local.hostId.trim();
      const configs = yield* Ref.make<ReadonlyMap<string, CodexExecutionHostConfig>>(
        new Map([[localHostId, { ...local, hostId: localHostId, kind: "local" }]]),
      );
      const mutationLock = yield* Semaphore.make(1);
      const lookup = (
        hostId: string,
      ): Layer.Layer<
        CodexEndpoint,
        CodexRuntimeError,
        CodexSessionTransport | CodexEventHub | CodexApplicationRequestInbox | CodexRequestScheduler
      > =>
        Layer.unwrap(
          Ref.get(configs).pipe(
            Effect.map(
              (
                current,
              ): Layer.Layer<
                CodexEndpoint,
                CodexRuntimeError,
                | CodexSessionTransport
                | CodexEventHub
                | CodexApplicationRequestInbox
                | CodexRequestScheduler
              > => {
                const config = current.get(hostId);
                return config === undefined
                  ? Layer.effect(CodexEndpoint, Effect.fail(unavailable(hostId)))
                  : endpointLive(config);
              },
            ),
          ),
        );
      const endpoints = yield* LayerMap.make(lookup, { idleTimeToLive: Duration.infinity });

      const endpoint = Effect.fn("CodexEndpointMap.endpoint")((
        hostId: string,
      ): Effect.Effect<CodexEndpoint["Service"], CodexRuntimeError> => {
        const key = hostId.trim();
        if (key.length === 0) return Effect.fail(unavailable(key));
        return Effect.scoped(endpoints.contextEffect(key)).pipe(
          Effect.map((context) => Context.get(context, CodexEndpoint)),
        );
      });

      const register = Effect.fn("CodexEndpointMap.register")((
        config: CodexExecutionHostConfig,
      ): Effect.Effect<void, CodexRuntimeError> => {
        const hostId = config.hostId.trim();
        if (hostId.length === 0) return Effect.fail(unavailable(hostId));
        if (hostId === localHostId && config.kind !== "local") {
          return Effect.fail(
            codexRuntimeError({
              operation: "endpoint-map.register",
              reason: "host-unavailable",
              retryable: false,
              hostId,
            }),
          );
        }
        const normalized = { ...config, hostId };
        return Effect.gen(function* () {
          const previous = yield* Ref.get(configs);
          const next = new Map(previous);
          next.set(hostId, normalized);
          yield* Ref.set(configs, next);
          if (!previous.has(hostId)) return;
          const stableEndpoint = yield* endpoint(hostId);
          yield* stableEndpoint.reconcile(normalized);
        }).pipe(mutationLock.withPermits(1));
      });

      const unregister = Effect.fn("CodexEndpointMap.unregister")((
        hostId: string,
      ): Effect.Effect<void, CodexRuntimeError> => {
        const key = hostId.trim();
        if (key === localHostId) {
          return Effect.fail(
            codexRuntimeError({
              operation: "endpoint-map.unregister-local",
              reason: "host-unavailable",
              retryable: false,
              hostId: key,
            }),
          );
        }
        return Ref.update(configs, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        }).pipe(Effect.andThen(endpoints.invalidate(key)), mutationLock.withPermits(1));
      });

      return CodexEndpointMap.of({
        localHostId,
        endpoint,
        register,
        unregister,
        restart: (hostId) =>
          Ref.get(configs).pipe(
            Effect.flatMap((current) =>
              current.has(hostId.trim())
                ? endpoint(hostId.trim()).pipe(Effect.flatMap((stable) => stable.restart))
                : Effect.fail(unavailable(hostId.trim())),
            ),
            mutationLock.withPermits(1),
          ),
        has: (hostId) => Ref.get(configs).pipe(Effect.map((current) => current.has(hostId.trim()))),
      });
    }),
  );
