import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CodexConnectionState } from "../../shared/types";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointConnection } from "../codex-runtime/CodexEventHub";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";

export class CodexConnection extends Context.Service<
  CodexConnection,
  {
    readonly read: Effect.Effect<CodexConnectionState>;
    readonly readForHost: (
      hostId: string,
    ) => Effect.Effect<CodexConnectionState, CodexRuntimeError>;
    readonly changes: Stream.Stream<CodexConnectionState>;
    readonly readAll: Effect.Effect<ReadonlyMap<string, CodexConnectionState>>;
    readonly allChanges: Stream.Stream<ReadonlyMap<string, CodexConnectionState>>;
  }
>()("nodex/main/codex-application/CodexConnection") {}

const disconnected = (): CodexConnectionState => ({ status: "disconnected", retries: 0 });

const projectConnectionStatus = (
  previous: CodexConnectionState,
  connection: CodexEndpointConnection,
  now: number,
): CodexConnectionState => {
  switch (connection.kind) {
    case "connecting":
      return { status: "starting", retries: previous.retries };
    case "ready":
      return {
        status: "connected",
        retries: previous.retries,
        lastConnectedAt: previous.status === "connected" ? (previous.lastConnectedAt ?? now) : now,
      };
    case "backing-off":
      return {
        status: connection.error.reason === "spawn" ? "missingBinary" : "error",
        retries: Math.max(previous.retries, connection.attempt),
        message: connection.error.message,
      };
    case "failed":
      return {
        status: connection.error.reason === "spawn" ? "missingBinary" : "error",
        retries: previous.retries,
        message: connection.error.message,
      };
    case "closing":
    case "stopped":
      return { status: "disconnected", retries: previous.retries };
  }
};

export const projectCodexConnection = (
  previous: CodexConnectionState,
  connection: CodexEndpointConnection,
  now: number,
): CodexConnectionState => {
  const state = projectConnectionStatus(previous, connection, now);
  if (!connection.source) return state;
  return {
    ...state,
    native: {
      ...connection.source,
      generation:
        "generation" in connection ? connection.generation : (previous.native?.generation ?? 0),
    },
  };
};

export const live: Layer.Layer<
  CodexConnection,
  never,
  CodexGateway | CodexApplicationEventHub | CodexExecutionHostAuthState
> = Layer.effect(
  CodexConnection,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const events = yield* CodexApplicationEventHub;
    const authState = yield* CodexExecutionHostAuthState;
    const state = yield* SubscriptionRef.make<ReadonlyMap<string, CodexConnectionState>>(new Map());
    const initial = disconnected();
    const publish = (hostId: string, value: CodexConnectionState): void => {
      events.publish({
        kind: "hostMessage",
        value: {
          type: "sharedObjectUpdated",
          hostId,
          object: { objectType: "connection", objectId: "connection", value },
        },
      });
    };
    const withLoginRequired = (
      value: CodexConnectionState,
      required: boolean,
    ): CodexConnectionState =>
      required
        ? {
            ...value,
            status: "error",
            message: "Login required",
            error: { code: "login-required" },
          }
        : value;
    const projectAndPublish = Effect.fn("CodexConnection.projectAndPublish")(function* (
      connection: CodexEndpointConnection,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const previousByHost = yield* SubscriptionRef.get(state);
      const value = withLoginRequired(
        projectCodexConnection(previousByHost.get(connection.hostId) ?? initial, connection, now),
        yield* authState.isLoginRequired(connection.hostId),
      );
      yield* SubscriptionRef.update(state, (current) =>
        new Map(current).set(connection.hostId, value),
      );
      publish(connection.hostId, value);
    });

    const refreshAuthenticatedConnectionState = Effect.fn(
      "CodexConnection.refreshAuthenticatedConnectionState",
    )(function* (hostId: string) {
      const response = yield* gateway.requestOnHost(
        hostId,
        "getAuthStatus",
        { includeToken: false, refreshToken: false },
        { source: "account" },
      );
      const loginRequired = response?.authMethod == null && (response?.requiresOpenaiAuth ?? true);
      if (loginRequired) yield* authState.markLoginRequired(hostId);
      else yield* authState.clearLoginRequired(hostId);
    });

    const observe = Effect.fn("CodexConnection.observe")(function* (
      connection: CodexEndpointConnection,
    ) {
      if (connection.kind === "ready") {
        const refreshed = yield* Effect.result(
          refreshAuthenticatedConnectionState(connection.hostId),
        );
        if (refreshed._tag === "Failure") {
          yield* gateway.restartHost(connection.hostId).pipe(Effect.ignore);
          return;
        }
      }
      yield* projectAndPublish(connection);
    });

    yield* gateway.connectionChanges(gateway.localHostId).pipe(
      Stream.runForEach((connection) => observe(connection).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* gateway.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "connection" && event.value.hostId !== gateway.localHostId) {
          return observe(event.value);
        }
        if (event.kind !== "notification" || event.value.method !== "account/updated") {
          return Effect.void;
        }
        return refreshAuthenticatedConnectionState(event.hostId).pipe(
          Effect.flatMap(() => gateway.connection(event.hostId)),
          Effect.flatMap(projectAndPublish),
          Effect.catch(() => gateway.restartHost(event.hostId).pipe(Effect.ignore)),
        );
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* authState.changes.pipe(
      Stream.runForEach(() =>
        SubscriptionRef.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.keys(), (hostId) =>
              gateway.connection(hostId).pipe(Effect.flatMap(projectAndPublish), Effect.ignore),
            ),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    return CodexConnection.of({
      read: SubscriptionRef.get(state).pipe(
        Effect.map((current) => current.get(gateway.localHostId) ?? initial),
      ),
      readForHost: Effect.fn("CodexConnection.readForHost")(function* (hostId: string) {
        const connection = yield* gateway.connection(hostId);
        const now = yield* Clock.currentTimeMillis;
        const previousByHost = yield* SubscriptionRef.get(state);
        return withLoginRequired(
          projectCodexConnection(previousByHost.get(hostId) ?? disconnected(), connection, now),
          yield* authState.isLoginRequired(hostId),
        );
      }),
      changes: SubscriptionRef.changes(state).pipe(
        Stream.map((current) => current.get(gateway.localHostId) ?? initial),
        Stream.changes,
      ),
      readAll: SubscriptionRef.get(state),
      allChanges: SubscriptionRef.changes(state),
    });
  }),
);
