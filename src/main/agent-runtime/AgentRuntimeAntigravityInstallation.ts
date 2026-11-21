import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AntigravityRuntimeOperation,
  AntigravityRuntimeSnapshot,
} from "../../shared/antigravity-runtime";
import { AgentRuntimeApplication, agentRuntimeFailureReason } from "./AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";

type Runtime = Pick<AgentRuntimeSupervisor["Service"], "get" | "currentConnection" | "retained">;

export const make = Effect.fn("AgentRuntimeAntigravityInstallation.make")(function* (
  runtime: Runtime,
  refreshProviders: (instanceIds: readonly string[]) => Effect.Effect<unknown, unknown>,
) {
  const state = yield* SubscriptionRef.make<AntigravityRuntimeSnapshot>({
    revision: 0,
    inspection: null,
    operation: null,
  });
  const current = SubscriptionRef.get(state);
  const gate = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const publish = (next: Omit<AntigravityRuntimeSnapshot, "revision">) =>
    SubscriptionRef.modify(state, ({ revision }) => {
      const snapshot = { ...next, revision: revision + 1 };
      return [snapshot, snapshot];
    });
  const inspect = (startExecution: boolean) =>
    gate.withPermit(
      runtime.retained(
        Effect.gen(function* () {
          const previous = yield* current;
          if (previous.operation?.phase === "running") return previous;
          const connection = yield* startExecution ? runtime.get() : runtime.currentConnection;
          if (!connection) return previous;
          const inspection = yield* connection.request("providers.install.read", {
            driver: "antigravity",
            ...(startExecution ? { refresh: true } : {}),
          });
          return yield* publish({
            inspection,
            operation:
              previous.operation?.runtimeGeneration === inspection.runtimeGeneration
                ? previous.operation
                : null,
          });
        }),
      ),
    );

  const adopt = (operation: AntigravityRuntimeOperation) =>
    Effect.gen(function* () {
      const snapshot = yield* current;
      const active = snapshot.operation;
      if (
        !active ||
        operation.operationId !== active.operationId ||
        operation.runtimeGeneration !== active.runtimeGeneration ||
        operation.revision <= active.revision
      )
        return snapshot;
      return yield* publish({
        operation,
        inspection: operation.result ?? snapshot.inspection,
      });
    });

  const monitor = (
    connection: AgentRuntimeProcessConnection,
    initial: AntigravityRuntimeOperation,
  ) =>
    Effect.gen(function* () {
      let operation: AntigravityRuntimeOperation | null = initial;
      while (operation?.phase === "running") {
        yield* Effect.sleep("300 millis");
        operation = yield* gate.withPermit(
          Effect.gen(function* () {
            const latest = (yield* current).operation;
            if (!latest || latest.operationId !== initial.operationId) return null;
            if (latest.phase !== "running") return latest;
            const live = yield* runtime.currentConnection;
            if (connection.identity.runtimeGeneration !== live?.identity.runtimeGeneration)
              return yield* Effect.fail(
                new Error("Agent execution restarted during setup. Check the runtime and retry."),
              );
            const next = yield* connection
              .request("providers.install.operation.read", {
                operationId: initial.operationId,
              })
              .pipe(
                // A full request queue delays observation, but the runtime still owns the install.
                Effect.catch((error) =>
                  error.reason === "pressure" ? Effect.succeed(latest) : Effect.fail(error),
                ),
              );
            return (yield* adopt(next)).operation ?? latest;
          }),
        );
      }
      if (!operation) return;
      if (operation.phase === "succeeded")
        yield* refreshProviders(
          operation.result?.instances.map(({ instanceId }) => instanceId) ?? [],
        ).pipe(Effect.ignore({ log: true }));
      else yield* inspect(false).pipe(Effect.ignore({ log: true }));
    }).pipe(
      Effect.catch((cause) =>
        gate.withPermit(
          Effect.gen(function* () {
            const operation = (yield* current).operation;
            if (operation?.operationId !== initial.operationId || operation.phase !== "running")
              return;
            yield* publish({
              inspection: null,
              operation: {
                ...operation,
                revision: operation.revision + 1,
                phase: "failed",
                cancellable: false,
                error: {
                  reason: operation.kind === "install" ? "installation_failed" : "removal_failed",
                  message: agentRuntimeFailureReason(cause),
                },
              },
            });
          }),
        ),
      ),
    );

  const start = (kind: AntigravityRuntimeOperation["kind"]) =>
    gate.withPermit(
      Effect.gen(function* () {
        const snapshot = yield* current;
        if (snapshot.operation?.phase === "running") return snapshot;
        const operationId = randomUUID();
        return yield* runtime.retained(
          Effect.gen(function* () {
            const connection = yield* runtime.get();
            const operation = yield* connection.request(
              kind === "install" ? "providers.install.start" : "providers.install.remove",
              { driver: "antigravity", operationId },
            );
            // After admission the monitor owns observation independently of the requesting window.
            return yield* Effect.gen(function* () {
              const next = yield* publish({
                operation,
                inspection:
                  operation.result ??
                  (snapshot.inspection?.runtimeGeneration === operation.runtimeGeneration
                    ? snapshot.inspection
                    : null),
              });
              yield* runtime
                .retained(monitor(connection, operation))
                .pipe(Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }));
              return next;
            }).pipe(Effect.uninterruptible);
          }),
        );
      }),
    );

  const readOperation = (operationId: string) =>
    Effect.gen(function* () {
      const snapshot = yield* current;
      if (!snapshot.operation || snapshot.operation.operationId !== operationId)
        return yield* Effect.fail(new Error("This Antigravity operation is no longer available."));
      return snapshot;
    });

  return {
    read: inspect(false),
    check: inspect(true),
    start: start("install"),
    remove: start("remove"),
    readOperation,
    cancel: (operationId: string) =>
      gate.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* readOperation(operationId);
          const operation = snapshot.operation;
          if (operation?.phase !== "running" || !operation.cancellable) return snapshot;
          const connection = yield* runtime.currentConnection;
          if (connection?.identity.runtimeGeneration !== operation.runtimeGeneration)
            return snapshot;
          const next = yield* connection.request("providers.install.operation.cancel", {
            operationId,
          });
          // Let the monitor process a success that raced cancellation and refresh the catalog.
          return next.phase === "succeeded" ? snapshot : yield* adopt(next);
        }),
      ),
    changes: SubscriptionRef.changes(state),
  };
});

export class AgentRuntimeAntigravityInstallation extends Context.Service<
  AgentRuntimeAntigravityInstallation,
  Effect.Success<ReturnType<typeof make>>
>()("nodex/main/agent-runtime/AgentRuntimeAntigravityInstallation") {}

export const live = Layer.effect(
  AgentRuntimeAntigravityInstallation,
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeSupervisor;
    const providers = yield* AgentRuntimeApplication;
    return yield* make(runtime, (instanceIds) =>
      (instanceIds.length
        ? providers.catalogWhileRunning({ instanceIds, refresh: true }).pipe(Effect.asVoid)
        : Effect.void
      ).pipe(Effect.andThen(providers.knownCatalog())),
    );
  }),
);
