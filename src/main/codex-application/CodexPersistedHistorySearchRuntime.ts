import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  CodexPersistedHistorySearchPage,
  CodexPersistedHistorySearchResult,
} from "../../shared/codex-persisted-history-search";
import { CodexHistorySearchAdapter } from "./CodexHistorySearchAdapter";
import {
  CodexThreadHistoryFeatures,
  type CodexThreadHistoryFeaturesError,
} from "./CodexThreadHistoryFeatures";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
export class CodexPersistedHistorySearchError extends Data.TaggedError(
  "CodexPersistedHistorySearchError",
)<{
  readonly operation: "search" | "hydrate" | "retry" | "placement";
  readonly threadId: string;
  readonly reason:
    | "conversation-missing"
    | "stale-generation"
    | "superseded"
    | "placement-failed"
    | "selected-item-missing"
    | "request-failed";
  readonly cause: unknown;
}> {}

export class CodexPersistedHistorySearchRuntime extends Context.Service<
  CodexPersistedHistorySearchRuntime,
  {
    readonly search: (
      threadId: string,
      query: string,
    ) => Effect.Effect<CodexPersistedHistorySearchResult, CodexPersistedHistorySearchError>;
  }
>()("nodex/main/codex-application/CodexPersistedHistorySearchRuntime") {}

const runtimeError = (input: {
  readonly operation: CodexPersistedHistorySearchError["operation"];
  readonly threadId: string;
  readonly reason: CodexPersistedHistorySearchError["reason"];
  readonly cause: unknown;
}) => new CodexPersistedHistorySearchError(input);

export const make = Effect.gen(function* () {
  const searchAdapter = yield* CodexHistorySearchAdapter;
  const historyFeatures = yield* CodexThreadHistoryFeatures;
  const conversations = yield* ConversationEntityMap;
  const search = Effect.fn("CodexPersistedHistorySearchRuntime.search")(function* (
    threadId: string,
    query: string,
  ) {
    const admitted = conversations.current(threadId);
    if (!admitted?.readCanonicalState()) {
      return {
        status: "unavailable" as const,
        feature: "persisted-search" as const,
        reason: "resident-only" as const,
        threadId,
      };
    }
    const requireAdmittedConversation = () => {
      const current = conversations.current(threadId);
      if (admitted && current === admitted && current.readCanonicalState())
        return Effect.succeed(current);
      return Effect.fail(
        runtimeError({
          operation: "search",
          threadId,
          reason: current && current !== admitted ? "superseded" : "conversation-missing",
          cause: new Error("Conversation changed while searching persisted history"),
        }),
      );
    };
    const mapFeatureError = (cause: CodexThreadHistoryFeaturesError) =>
      runtimeError({
        operation: "search",
        threadId,
        reason:
          cause.reason === "conversation-missing"
            ? "conversation-missing"
            : cause.reason === "stale-generation"
              ? "stale-generation"
              : "request-failed",
        cause,
      });
    const availability = yield* historyFeatures
      .resolve(threadId, "persisted-search")
      .pipe(Effect.mapError(mapFeatureError));
    if (availability.status === "unavailable") return availability;
    yield* requireAdmittedConversation();

    const pageResult = yield* Effect.result(searchAdapter.search({ threadId, searchTerm: query }));
    if (Result.isFailure(pageResult)) {
      if (pageResult.failure.reason === "unsupported-capability") {
        const latest = yield* historyFeatures
          .resolve(threadId, "persisted-search")
          .pipe(Effect.mapError(mapFeatureError));
        if (latest.status === "unavailable") return latest;
      }
      return yield* runtimeError({
        operation: "search",
        threadId,
        reason:
          pageResult.failure.reason === "stale-generation" ? "stale-generation" : "request-failed",
        cause: pageResult.failure,
      });
    }
    const page = pageResult.success;
    const aggregate = yield* requireAdmittedConversation();
    if (
      page.hostId !== availability.capability.hostId ||
      page.generation !== availability.capability.generation
    ) {
      return yield* runtimeError({
        operation: "search",
        threadId,
        reason: "stale-generation",
        cause: new Error("Persisted search returned from a different native generation"),
      });
    }
    return {
      status: "completed" as const,
      page: {
        threadId,
        query,
        hostId: page.hostId,
        hostGeneration: page.generation,
        topologyGeneration: aggregate.readHistoryTopology().generation,
        occurrences: [...page.occurrences],
        capped: page.isCapped,
      } satisfies CodexPersistedHistorySearchPage,
    };
  });

  return CodexPersistedHistorySearchRuntime.of({ search });
});
