import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  availableCodexHistoryBoundary,
  exhaustedCodexHistoryBoundary,
  type CodexHistoryBoundary,
} from "../../shared/codex-conversation-state/codex-history-topology";
import {
  buildCodexPromptRailPreviews,
  CODEX_PROMPT_RAIL_LOAD_DEADLINE_MS,
  CODEX_PROMPT_RAIL_MAX_INDEX_BYTES,
  CODEX_PROMPT_RAIL_MAX_PAGES,
  CODEX_PROMPT_RAIL_MAX_SHELLS,
  CODEX_PROMPT_RAIL_PAGE_SIZE,
  CODEX_PROMPT_RAIL_STALE_MS,
  isValidCodexPromptRailDescendingOffset,
  type CodexPromptRailIndex,
  type CodexPromptRailReveal,
  type CodexPromptRailTurnShell,
} from "../../shared/codex-prompt-rail-history";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { projectCodexConversationOlderTurns } from "./CodexConversationHistoryProjection";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { placeCodexHistorySearchIsland } from "./CodexPersistedHistorySearchRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export const CODEX_PROMPT_RAIL_MAX_CACHE_ENTRIES = 32;
export const CODEX_PROMPT_RAIL_MAX_CACHE_BYTES = 16 * 1024 * 1024;

export interface CodexPromptRailHistoryOptions {
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly maxIndexBytes?: number;
  readonly loadDeadlineMs?: number;
  readonly staleMs?: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheBytes?: number;
  readonly now?: () => number;
}

export interface CodexPromptRailRevealInput {
  readonly requestId: string;
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly expectedTopologyGeneration: number;
  readonly shell: CodexPromptRailTurnShell;
  /** IPC cancellation stops mattering once the semantic island commit crosses this boundary. */
  readonly onCommitted?: (reveal: CodexPromptRailReveal) => void;
}

export interface CodexPromptRailKnownTurnRevealInput {
  readonly requestId: string;
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly expectedTopologyGeneration: number;
  readonly turnId: string;
  /** IPC cancellation stops mattering once the semantic island commit crosses this boundary. */
  readonly onCommitted?: (reveal: CodexPromptRailReveal) => void;
}

