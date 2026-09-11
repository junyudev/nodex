import type { FuzzyFileSearchSessionStartParams } from "@nodex/codex-app-server-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ComposerFileSearchEvent } from "../../shared/composer-file-search";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";

export interface ComposerFileSearchSession {
  readonly update: (query: string) => Effect.Effect<void, CodexRuntimeError>;
}

const isMissingSession = (error: CodexRuntimeError): boolean =>
  error.reason === "request" &&
  error.cause instanceof Error &&
  error.cause.message.toLowerCase().includes("fuzzy file search session not found");

/** The native app-server owns indexing and matching; this Scope owns its subscription and stop. */
export const makeComposerFileSearchSession = (
  input: FuzzyFileSearchSessionStartParams,
  onEvent: (event: ComposerFileSearchEvent) => Effect.Effect<void>,
): Effect.Effect<ComposerFileSearchSession, CodexRuntimeError, CodexGateway | Scope.Scope> =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const scope = yield* Scope.Scope;
    const hostId = gateway.localHostId;
    const lane = yield* Semaphore.make(1);
    let generation: number | null = null;
    let latestQuery: string | null = null;

    const start = Effect.gen(function* () {
      yield* gateway.awaitReady(hostId);
      const connection = yield* gateway.connection(hostId);
      if (connection.kind !== "ready") {
        return yield* codexRuntimeError({
          operation: "composer-file-search.start",
          reason: "session-lost",
          retryable: true,
          hostId,
        });
      }
      if (generation === connection.generation) return connection;
      yield* gateway.requestOnHost(
        hostId,
        "fuzzyFileSearch/sessionStart",
        input,
        codexGatewayGenerationFence(connection),
      );
      generation = connection.generation;
      return connection;
    });
    const updateQuery = (query: string): Effect.Effect<void, CodexRuntimeError> =>
      Effect.gen(function* () {
        latestQuery = query;
        yield* lane.withPermit(
          Effect.gen(function* () {
            if (latestQuery !== query) return;
            const connection = yield* start;
            const fence = codexGatewayGenerationFence(connection);
            yield* gateway
              .requestOnHost(
                hostId,
                "fuzzyFileSearch/sessionUpdate",
                { sessionId: input.sessionId, query },
                fence,
              )
              .pipe(
                Effect.catch((error) => {
                  if (!isMissingSession(error)) return Effect.fail(error);
                  return gateway
                    .requestOnHost(hostId, "fuzzyFileSearch/sessionStart", input, fence)
                    .pipe(
                      Effect.andThen(
                        gateway.requestOnHost(
                          hostId,
                          "fuzzyFileSearch/sessionUpdate",
                          { sessionId: input.sessionId, query },
                          fence,
                        ),
                      ),
                    );
                }),
              );
          }),
        );
      });

    yield* gateway.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "connection") {
          if (
            event.value.hostId !== hostId ||
            event.value.kind !== "ready" ||
            event.value.generation === generation ||
            latestQuery === null
          )
            return Effect.void;
          return updateQuery(latestQuery).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not restore composer file search", error),
            ),
          );
        }
        if (event.hostId !== hostId || event.generation !== generation) return Effect.void;
        if (event.value.protocol !== "generated") return Effect.void;
        const notification = event.value;
        if (
          notification.method !== "fuzzyFileSearch/sessionUpdated" &&
          notification.method !== "fuzzyFileSearch/sessionCompleted"
        )
          return Effect.void;
        if (notification.params.sessionId !== input.sessionId) return Effect.void;
        if (
          notification.method === "fuzzyFileSearch/sessionUpdated" &&
          notification.params.query !== latestQuery
        )
          return Effect.void;
        if (notification.method === "fuzzyFileSearch/sessionCompleted")
          return onEvent({ method: notification.method, params: notification.params });
        return onEvent({
          method: notification.method,
          params: {
            ...notification.params,
            files: notification.params.files.map((file) => ({
              ...file,
              indices: file.indices ? [...file.indices] : null,
            })),
          },
        });
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.acquireRelease(start, () => {
      if (generation === null) return Effect.void;
      return gateway
        .requestOnHost(
          hostId,
          "fuzzyFileSearch/sessionStop",
          { sessionId: input.sessionId },
          {
            expectedHostId: hostId,
            expectedGeneration: generation,
          },
        )
        .pipe(
          Effect.catch((error) => Effect.logWarning("Could not stop composer file search", error)),
          Effect.asVoid,
        );
    });
    return {
      update: (query) => updateQuery(query).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    };
  });
