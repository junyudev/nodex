import type { AgentStorageSnapshot } from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import type { make as makeAdmission } from "./AgentRuntimeSnapshotAdmission";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";

/** Private snapshot evidence; credentials never cross the Profile coordination socket. */
export interface AgentRuntimeNativeHistorySource {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly homePath: string | null;
}
export interface AgentRuntimeProfileSnapshotSource extends AgentStorageSnapshot {
  readonly nativeHistories: readonly AgentRuntimeNativeHistorySource[];
}

export class AgentRuntimeProfileSnapshotError extends Schema.TaggedError<AgentRuntimeProfileSnapshotError>()(
  "AgentRuntimeProfileSnapshotError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Product admission and the physical execution lease span the entire Profile capture. */
export const make = Effect.fn("AgentRuntimeProfileSnapshot.make")(function (
  runtime: AgentRuntimeSupervisor["Service"],
  admission: Effect.Success<ReturnType<typeof makeAdmission>>,
  options: {
    /** A never-used execution store does not require spawning a process merely to back up content. */
    readonly isUnused?: Effect.Effect<boolean, unknown>;
    readonly nativeHistories?: (
      connection: import("../platform/node/AgentRuntimeProcess").AgentRuntimeProcessConnection,
    ) => Effect.Effect<readonly AgentRuntimeNativeHistorySource[], unknown>;
    readonly prepareRestore?: (
      source: AgentRuntimeProfileSnapshotSource,
    ) => Effect.Effect<AgentRuntimeProfileSnapshotSource, unknown, Scope.Scope>;
  } = {},
) {
  return Effect.sync(() => {
    const withLease = <A, E, R>(
      capture: (snapshot: AgentRuntimeProfileSnapshotSource) => Effect.Effect<A, E, R>,
      stopForRestore = false,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const connection = yield* runtime.get();
          const snapshot = yield* connection.request("storage.snapshot.acquire", {}).pipe(
            Effect.catch((cause) => {
              const closeUncertainAdmission =
                Schema.is(AgentRuntimeProcessError)(cause) && cause.reason === "request"
                  ? connection.request("shutdown", {}).pipe(Effect.ignore)
                  : Effect.void;
              return closeUncertainAdmission.pipe(
                Effect.andThen(
                  Effect.fail(
                    new AgentRuntimeProfileSnapshotError({
                      message: "Execution snapshot admission failed",
                      cause,
                    }),
                  ),
                ),
              );
            }),
          );
          let stopped = false;
          const captured = yield* restore(
            Effect.scoped(
              Effect.gen(function* () {
                const nativeHistories = options.nativeHistories
                  ? yield* options.nativeHistories(connection)
                  : [];
                const source = { ...snapshot, nativeHistories };
                if (!stopForRestore) return yield* capture(source);
                if (!options.prepareRestore)
                  return yield* new AgentRuntimeProfileSnapshotError({
                    message: "Restore source preparation is unavailable",
                  });
                const copied = yield* options.prepareRestore(source);
                return yield* runtime.withStopped(
                  Effect.sync(() => {
                    stopped = true;
                  }).pipe(Effect.andThen(capture(copied))),
                  { retireOnSuccess: true, expectedConnection: connection },
                );
              }),
            ),
          ).pipe(Effect.exit);
          if (!stopped) {
            const released = yield* connection.request("storage.snapshot.release", {
              leaseId: snapshot.leaseId,
            });
            if (!released.released)
              return yield* new AgentRuntimeProfileSnapshotError({
                message: "Execution snapshot lease was lost",
              });
          }
          if (Exit.isFailure(captured)) return yield* Effect.failCause(captured.cause);
          return captured.value;
        }),
      );
    return {
      withOptionalSnapshot: <A, E, R>(
        capture: (source?: AgentRuntimeProfileSnapshotSource) => Effect.Effect<A, E, R>,
      ) =>
        admission.withSnapshot(
          Effect.gen(function* () {
            if (options.isUnused && !(yield* runtime.inspect) && (yield* options.isUnused))
              return yield* capture();
            return yield* withLease(capture);
          }),
        ),
      withSnapshot: <A, E, R>(
        capture: (source: AgentRuntimeProfileSnapshotSource) => Effect.Effect<A, E, R>,
      ) => admission.withSnapshot(withLease(capture)),
      withRestore: <A, E, R>(
        capture: (source: AgentRuntimeProfileSnapshotSource) => Effect.Effect<A, E, R>,
      ) => admission.withSnapshot(withLease(capture, true)),
    };
  });
});

export class AgentRuntimeProfileSnapshot extends Context.Service<
  AgentRuntimeProfileSnapshot,
  Effect.Success<ReturnType<typeof make>>
>()("nodex/main/agent-runtime/AgentRuntimeProfileSnapshot") {}
