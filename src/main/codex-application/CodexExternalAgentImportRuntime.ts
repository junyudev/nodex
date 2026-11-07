import type { ExternalAgentConfigImportCompletedNotification } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigImportCompletedNotification";
import type { ExternalAgentConfigImportProgressNotification } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigImportProgressNotification";
import type { ExternalAgentConfigImportResponse } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigImportResponse";
import type { ExternalAgentConfigMigrationItem } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { MAIN_RELIABLE_COMMAND_CAPACITY } from "../runtime-limits";

export const DEFAULT_CODEX_EXTERNAL_AGENT_IMPORT_TIMEOUT = "2 minutes";

type ImportNotification =
  | {
      readonly method: "externalAgentConfig/import/progress";
      readonly params: ExternalAgentConfigImportProgressNotification;
    }
  | {
      readonly method: "externalAgentConfig/import/completed";
      readonly params: ExternalAgentConfigImportCompletedNotification;
    };

export class CodexExternalAgentImportError extends Data.TaggedError(
  "CodexExternalAgentImportError",
)<{
  readonly reason: "request-failed" | "runtime-closed" | "timeout";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CodexExternalAgentImportRuntimeOptions {
  readonly timeout?: Duration.Input;
}

export class CodexExternalAgentImportRuntime extends Context.Service<
  CodexExternalAgentImportRuntime,
  {
    readonly run: (
      items: readonly ExternalAgentConfigMigrationItem[],
    ) => Effect.Effect<
      ExternalAgentConfigImportCompletedNotification,
      CodexExternalAgentImportError
    >;
  }
>()("nodex/main/codex-application/CodexExternalAgentImportRuntime") {}

const relevantNotification = (
  event: CodexEndpointEvent,
  hostId: string,
): ImportNotification | null => {
  if (event.kind !== "notification" || event.hostId !== hostId) return null;
  if (event.value.method === "externalAgentConfig/import/progress") {
    return {
      method: event.value.method,
      params: event.value.params as ExternalAgentConfigImportProgressNotification,
    };
  }
  if (event.value.method === "externalAgentConfig/import/completed") {
    return {
      method: event.value.method,
      params: event.value.params as ExternalAgentConfigImportCompletedNotification,
    };
  }
  return null;
};

export const make = (
  options: CodexExternalAgentImportRuntimeOptions = {},
): Effect.Effect<CodexExternalAgentImportRuntime["Service"], never, CodexGateway | Scope.Scope> =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const admission = yield* Semaphore.make(1);
    const closed = yield* Latch.make();
    yield* Effect.addFinalizer(() => closed.open);

    const runImport = (items: readonly ExternalAgentConfigMigrationItem[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const notifications = yield* Queue.bounded<ImportNotification>(
            MAIN_RELIABLE_COMMAND_CAPACITY,
          );
          yield* Effect.addFinalizer(() => Queue.shutdown(notifications).pipe(Effect.asVoid));
          yield* gateway.events.pipe(
            Stream.runForEach((event) => {
              const notification = relevantNotification(event, gateway.localHostId);
              return notification === null
                ? Effect.void
                : Queue.offer(notifications, notification).pipe(Effect.asVoid);
            }),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;

          const response: ExternalAgentConfigImportResponse = yield* gateway
            .requestLocal("externalAgentConfig/import", { migrationItems: [...items] })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CodexExternalAgentImportError({
                    reason: "request-failed",
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not start the Claude Code import",
                    cause,
                  }),
              ),
            );
          const awaitCompletion: Effect.Effect<ExternalAgentConfigImportCompletedNotification> =
            Effect.suspend(() =>
              Queue.take(notifications).pipe(
                Effect.flatMap((notification) => {
                  return notification.params.importId !== response.importId ||
                    notification.method === "externalAgentConfig/import/progress"
                    ? awaitCompletion
                    : Effect.succeed(notification.params);
                }),
              ),
            );
          return yield* awaitCompletion;
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: options.timeout ?? DEFAULT_CODEX_EXTERNAL_AGENT_IMPORT_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new CodexExternalAgentImportError({
                reason: "timeout",
                message: "Timed out waiting for Claude Code import to finish",
              }),
            ),
        }),
      );

    return CodexExternalAgentImportRuntime.of({
      run: (items) =>
        Effect.raceFirst(
          admission.withPermits(1)(runImport(items)),
          closed.await.pipe(
            Effect.andThen(
              Effect.fail(
                new CodexExternalAgentImportError({
                  reason: "runtime-closed",
                  message: "The agent import runtime is closing",
                }),
              ),
            ),
          ),
        ),
    });
  });