export class CodexPromptRailHistoryError extends Schema.TaggedError<CodexPromptRailHistoryError>()(
  "CodexPromptRailHistoryError",
  {
    operation: Schema.Literals(["index", "locate", "reveal", "generation", "topology", "install"]),
    threadId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    reason: Schema.Literals([
      "unsupported-capability",
      "stale-generation",
      "request-failed",
      "deadline-exceeded",
      "seek-budget-exhausted",
      "page-size-exceeded",
      "cursor-stalled",
      "turn-not-found",
      "invalid-reveal",
      "conversation-missing",
      "stale-topology",
      "placement-failed",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class CodexPromptRailHistory extends Context.Service<
  CodexPromptRailHistory,
  {
    readonly loadIndex: (
      threadId: string,
      options: {
        readonly expectedTopologyGeneration: number;
        readonly force?: boolean;
      },
    ) => Effect.Effect<CodexPromptRailIndex, CodexPromptRailHistoryError>;
    readonly reveal: (
      input: CodexPromptRailRevealInput,
    ) => Effect.Effect<CodexPromptRailReveal, CodexPromptRailHistoryError>;
    /** Explicit identity navigation is capped; a direct server identity lookup is not available. */
    readonly revealKnownTurn: (
      input: CodexPromptRailKnownTurnRevealInput,
    ) => Effect.Effect<CodexPromptRailReveal, CodexPromptRailHistoryError>;
  }
>()("nodex/main/codex-application/CodexPromptRailHistory") {}

type GatewayTurnPage = ClientRequestResponsesByMethod["thread/turns/list"];

interface CachedIndex {
  readonly index: CodexPromptRailIndex;
  readonly cacheBytes: number;
}

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

const approximateBytes = (value: unknown, limit: number): number =>
  cappedApproximateValueBytes(value, limit);

const historyError = (input: {
  readonly operation: CodexPromptRailHistoryError["operation"];
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly reason: CodexPromptRailHistoryError["reason"];
  readonly cause: unknown;
}) =>
  new CodexPromptRailHistoryError({
    operation: input.operation,
    threadId: input.threadId,
    turnId: input.turnId ?? null,
    reason: input.reason,
    cause: input.cause,
  });

const cacheKey = (snapshot: CodexAppServerCapabilitySnapshot, threadId: string): string =>
  `${snapshot.hostId}\u0000${snapshot.generation}\u0000${threadId}`;

export const make = (
  options: CodexPromptRailHistoryOptions = {},
): Effect.Effect<
  CodexPromptRailHistory["Service"],
  never,
  CodexAppServerCapabilities | CodexGateway | CodexHistoryPageAdapter | ConversationEntityMap
> =>
  Effect.gen(function* () {
    const capabilities = yield* CodexAppServerCapabilities;
    const gateway = yield* CodexGateway;
    const historyPages = yield* CodexHistoryPageAdapter;
    const conversations = yield* ConversationEntityMap;
    const maxPages = Math.min(
      positiveInteger(options.maxPages, CODEX_PROMPT_RAIL_MAX_PAGES),
      CODEX_PROMPT_RAIL_MAX_PAGES,
    );
    const pageSize = Math.min(
      positiveInteger(options.pageSize, CODEX_PROMPT_RAIL_PAGE_SIZE),
      CODEX_PROMPT_RAIL_PAGE_SIZE,
    );
    const maxShells = Math.min(maxPages * pageSize, CODEX_PROMPT_RAIL_MAX_SHELLS);
    const maxIndexBytes = Math.min(
      positiveInteger(options.maxIndexBytes, CODEX_PROMPT_RAIL_MAX_INDEX_BYTES),
      CODEX_PROMPT_RAIL_MAX_INDEX_BYTES,
    );
    const loadDeadlineMs = Math.min(
      positiveInteger(options.loadDeadlineMs, CODEX_PROMPT_RAIL_LOAD_DEADLINE_MS),
      CODEX_PROMPT_RAIL_LOAD_DEADLINE_MS,
    );
    const staleMs = positiveInteger(options.staleMs, CODEX_PROMPT_RAIL_STALE_MS);
    const maxCacheEntries = positiveInteger(
      options.maxCacheEntries,
      CODEX_PROMPT_RAIL_MAX_CACHE_ENTRIES,
    );
    const maxCacheBytes = positiveInteger(options.maxCacheBytes, CODEX_PROMPT_RAIL_MAX_CACHE_BYTES);
    const now = options.now ?? Date.now;
    const cache = new Map<string, CachedIndex>();
    let cachedBytes = 0;

    const removeCached = (key: string): void => {
      const current = cache.get(key);
      if (!current) return;
      cache.delete(key);
      cachedBytes -= current.cacheBytes;
    };

    const putCached = (key: string, index: CodexPromptRailIndex): void => {
      removeCached(key);
      const cacheBytes = approximateBytes(index, maxCacheBytes);
      if (cacheBytes > maxCacheBytes) return;
      cache.set(key, { index, cacheBytes });
      cachedBytes += cacheBytes;
      for (;;) {
        if (cache.size <= maxCacheEntries && cachedBytes <= maxCacheBytes) break;
        const oldestKey = cache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        removeCached(oldestKey);
      }
    };

    const validateSnapshot = Effect.fn("CodexPromptRailHistory.validateSnapshot")(
      function* (input: {
        readonly threadId: string;
        readonly hostId: string;
        readonly generation: number;
        readonly turnId?: string | null;
      }) {
        const snapshot = yield* capabilities.forThread(input.threadId).pipe(
          Effect.mapError((cause) =>
            historyError({
              operation: "generation",
              threadId: input.threadId,
              turnId: input.turnId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
        if (snapshot.hostId !== input.hostId || snapshot.generation !== input.generation) {
          return yield* historyError({
            operation: "generation",
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "stale-generation",
            cause: new Error("Prompt rail locator belongs to a stale app-server generation"),
          });
        }
        if (!snapshot.flags.paginatedHistory) {
          return yield* historyError({
            operation: "generation",
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "unsupported-capability",
            cause: new Error("Prompt rail history requires paginated Thread storage"),
          });
        }
        return snapshot;
      },
    );

    const failIfStale = Effect.fn("CodexPromptRailHistory.failIfStale")(function* (
      snapshot: CodexAppServerCapabilitySnapshot,
      threadId: string,
      turnId?: string | null,
    ) {
      const current = yield* capabilities.isCurrent(snapshot).pipe(
        Effect.mapError((cause) =>
          historyError({
            operation: "generation",
            threadId,
            turnId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
      if (current) return;
      return yield* historyError({
        operation: "generation",
        threadId,
        turnId,
        reason: "stale-generation",
        cause: new Error("Prompt rail request completed after its host generation was replaced"),
      });
    });

    const assertConversation = Effect.fn("CodexPromptRailHistory.assertConversation")(
      function* (input: {
        readonly threadId: string;
        readonly expectedTopologyGeneration: number;
        readonly turnId?: string | null;
      }) {
        const entity = conversations.current(input.threadId);
        if (!entity?.readSnapshot() || !entity.readCanonicalState()) {
          return yield* historyError({
            operation: "topology",
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "conversation-missing",
            cause: new Error("Prompt rail requires an installed canonical conversation"),
          });
        }
        if (entity.readHistoryTopology().generation !== input.expectedTopologyGeneration) {
          return yield* historyError({
            operation: "topology",
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "stale-topology",
            cause: new Error("Prompt rail request belongs to a stale history topology"),
          });
        }
        return entity;
      },
    );

    const listShellPage = Effect.fn("CodexPromptRailHistory.listShellPage")(function* (input: {
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly threadId: string;
      readonly cursor: string | null;
      readonly limit: number;
      readonly priority: "background" | "interactive";
      readonly operation: "index" | "locate" | "reveal";
      readonly turnId?: string | null;
    }): Effect.fn.Return<GatewayTurnPage, CodexPromptRailHistoryError> {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit <= 0 ||
        input.limit > CODEX_PROMPT_RAIL_PAGE_SIZE
      ) {
        return yield* historyError({
          operation: input.operation,
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "page-size-exceeded",
          cause: new Error(`Prompt rail Turn page limit ${input.limit} is invalid`),
        });
      }
      const response = yield* gateway
        .requestForThread(
          input.threadId,
          "thread/turns/list",
          {
            threadId: input.threadId,
            cursor: input.cursor,
            limit: input.limit,
            itemsView: "notLoaded",
            sortDirection: "desc",
          },
          {
            ...(input.priority === "background"
              ? { priority: "background", source: "tail_history" }
              : { priority: "interactive", source: "visible_history" }),
            ...codexGatewayGenerationFence(input.capability),
          },
        )
        .pipe(
          Effect.mapError((cause) =>
            historyError({
              operation: input.operation,
              threadId: input.threadId,
              turnId: input.turnId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
      if (response.data.length > input.limit) {
        return yield* historyError({
          operation: input.operation,
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "page-size-exceeded",
          cause: new Error(
            `Prompt rail Turn page returned ${response.data.length} entries for limit ${input.limit}`,
          ),
        });
      }
      return response;
    });

    const reveal = Effect.fn("CodexPromptRailHistory.reveal")(function* (
      input: CodexPromptRailRevealInput,
    ) {
      if (!isValidCodexPromptRailDescendingOffset(input.shell.descendingOffset)) {
        return yield* historyError({
          operation: "reveal",
          threadId: input.threadId,
          turnId: input.shell.turnId,
          reason: "invalid-reveal",
          cause: new Error("Prompt rail shell offset is invalid"),
        });
      }
      const snapshot = yield* validateSnapshot({ ...input, turnId: input.shell.turnId });
      const admittedEntity = yield* assertConversation({
        threadId: input.threadId,
        expectedTopologyGeneration: input.expectedTopologyGeneration,
        turnId: input.shell.turnId,
      });
      const admittedEntityGeneration = admittedEntity.generation;
      let cursor = input.shell.pageBackwardsCursor;
      if (input.shell.descendingOffset > 0) {
        const skipped = yield* listShellPage({
          capability: snapshot,
          threadId: input.threadId,
          cursor,
          limit: input.shell.descendingOffset,
          priority: "interactive",
          operation: "reveal",
          turnId: input.shell.turnId,
        });
        const nextCursor = skipped.nextCursor ?? null;
        if (nextCursor === null || nextCursor === cursor) {
          return yield* historyError({
            operation: "reveal",
            threadId: input.threadId,
            turnId: input.shell.turnId,
            reason: nextCursor === cursor ? "cursor-stalled" : "turn-not-found",
            cause: new Error("Prompt rail locator could not advance to the selected Turn"),
          });
        }
        cursor = nextCursor;
      }
      const page = yield* historyPages
        .loadTurnPage({
          capability: snapshot,
          threadId: input.threadId,
          cursor,
          initialItemsCursor: null,
          limit: 1,
          sortDirection: "desc",
          itemBudget: 100,
          purpose: "older",
        })
        .pipe(
          Effect.mapError((cause) =>
            historyError({
              operation: "reveal",
              threadId: input.threadId,
              turnId: input.shell.turnId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
      yield* failIfStale(snapshot, input.threadId, input.shell.turnId);
      const turn = page.turns[0];
      const pagination = turn ? page.itemsPaginationByTurnId[turn.id] : undefined;
      if (!turn || turn.id !== input.shell.turnId || !pagination) {
        return yield* historyError({
          operation: "reveal",
          threadId: input.threadId,
          turnId: input.shell.turnId,
          reason: "invalid-reveal",
          cause: new Error("Prompt rail reveal returned a different or unaddressable Turn"),
        });
      }
      const previews = buildCodexPromptRailPreviews({ turn, pagination });
      const islandId = `prompt-rail:${snapshot.generation}:${input.requestId}`;
      const boundary = (
        boundaryCursor: string | null,
        edge: "older" | "newer",
      ): CodexHistoryBoundary =>
        boundaryCursor === null
          ? exhaustedCodexHistoryBoundary(`${islandId}:${edge}`)
          : availableCodexHistoryBoundary(`${islandId}:${edge}`, {
              cursor: boundaryCursor,
              oldestLoadedTurnId: turn.id,
            });

      return yield* conversations.runCommand(
        input.threadId,
        Effect.gen(function* () {
          const currentEntity = conversations.current(input.threadId);
          const current = currentEntity?.readCanonicalState() ?? null;
          const topology = currentEntity?.readHistoryTopology() ?? null;
          if (
            currentEntity !== admittedEntity ||
            currentEntity?.generation !== admittedEntityGeneration ||
            !current ||
            !topology
          ) {
            return yield* historyError({
              operation: "install",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "conversation-missing",
              cause: new Error("Conversation generation changed during prompt reveal"),
            });
          }
          if (topology.generation !== input.expectedTopologyGeneration) {
            return yield* historyError({
              operation: "install",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "stale-topology",
              cause: new Error("History topology changed during prompt reveal"),
            });
          }

          const projected = yield* Effect.try({
            try: () =>
              projectCodexConversationOlderTurns({
                current,
                olderTurns: [turn],
                oldestLoadedTurnId: null,
                itemsPaginationByTurnId: { [turn.id]: pagination },
              }),
            catch: (cause) =>
              historyError({
                operation: "install",
                threadId: input.threadId,
                turnId: turn.id,
                reason: "placement-failed",
                cause,
              }),
          });
          const projectedTurn = projected.turns.find(
            (candidate) => candidate.protocol.id === turn.id,
          );
          const placement = projectedTurn
            ? placeCodexHistorySearchIsland({ topology, turns: [projectedTurn] })
            : null;
          if (!placement) {
            return yield* historyError({
              operation: "install",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "placement-failed",
              cause: new Error("Prompt reveal island could not be placed in history"),
            });
          }
          const committed = currentEntity.insertHistoryIsland({
            mutationId: input.requestId,
            expectedTopologyGeneration: input.expectedTopologyGeneration,
            index: placement.index,
            islandId,
            state: projected,
            turnIds: [turn.id],
            itemsPaginationByTurnId: { [turn.id]: pagination },
            olderBoundary: boundary(page.nextCursor, "older"),
            newerBoundary: boundary(page.backwardsCursor, "newer"),
            positionsByEntityKey: placement.positionsByEntityKey,
            observedAtMs: now(),
            projectReplica: false,
          });
          if (committed.status === "staleGeneration") {
            return yield* historyError({
              operation: "install",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "stale-topology",
              cause: new Error("History topology changed while installing prompt reveal"),
            });
          }
          if (committed.status === "rejected") {
            return yield* historyError({
              operation: "install",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "placement-failed",
              cause: new Error(committed.reason),
            });
          }
          const reveal = {
            threadId: input.threadId,
            hostId: snapshot.hostId,
            generation: snapshot.generation,
            turnId: turn.id,
            topologyGeneration: committed.topologyGeneration,
            previews,
            mutation: committed.mutation,
          } satisfies CodexPromptRailReveal;
          input.onCommitted?.(reveal);
          return reveal;
        }),
      );
    });

    const loadIndexPhysical = Effect.fn("CodexPromptRailHistory.loadIndexPhysical")(function* (
      threadId: string,
      loadOptions: { readonly force?: boolean } = {},
    ) {
      const snapshot = yield* capabilities.forThread(threadId).pipe(
        Effect.mapError((cause) =>
          historyError({
            operation: "index",
            threadId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
      if (!snapshot.flags.paginatedHistory) {
        return yield* historyError({
          operation: "index",
          threadId,
          reason: "unsupported-capability",
          cause: new Error("Prompt rail history requires paginated Thread storage"),
        });
      }
      const key = cacheKey(snapshot, threadId);
      const cached = cache.get(key);
      if (!loadOptions.force && cached && now() - cached.index.loadedAtMs < staleMs) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.index;
      }
      if (cached) removeCached(key);

      const shells: CodexPromptRailTurnShell[] = [];
      const seenCursors = new Set<string | null>();
      let cursor: string | null = null;
      let indexBytes = 0;
      let complete = false;
      let truncatedBy: CodexPromptRailIndex["truncatedBy"] = null;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        if (seenCursors.has(cursor)) {
          return yield* historyError({
            operation: "index",
            threadId,
            reason: "cursor-stalled",
            cause: new Error("Prompt rail skeleton cursor repeated"),
          });
        }
        seenCursors.add(cursor);
        const page: GatewayTurnPage = yield* listShellPage({
          capability: snapshot,
          threadId,
          cursor,
          limit: pageSize,
          priority: "background",
          operation: "index",
        });
        let exceededBytes = false;
        for (const [descendingOffset, turn] of page.data.entries()) {
          if (shells.length >= maxShells) break;
          const shell = {
            turnId: turn.id,
            pageBackwardsCursor: page.backwardsCursor ?? null,
            descendingOffset,
          } satisfies CodexPromptRailTurnShell;
          const shellBytes = approximateBytes(shell, maxIndexBytes - indexBytes);
          if (indexBytes + shellBytes > maxIndexBytes) {
            exceededBytes = true;
            truncatedBy = "byte-budget";
            break;
          }
          shells.push(shell);
          indexBytes += shellBytes;
        }
        if (exceededBytes) break;
        const pageNextCursor = page.nextCursor ?? null;
        if (pageNextCursor === null) {
          complete = true;
          break;
        }
        if (pageNextCursor === cursor) {
          return yield* historyError({
            operation: "index",
            threadId,
            reason: "cursor-stalled",
            cause: new Error("Prompt rail skeleton cursor did not advance"),
          });
        }
        cursor = pageNextCursor;
      }
      if (!complete && truncatedBy === null) truncatedBy = "page-budget";
      yield* failIfStale(snapshot, threadId);
      const index = {
        threadId,
        hostId: snapshot.hostId,
        generation: snapshot.generation,
        shells: shells.reverse(),
        complete,
        truncatedBy,
        approximateBytes: indexBytes,
        loadedAtMs: now(),
      } satisfies CodexPromptRailIndex;
      putCached(key, index);
      return index;
    });

    const loadIndex = Effect.fn("CodexPromptRailHistory.loadIndex")(function* (
      threadId: string,
      loadOptions: {
        readonly expectedTopologyGeneration: number;
        readonly force?: boolean;
      },
    ) {
      yield* assertConversation({
        threadId,
        expectedTopologyGeneration: loadOptions.expectedTopologyGeneration,
      });
      const result = yield* loadIndexPhysical(threadId, loadOptions).pipe(
        Effect.timeoutOption(loadDeadlineMs),
      );
      if (Option.isSome(result)) {
        yield* assertConversation({
          threadId,
          expectedTopologyGeneration: loadOptions.expectedTopologyGeneration,
        });
        return result.value;
      }
      return yield* historyError({
        operation: "index",
        threadId,
        reason: "deadline-exceeded",
        cause: new Error("Prompt rail shell index exceeded its bounded load deadline"),
      });
    });

    const revealKnownTurnPhysical = Effect.fn("CodexPromptRailHistory.revealKnownTurnPhysical")(
      function* (input: CodexPromptRailKnownTurnRevealInput) {
        const snapshot = yield* validateSnapshot(input);
        yield* assertConversation(input);
        let cursor: string | null = null;
        for (let requestedPages = 0; requestedPages < maxPages; requestedPages += 1) {
          const page: GatewayTurnPage = yield* listShellPage({
            capability: snapshot,
            threadId: input.threadId,
            cursor,
            limit: pageSize,
            priority: "interactive",
            operation: "locate",
            turnId: input.turnId,
          });
          yield* failIfStale(snapshot, input.threadId, input.turnId);
          yield* assertConversation(input);
          const descendingOffset = page.data.findIndex((turn) => turn.id === input.turnId);
          if (descendingOffset >= 0) {
            yield* failIfStale(snapshot, input.threadId, input.turnId);
            return yield* reveal({
              requestId: input.requestId,
              threadId: input.threadId,
              hostId: input.hostId,
              generation: input.generation,
              expectedTopologyGeneration: input.expectedTopologyGeneration,
              onCommitted: input.onCommitted,
              shell: {
                turnId: input.turnId,
                pageBackwardsCursor: page.backwardsCursor ?? null,
                descendingOffset,
              },
            });
          }
          const pageNextCursor = page.nextCursor ?? null;
          if (pageNextCursor === null) {
            return yield* historyError({
              operation: "locate",
              threadId: input.threadId,
              turnId: input.turnId,
              reason: "turn-not-found",
              cause: new Error("Known prompt Turn no longer exists"),
            });
          }
          if (pageNextCursor === cursor) {
            return yield* historyError({
              operation: "locate",
              threadId: input.threadId,
              turnId: input.turnId,
              reason: "cursor-stalled",
              cause: new Error("Known-Turn prompt rail seek did not advance"),
            });
          }
          cursor = pageNextCursor;
        }
        return yield* historyError({
          operation: "locate",
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "seek-budget-exhausted",
          cause: new Error(
            `Known-Turn prompt rail seek exhausted its ${maxPages}-page request budget`,
          ),
        });
      },
    );

    const revealKnownTurn = Effect.fn("CodexPromptRailHistory.revealKnownTurn")(function* (
      input: CodexPromptRailKnownTurnRevealInput,
    ) {
      const result = yield* revealKnownTurnPhysical(input).pipe(
        Effect.timeoutOption(loadDeadlineMs),
      );
      if (Option.isSome(result)) return result.value;
      return yield* historyError({
        operation: "locate",
        threadId: input.threadId,
        turnId: input.turnId,
        reason: "deadline-exceeded",
        cause: new Error("Known-Turn prompt rail seek exceeded its bounded deadline"),
      });
    });

    return CodexPromptRailHistory.of({ loadIndex, reveal, revealKnownTurn });
  });
