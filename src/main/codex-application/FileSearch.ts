import type { FileSearchStartInput } from "../../shared/file-search";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { FileSearchEvent, FileSearchResult } from "../../shared/file-search";
import { createFuzzyQueryScorer, matchFuzzyQueryFragments } from "../../shared/fuzzy-query-match";
import { WorkspaceTextSearchPlatform } from "../platform/node/WorkspaceTextSearchPlatform";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";

export interface FileSearchSession {
  readonly update: (query: string) => Effect.Effect<void, CodexRuntimeError>;
}

const isMissingSession = (error: CodexRuntimeError): boolean =>
  error.reason === "request" &&
  error.cause instanceof Error &&
  error.cause.message.toLowerCase().includes("fuzzy file search session not found");

/** The native app-server owns indexing and matching; this Scope owns its subscription and stop. */
export const makeRemoteFileSearchSession = (
  input: FileSearchStartInput,
  onEvent: (event: FileSearchEvent) => Effect.Effect<void>,
): Effect.Effect<FileSearchSession, CodexRuntimeError, CodexGateway | Scope.Scope> =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const scope = yield* Scope.Scope;
    const { hostId, ...session } = input;
    const params = { ...session, roots: [...session.roots] };
    const lane = yield* Semaphore.make(1);
    let generation: number | null = null;
    let attemptedGeneration: number | null = null;
    let latestQuery: string | null = null;

    const start = Effect.gen(function* () {
      yield* gateway.awaitReady(hostId);
      const connection = yield* gateway.connection(hostId);
      if (connection.kind !== "ready") {
        return yield* codexRuntimeError({
          operation: "file-search.start",
          reason: "session-lost",
          retryable: true,
          hostId,
        });
      }
      if (generation === connection.generation) return connection;
      attemptedGeneration = connection.generation;
      yield* gateway.requestOnHost(
        hostId,
        "fuzzyFileSearch/sessionStart",
        params,
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
                    .requestOnHost(hostId, "fuzzyFileSearch/sessionStart", params, fence)
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

    // A cancelled or uncertain start may already have allocated the native index.
    yield* Effect.addFinalizer(() => {
      if (attemptedGeneration === null) return Effect.void;
      return gateway
        .requestOnHost(
          hostId,
          "fuzzyFileSearch/sessionStop",
          { sessionId: input.sessionId },
          {
            expectedHostId: hostId,
            expectedGeneration: attemptedGeneration,
          },
        )
        .pipe(
          Effect.catch((error) => Effect.logWarning("Could not stop file search", error)),
          Effect.asVoid,
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
            Effect.catch((error) => Effect.logWarning("Could not restore file search", error)),
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
    yield* start;
    return {
      update: (query) => updateQuery(query).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    };
  });

const MAX_ENTRIES = 150_000;
const MAX_PATH_UNITS = 16 * 1024 * 1024;
const MATCH_LIMIT = 50;
const RANKING_BATCH_SIZE = 512;
const UPDATE_INTERVAL_MS = 32;

type IndexedPath = Omit<FileSearchResult, "score" | "indices">;
type RankedPath = IndexedPath & {
  readonly score: number;
  readonly matchedText: string;
  readonly matchesName: boolean;
};

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compareMatches = (left: RankedPath, right: RankedPath) =>
  Number(right.matchesName) - Number(left.matchesName) ||
  right.score - left.score ||
  compareText(left.file_name, right.file_name) ||
  compareText(left.path, right.path) ||
  compareText(left.root, right.root);

function toResult(match: RankedPath, query: string): FileSearchResult {
  const { matchedText, matchesName, ...file } = match;
  const pathOffset = matchesName ? file.path.length - matchedText.length : 0;
  const fragments = matchFuzzyQueryFragments(matchedText, query);
  return {
    ...file,
    indices:
      fragments?.flatMap(({ startOffset, endOffset }) =>
        Array.from(
          { length: endOffset - startOffset },
          (_, index) => pathOffset + startOffset + index,
        ),
      ) ?? null,
  };
}

/** A mounted scope owns a fresh per-root snapshot. Query edits reuse it and supersede ranking. */
export const makeLocalFileSearchSession = Effect.fn("FileSearch.local")(function* (
  input: FileSearchStartInput,
  onEvent: (event: FileSearchEvent) => Effect.Effect<void>,
  windowsPaths: boolean,
) {
  const platform = yield* WorkspaceTextSearchPlatform;
  const jobs = yield* FiberMap.make<"query">();
  const indexChanged = yield* Queue.sliding<void>(1);
  const entries: IndexedPath[] = [];
  let pathUnits = 0;
  let indexState: "indexing" | "complete" | "failed" = "indexing";
  let revision = 0;

  const index = Effect.gen(function* () {
    for (const root of input.roots) {
      if (entries.length >= MAX_ENTRIES || pathUnits >= MAX_PATH_UNITS) break;
      const directories = new Set<string>();
      yield* platform.listLocalFiles(root, (paths) =>
        Effect.gen(function* () {
          const add = (entry: IndexedPath) => {
            if (entries.length >= MAX_ENTRIES || pathUnits + entry.path.length > MAX_PATH_UNITS) {
              pathUnits = MAX_PATH_UNITS;
              return false;
            }
            entries.push(entry);
            pathUnits += entry.path.length;
            return true;
          };
          const addPath = (file: string) => {
            const path = windowsPaths ? file.replaceAll("\\", "/") : file;
            if (!path || path.includes("\uFFFD")) return true;
            let separator = path.lastIndexOf("/");
            if (!add({ root, path, file_name: path.slice(separator + 1), match_type: "file" }))
              return false;
            while (separator > 0) {
              const directory = path.slice(0, separator);
              if (directories.has(directory)) return true;
              directories.add(directory);
              separator = directory.lastIndexOf("/");
              if (
                !add({
                  root,
                  path: directory,
                  file_name: directory.slice(separator + 1),
                  match_type: "directory",
                })
              )
                return false;
            }
            return true;
          };
          const continueListing = paths.every(addPath);
          yield* Queue.offer(indexChanged, undefined);
          return continueListing;
        }),
      );
    }
    indexState = "complete";
  }).pipe(
    Effect.catch((error) => {
      indexState = "failed";
      return Effect.logWarning("Could not index workspace files", error);
    }),
    Effect.andThen(Queue.offer(indexChanged, undefined)),
  );
  yield* index.pipe(Effect.forkScoped);

  const rank = Effect.fnUntraced(function* (query: string, generation: number) {
    const score = createFuzzyQueryScorer(query);
    const pathQuery = /[/\\]/u.test(query);
    const top: RankedPath[] = [];
    let offset = 0;
    let dirty = true;
    let publishedAt = -Infinity;

    const publish = Effect.fnUntraced(function* () {
      if (generation !== revision) return;
      yield* onEvent({
        method: "fuzzyFileSearch/sessionUpdated",
        params: {
          sessionId: input.sessionId,
          query,
          files: top.map((file) => toResult(file, query)),
        },
      });
      dirty = false;
      publishedAt = yield* Clock.currentTimeMillis;
    });

    while (true) {
      if (generation !== revision) return;
      const end = Math.min(entries.length, offset + RANKING_BATCH_SIZE);
      for (; offset < end; offset++) {
        const entry = entries[offset]!;
        const nameScore = pathQuery ? 0 : score(entry.file_name);
        const lowest = top.length === MATCH_LIMIT ? top[MATCH_LIMIT - 1] : undefined;
        if (!pathQuery && !nameScore && (lowest?.matchesName || entry.path === entry.file_name))
          continue;
        const matchedText = nameScore ? entry.file_name : entry.path;
        const value = nameScore || score(matchedText);
        if (!value) continue;
        const match = { ...entry, score: value, matchedText, matchesName: nameScore > 0 };
        if (lowest && compareMatches(match, lowest) >= 0) continue;
        let position = top.length;
        while (position > 0 && compareMatches(match, top[position - 1]!) < 0) position--;
        top.splice(position, 0, match);
        if (top.length > MATCH_LIMIT) top.pop();
        dirty = true;
      }
      if (indexState === "failed") {
        yield* onEvent({
          method: "file-search/sessionFailed",
          params: { sessionId: input.sessionId, query },
        });
        return;
      }
      if (indexState === "complete" && offset === entries.length) {
        if (dirty) yield* publish();
        if (generation === revision)
          yield* onEvent({
            method: "fuzzyFileSearch/sessionCompleted",
            params: { sessionId: input.sessionId, query },
          });
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (dirty && top.length > 0 && now - publishedAt >= UPDATE_INTERVAL_MS) yield* publish();
      if (offset === entries.length) yield* Queue.take(indexChanged);
      else yield* Effect.yieldNow;
    }
  });

  return {
    update: (query) =>
      Effect.suspend(() => {
        const generation = ++revision;
        if (!query) return FiberMap.remove(jobs, "query");
        return FiberMap.run(jobs, "query", rank(query, generation)).pipe(Effect.asVoid);
      }),
  } satisfies FileSearchSession;
});
