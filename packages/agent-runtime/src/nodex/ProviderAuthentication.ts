import {
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderAuthCompleteInput,
  ProviderAuthCancelInput,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@nodex/runtime-contracts";
import type { ProviderInstance } from "@nodex/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpManagementError } from "./AcpFailures.ts";
import { makeAuthenticationProjection } from "./ProviderAuthenticationProjection.ts";

const request = <M extends string, S extends Schema.Constraint>(method: M, input: S) =>
  Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
const Owner = { ownerId: Schema.NonEmptyString.check(Schema.isMaxLength(128)) };
export const Request = Schema.Union([
  request("providers.auth.read", Schema.Struct({ instanceId: ProviderInstanceId, ...Owner })),
  request("providers.auth.start", Schema.Struct({ ...ProviderAuthStartInput.fields, ...Owner })),
  request(
    "providers.auth.respond",
    Schema.Struct({ ...ProviderAuthRespondInput.fields, ...Owner }),
  ),
  request(
    "providers.auth.complete",
    Schema.Struct({ ...ProviderAuthCompleteInput.fields, ...Owner }),
  ),
  request("providers.auth.cancel", Schema.Struct({ ...ProviderAuthCancelInput.fields, ...Owner })),
  request("providers.auth.logout", Schema.Struct({ instanceId: ProviderInstanceId })),
]);
interface Controls {
  readonly target: (
    id: ProviderInstanceId,
    newWork?: boolean,
  ) => Effect.Effect<ProviderInstance, AcpManagementError>;
  readonly revision: Effect.Effect<number>;
  readonly withIdle: <A, E, R>(
    id: ProviderInstanceId,
    use: (instance: ProviderInstance) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AcpManagementError, R>;
  readonly withCurrent: <A, E, R>(
    instance: ProviderInstance,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AcpManagementError, R>;
  readonly withLogout: <A, E, R>(
    id: ProviderInstanceId,
    use: (
      instance: ProviderInstance,
      stopSessions: Effect.Effect<void, ProviderSetupError>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AcpManagementError, R>;
  readonly beforeMutation: (instance: ProviderInstance) => Effect.Effect<void, ProviderSetupError>;
}
const unavailable = () =>
  new AcpManagementError({
    reason: "invalid_request",
    message: "The Agent sign-in state is unavailable.",
  });

/** Every provider uses one owner-scoped controller projection. */
export const make = (runtimeGeneration: string, controls: Controls) => {
  const projection = makeAuthenticationProjection(runtimeGeneration);
  const project = (selected: ProviderInstance, revision: number, state: ProviderAuthState) => {
    if (!selected.auth) return Effect.fail(unavailable());
    return Effect.succeed(projection.project(selected.auth, revision, state));
  };
  const action = Effect.fn("ProviderAuthentication.action")(function* <E, R>(
    selected: ProviderInstance,
    task: Effect.Effect<ProviderAuthState, E, R>,
  ) {
    const revision = yield* controls.revision;
    return yield* controls
      .withCurrent(selected, task)
      .pipe(Effect.flatMap((state) => project(selected, revision, state)));
  });
  const read = Effect.fn("ProviderAuthentication.read")(function* (input: {
    instanceId: ProviderInstanceId;
    ownerId: string;
  }) {
    const selected = yield* controls.target(input.instanceId);
    if (!selected.auth) return yield* unavailable();
    const revision = yield* controls.revision;
    return yield* controls.withCurrent(
      selected,
      selected.auth.subscribe(input.ownerId).pipe(
        Stream.runHead,
        Effect.flatMap((state) =>
          Option.isSome(state)
            ? project(selected, revision, state.value)
            : Effect.fail(unavailable()),
        ),
      ),
    );
  });
  return {
    execute: Effect.fn("ProviderAuthentication.execute")(function* (request: typeof Request.Type) {
      const { input, method } = request;
      switch (method) {
        case "providers.auth.read":
          return yield* read(input);
        case "providers.auth.start": {
          const current = yield* read(input);
          if (current.cancellable) return current;
          return yield* controls.withIdle(input.instanceId, (selected) =>
            Effect.gen(function* () {
              if (!selected.auth) return yield* unavailable();
              const revision = yield* controls.revision;
              const finish = projection.begin(selected.auth, revision);
              return yield* controls
                .withCurrent(
                  selected,
                  selected.auth.start(
                    input.ownerId,
                    controls.beforeMutation(selected),
                    input.methodId,
                    input.returnUrl,
                    input.callbackMode,
                  ),
                )
                .pipe(
                  Effect.flatMap((state) => project(selected, revision, state)),
                  Effect.ensuring(Effect.sync(finish)),
                );
            }),
          );
        }
        case "providers.auth.respond": {
          const selected = yield* controls.target(input.instanceId);
          if (!selected.auth?.respond) return yield* unavailable();
          return yield* action(selected, selected.auth.respond(input.ownerId, input));
        }
        case "providers.auth.complete": {
          const selected = yield* controls.target(input.instanceId);
          if (!selected.auth) return yield* unavailable();
          return yield* action(selected, selected.auth.complete(input.ownerId, input));
        }
        case "providers.auth.cancel": {
          const selected = yield* controls.target(input.instanceId);
          if (!selected.auth) return yield* unavailable();
          return yield* action(selected, selected.auth.cancel(input.ownerId, input.flowId));
        }
        case "providers.auth.logout":
          return yield* controls.withLogout(input.instanceId, (selected, stopSessions) =>
            selected.auth
              ? action(selected, selected.auth.logout(stopSessions))
              : Effect.fail(unavailable()),
          );
      }
    }),
  };
};
