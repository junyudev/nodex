import type {
  SortDirection,
  ThreadItem,
  ThreadSearchOccurrence,
  Turn,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  ClientRequestMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  availableCodexHistoryBoundary,
  exhaustedCodexHistoryBoundary,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
  type CodexHistoryTurnItemsPagination,
  type CreateCodexHistoryIslandInput,
} from "../../shared/codex-conversation-state/codex-history-topology";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";

export const CODEX_HISTORY_SEARCH_OCCURRENCE_LIMIT = 250;
/** Renderer-visible query and occurrence indexes stay small enough to copy without RPC-sized spikes. */
export const CODEX_HISTORY_SEARCH_TERM_MAX_BYTES = 16 * 1024;
export const CODEX_HISTORY_SEARCH_OCCURRENCE_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const CODEX_HISTORY_SEARCH_OCCURRENCE_MAX_BYTES = 128 * 1024;
export const CODEX_HISTORY_SEARCH_OCCURRENCE_ID_MAX_LENGTH = 1_024;
export const CODEX_HISTORY_SEARCH_OCCURRENCE_CURSOR_MAX_LENGTH = 4_096;
export const CODEX_HISTORY_SEARCH_OCCURRENCE_SNIPPET_MAX_LENGTH = 64 * 1024;
export const CODEX_HISTORY_SEARCH_TURN_RADIUS_PAGE_SIZE = 5;
export const CODEX_HISTORY_SEARCH_ITEM_PAGE_SIZE = 100;
export const CODEX_HISTORY_SEARCH_MAX_ITEM_PAGE_REQUESTS_PER_DIRECTION = 20;
export const CODEX_HISTORY_SEARCH_DIRECTION_ITEM_LIMIT = 500;
export const CODEX_HISTORY_SEARCH_DIRECTION_BYTE_LIMIT = 8 * 1024 * 1024;
export const CODEX_HISTORY_SEARCH_SELECTED_ITEM_LIMIT = 2_000;
export const CODEX_HISTORY_SEARCH_SELECTED_BYTE_LIMIT = 16 * 1024 * 1024;

const SEARCH_SCHEDULING = {
  priority: "interactive",
  source: "thread",
} as const;

const HYDRATION_SCHEDULING = {
  priority: "interactive",
  source: "thread_hydration",
} as const;

export interface CodexHistorySearchAdapterOptions {
  readonly selectedItemLimit?: number;
  readonly selectedByteLimit?: number;
  readonly directionItemLimit?: number;
  readonly directionByteLimit?: number;
}

export interface CodexHistorySearchPage {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly occurrences: readonly ThreadSearchOccurrence[];
  readonly isCapped: boolean;
}

export interface CodexHistorySearchInput {
  readonly threadId: string;
  /** Passed through verbatim; app-server implements a case-insensitive literal substring. */
  readonly searchTerm: string;
}

export interface CodexHistoryOccurrenceHydrationInput {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly occurrence: ThreadSearchOccurrence;
}

export type CodexHistorySearchIslandInput = Omit<CreateCodexHistoryIslandInput<Turn>, "generation">;

export type CodexHistorySelectedItemResolution =
  | {
      readonly status: "found";
      readonly item: ThreadItem;
      readonly inspectedItemCount: number;
      readonly inspectedBytes: number;
    }
  | {
      readonly status: "bounded-incomplete";
      readonly reason: "item-count-limit" | "item-byte-limit";
      readonly inspectedItemCount: number;
      readonly inspectedBytes: number;
      readonly nextCursor: string | null;
    };

export interface CodexHistoryOccurrenceHydration {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly occurrence: ThreadSearchOccurrence;
  readonly turns: readonly Turn[];
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly selection: CodexHistorySelectedItemResolution;
  /** Can be passed directly to `insertCodexHistoryIsland` after choosing an insertion index. */
  readonly island: CodexHistorySearchIslandInput;
}

export class CodexHistorySearchAdapterError extends Schema.TaggedError<CodexHistorySearchAdapterError>()(
  "CodexHistorySearchAdapterError",
  {
    operation: Schema.Literals(["search", "turns", "items", "opening-user", "generation"]),
    threadId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    reason: Schema.Literals([
      "invalid-search-term",
      "unsupported-capability",
      "stale-generation",
      "request-failed",
      "page-size-exceeded",
      "page-byte-limit",
      "invalid-occurrence",
      "item-byte-limit",
      "cursor-stalled",
      "foreign-item",
      "anchor-missing",
      "selected-item-missing",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class CodexHistorySearchAdapter extends Context.Service<
  CodexHistorySearchAdapter,
  {
    readonly search: (
      input: CodexHistorySearchInput,
    ) => Effect.Effect<CodexHistorySearchPage, CodexHistorySearchAdapterError>;
    readonly hydrateOccurrence: (
      input: CodexHistoryOccurrenceHydrationInput,
    ) => Effect.Effect<CodexHistoryOccurrenceHydration, CodexHistorySearchAdapterError>;
  }
>()("nodex/main/codex-application/CodexHistorySearchAdapter") {}

type GatewayTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];

interface HydratedTurnPage {
  readonly turns: readonly Turn[];
  readonly nextCursor: string | null;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}

interface LoadedItemPage {
  readonly items: readonly ThreadItem[];
  readonly nextCursor: string | null;
  readonly rawItemCount: number;
  readonly approximateBytes: number;
}

const approximateValueBytes = (
  value: unknown,
  limit = CODEX_HISTORY_SEARCH_SELECTED_BYTE_LIMIT,
): number => cappedApproximateValueBytes(value, limit);

const invalidOccurrenceCause = (value: unknown): Error | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("Persisted-history occurrence must be an object");
  }
  const occurrence = value as Partial<ThreadSearchOccurrence>;
  const boundedId = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= CODEX_HISTORY_SEARCH_OCCURRENCE_ID_MAX_LENGTH;
  if (!boundedId(occurrence.turnId) || !boundedId(occurrence.itemId)) {
    return new Error("Persisted-history occurrence ids must be bounded non-empty strings");
  }
  if (
    typeof occurrence.turnCursor !== "string" ||
    occurrence.turnCursor.length === 0 ||
    occurrence.turnCursor.length > CODEX_HISTORY_SEARCH_OCCURRENCE_CURSOR_MAX_LENGTH
  ) {
    return new Error("Persisted-history occurrence cursor must be a bounded non-empty string");
  }
  if (
    typeof occurrence.snippet !== "string" ||
    occurrence.snippet.length > CODEX_HISTORY_SEARCH_OCCURRENCE_SNIPPET_MAX_LENGTH
  ) {
    return new Error("Persisted-history occurrence snippet exceeds its length budget");
  }
  const range = occurrence.snippetMatchRange;
  if (
    typeof range !== "object" ||
    range === null ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > occurrence.snippet.length
  ) {
    return new Error("Persisted-history occurrence match range is invalid");
  }
  if (
    cappedApproximateValueBytes(occurrence, CODEX_HISTORY_SEARCH_OCCURRENCE_MAX_BYTES) >
    CODEX_HISTORY_SEARCH_OCCURRENCE_MAX_BYTES
  ) {
    return new Error("Persisted-history occurrence exceeds its byte budget");
  }
  return null;
};

const adapterError = (input: {
  readonly operation: CodexHistorySearchAdapterError["operation"];
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly reason: CodexHistorySearchAdapterError["reason"];
  readonly cause: unknown;
}) =>
  new CodexHistorySearchAdapterError({
    operation: input.operation,
    threadId: input.threadId,
    turnId: input.turnId ?? null,
    reason: input.reason,
    cause: input.cause,
  });

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

const normalizeTurn = (
  turn: GatewayTurn,
  items: readonly ThreadItem[],
  itemsView: Turn["itemsView"],
): Turn =>
  ({
    ...turn,
    items: [...items],
    itemsView,
    error: turn.error ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
  }) as Turn;

const dedupeItems = (items: readonly ThreadItem[]): readonly ThreadItem[] => {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
};

const selectedItem = (turn: Turn, itemId: string): ThreadItem | null =>
  turn.items.find((item) => item.id === itemId) ?? null;

export const make = (
  options: CodexHistorySearchAdapterOptions = {},
): Effect.Effect<
  CodexHistorySearchAdapter["Service"],
  never,
  CodexGateway | CodexAppServerCapabilities
> =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const capabilities = yield* CodexAppServerCapabilities;
    const selectedItemLimit = positiveInteger(
      options.selectedItemLimit,
      CODEX_HISTORY_SEARCH_SELECTED_ITEM_LIMIT,
    );
    const selectedByteLimit = positiveInteger(
      options.selectedByteLimit,
      CODEX_HISTORY_SEARCH_SELECTED_BYTE_LIMIT,
    );
    const directionItemLimit = Math.min(
      positiveInteger(options.directionItemLimit, CODEX_HISTORY_SEARCH_DIRECTION_ITEM_LIMIT),
      selectedItemLimit,
    );
    const directionByteLimit = Math.min(
      positiveInteger(options.directionByteLimit, CODEX_HISTORY_SEARCH_DIRECTION_BYTE_LIMIT),
      selectedByteLimit,
    );
    let nextIslandSequence = 1;

    const failIfStale = Effect.fn("CodexHistorySearchAdapter.failIfStale")(function* (
      snapshot: CodexAppServerCapabilitySnapshot,
      threadId: string,
    ) {
      const current = yield* capabilities.isCurrent(snapshot).pipe(
        Effect.mapError((cause) =>
          adapterError({
            operation: "generation",
            threadId,
            reason: "request-failed",
            cause,
          }),
        ),
      );
      if (current) return;
      return yield* adapterError({
        operation: "generation",
        threadId,
        reason: "stale-generation",
        cause: new Error(
          `Codex host '${snapshot.hostId}' generation ${snapshot.generation} is no longer current`,
        ),
      });
    });

    const fencedRequest = <M extends ClientRequestMethod>(input: {
      readonly snapshot: CodexAppServerCapabilitySnapshot;
      readonly threadId: string;
      readonly method: M;
      readonly params: ClientRequestParamsByMethod[M];
      readonly operation: CodexHistorySearchAdapterError["operation"];
      readonly turnId?: string | null;
      readonly scheduling: typeof SEARCH_SCHEDULING | typeof HYDRATION_SCHEDULING;
    }): Effect.Effect<ClientRequestResponsesByMethod[M], CodexHistorySearchAdapterError> =>
      Effect.gen(function* () {
        yield* failIfStale(input.snapshot, input.threadId);
        const response = yield* gateway
          .requestForThread(input.threadId, input.method, input.params, {
            ...input.scheduling,
            ...codexGatewayGenerationFence(input.snapshot),
          })
          .pipe(
            Effect.mapError((cause) =>
              adapterError({
                operation: input.operation,
                threadId: input.threadId,
                turnId: input.turnId,
                reason: "request-failed",
                cause,
              }),
            ),
          );
        yield* failIfStale(input.snapshot, input.threadId);
        return response;
      });

    const capabilityForThread = Effect.fn("CodexHistorySearchAdapter.capabilityForThread")(
      function* (threadId: string) {
        const snapshot = yield* capabilities.forThread(threadId).pipe(
          Effect.mapError((cause) =>
            adapterError({
              operation: "generation",
              threadId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
        if (snapshot.flags.searchOccurrences) return snapshot;
        return yield* adapterError({
          operation: "search",
          threadId,
          reason: "unsupported-capability",
          cause: new Error(
            `Codex host '${snapshot.hostId}' does not support persisted-history occurrences`,
          ),
        });
      },
    );

    const loadItemsPage = Effect.fn("CodexHistorySearchAdapter.loadItemsPage")(function* (input: {
      readonly snapshot: CodexAppServerCapabilitySnapshot;
      readonly threadId: string;
      readonly turnId: string;
      readonly cursor: string | null;
      readonly limit: number;
      readonly sortDirection: SortDirection;
      readonly operation?: "items" | "opening-user";
    }) {
      const response = yield* fencedRequest({
        snapshot: input.snapshot,
        threadId: input.threadId,
        method: "thread/items/list",
        params: {
          threadId: input.threadId,
          turnId: input.turnId,
          cursor: input.cursor,
          limit: input.limit,
          sortDirection: input.sortDirection,
        },
        operation: input.operation ?? "items",
        turnId: input.turnId,
        scheduling: HYDRATION_SCHEDULING,
      });
      if (response.data.length > input.limit) {
        return yield* adapterError({
          operation: input.operation ?? "items",
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "page-size-exceeded",
          cause: new Error(
            `Item page for turn '${input.turnId}' returned ${response.data.length} entries for limit ${input.limit}`,
          ),
        });
      }
      if (response.nextCursor !== null && response.nextCursor === input.cursor) {
        return yield* adapterError({
          operation: input.operation ?? "items",
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "cursor-stalled",
          cause: new Error(`Item cursor did not advance for turn '${input.turnId}'`),
        });
      }
      const wireItems: ThreadItem[] = [];
      for (const entry of response.data) {
        if (entry.turnId !== input.turnId) {
          return yield* adapterError({
            operation: input.operation ?? "items",
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "foreign-item",
            cause: new Error(
              `Expected items for turn '${input.turnId}' but received '${entry.turnId}'`,
            ),
          });
        }
        wireItems.push(entry.item as unknown as ThreadItem);
      }
      if (wireItems.length === 0 && response.nextCursor !== null) {
        return yield* adapterError({
          operation: input.operation ?? "items",
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "cursor-stalled",
          cause: new Error(`Item page made no progress for turn '${input.turnId}'`),
        });
      }
      return {
        items: input.sortDirection === "desc" ? wireItems.reverse() : wireItems,
        nextCursor: response.nextCursor ?? null,
        rawItemCount: response.data.length,
        approximateBytes: approximateValueBytes(response.data),
      } satisfies LoadedItemPage;
    });

    const loadOpeningUser = Effect.fn("CodexHistorySearchAdapter.loadOpeningUser")(function* (
      snapshot: CodexAppServerCapabilitySnapshot,
      threadId: string,
      turn: GatewayTurn,
    ) {
      const opening = yield* loadItemsPage({
        snapshot,
        threadId,
        turnId: turn.id,
        cursor: null,
        limit: 2,
        sortDirection: "asc",
        operation: "opening-user",
      });
      const firstVisible = opening.items.find((item) => item.type !== "contextCompaction");
      if (firstVisible?.type === "userMessage") {
        return {
          oldestUserInput: [...firstVisible.content],
          openingUserMessageId: firstVisible.id,
        } as const;
      }
      if (opening.nextCursor === null && turn.status !== "inProgress") {
        return { oldestUserInput: [], openingUserMessageId: null } as const;
      }
      return { oldestUserInput: null, openingUserMessageId: null } as const;
    });

    const loadHydratedTurnPage = Effect.fn("CodexHistorySearchAdapter.loadHydratedTurnPage")(
      function* (
        snapshot: CodexAppServerCapabilitySnapshot,
        threadId: string,
        cursor: string,
        sortDirection: SortDirection,
      ) {
        const response = yield* fencedRequest({
          snapshot,
          threadId,
          method: "thread/turns/list",
          params: {
            threadId,
            cursor,
            limit: CODEX_HISTORY_SEARCH_TURN_RADIUS_PAGE_SIZE,
            itemsView: "notLoaded",
            sortDirection,
          },
          operation: "turns",
          scheduling: HYDRATION_SCHEDULING,
        });
        if (response.data.length > CODEX_HISTORY_SEARCH_TURN_RADIUS_PAGE_SIZE) {
          return yield* adapterError({
            operation: "turns",
            threadId,
            reason: "page-size-exceeded",
            cause: new Error(
              `Turn page for '${threadId}' returned ${response.data.length} entries for limit ${CODEX_HISTORY_SEARCH_TURN_RADIUS_PAGE_SIZE}`,
            ),
          });
        }
        if (response.nextCursor !== null && response.nextCursor === cursor) {
          return yield* adapterError({
            operation: "turns",
            threadId,
            reason: "cursor-stalled",
            cause: new Error(`Turn cursor did not advance for '${threadId}'`),
          });
        }

        let remainingItems = directionItemLimit;
        let remainingBytes = directionByteLimit;
        let itemPageRequestCount = 0;
        const turns: Turn[] = [];
        const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {};
        for (const turn of response.data) {
          let itemCursor: string | null = null;
          let requested = false;
          let retentionBlocked = false;
          let items: readonly ThreadItem[] = [];
          const seenItemCursors = new Set<string | null>();
          while ((!requested || itemCursor !== null) && remainingItems > 0 && remainingBytes > 0) {
            if (itemPageRequestCount >= CODEX_HISTORY_SEARCH_MAX_ITEM_PAGE_REQUESTS_PER_DIRECTION) {
              retentionBlocked = true;
              break;
            }
            if (seenItemCursors.has(itemCursor)) {
              return yield* adapterError({
                operation: "items",
                threadId,
                turnId: turn.id,
                reason: "cursor-stalled",
                cause: new Error(`Repeated item cursor for turn '${turn.id}'`),
              });
            }
            seenItemCursors.add(itemCursor);
            requested = true;
            itemPageRequestCount += 1;
            const page: LoadedItemPage = yield* loadItemsPage({
              snapshot,
              threadId,
              turnId: turn.id,
              cursor: itemCursor,
              limit:
                items.length === 0
                  ? 1
                  : Math.min(CODEX_HISTORY_SEARCH_ITEM_PAGE_SIZE, remainingItems),
              sortDirection: "desc",
            });
            if (page.rawItemCount > remainingItems) {
              retentionBlocked = true;
              break;
            }
            const existingIds = new Set(items.map((item) => item.id));
            const unique = dedupeItems(page.items).filter((item) => !existingIds.has(item.id));
            const retainedBytes = approximateValueBytes(unique, remainingBytes);
            if (retainedBytes > remainingBytes) {
              if (itemCursor === null) {
                return yield* adapterError({
                  operation: "items",
                  threadId,
                  turnId: turn.id,
                  reason: "item-byte-limit",
                  cause: new Error(
                    `Initial search item page for turn '${turn.id}' exceeds the byte budget without a retry cursor`,
                  ),
                });
              }
              retentionBlocked = true;
              break;
            }
            items = [...unique, ...items];
            remainingItems -= unique.length;
            remainingBytes -= retainedBytes;
            itemCursor = page.nextCursor;
          }
          const hasLoadedOldest = requested && !retentionBlocked && itemCursor === null;
          const openingCandidate =
            hasLoadedOldest || remainingBytes === 0
              ? { oldestUserInput: null, openingUserMessageId: null }
              : yield* loadOpeningUser(snapshot, threadId, turn);
          const openingBytes = approximateValueBytes(
            openingCandidate.oldestUserInput,
            remainingBytes,
          );
          const opening =
            openingCandidate.oldestUserInput !== null && openingBytes > remainingBytes
              ? { oldestUserInput: null, openingUserMessageId: null }
              : openingCandidate;
          if (opening.oldestUserInput !== null) remainingBytes -= openingBytes;
          const itemsView = hasLoadedOldest ? "full" : "summary";
          turns.push(normalizeTurn(turn, items, itemsView));
          itemsPaginationByTurnId[turn.id] = {
            olderCursor: itemCursor,
            isLoadingOlder: false,
            hasLoadedOldest,
            oldestUserInput: opening.oldestUserInput,
            openingUserMessageId: opening.openingUserMessageId,
            itemsView,
          };
        }
        return {
          turns,
          nextCursor: response.nextCursor ?? null,
          itemsPaginationByTurnId,
        } satisfies HydratedTurnPage;
      },
    );

    const resolveSelectedItem = Effect.fn("CodexHistorySearchAdapter.resolveSelectedItem")(
      function* (
        snapshot: CodexAppServerCapabilitySnapshot,
        threadId: string,
        itemId: string,
        turn: Turn,
        pagination: CodexHistoryTurnItemsPagination,
      ) {
        let inspectedItemCount = turn.items.length;
        let inspectedBytes = approximateValueBytes(turn.items, selectedByteLimit);
        let currentTurn = turn;
        let currentPagination = { ...pagination };
        let found = selectedItem(currentTurn, itemId);
        const seenCursors = new Set<string | null>();

        while (found === null && !currentPagination.hasLoadedOldest) {
          if (inspectedItemCount >= selectedItemLimit) {
            return {
              turn: currentTurn,
              pagination: currentPagination,
              selection: {
                status: "bounded-incomplete",
                reason: "item-count-limit",
                inspectedItemCount,
                inspectedBytes,
                nextCursor: currentPagination.olderCursor,
              } satisfies CodexHistorySelectedItemResolution,
            } as const;
          }
          if (inspectedBytes >= selectedByteLimit) {
            return {
              turn: currentTurn,
              pagination: currentPagination,
              selection: {
                status: "bounded-incomplete",
                reason: "item-byte-limit",
                inspectedItemCount,
                inspectedBytes,
                nextCursor: currentPagination.olderCursor,
              } satisfies CodexHistorySelectedItemResolution,
            } as const;
          }

          const cursor = currentPagination.olderCursor;
          if (seenCursors.has(cursor)) {
            return yield* adapterError({
              operation: "items",
              threadId,
              turnId: currentTurn.id,
              reason: "cursor-stalled",
              cause: new Error(`Repeated selected-item cursor for turn '${currentTurn.id}'`),
            });
          }
          seenCursors.add(cursor);
          const page: LoadedItemPage = yield* loadItemsPage({
            snapshot,
            threadId,
            turnId: currentTurn.id,
            cursor,
            limit: Math.min(
              CODEX_HISTORY_SEARCH_ITEM_PAGE_SIZE,
              selectedItemLimit - inspectedItemCount,
            ),
            sortDirection: "desc",
          });
          if (inspectedItemCount + page.rawItemCount > selectedItemLimit) {
            return {
              turn: currentTurn,
              pagination: currentPagination,
              selection: {
                status: "bounded-incomplete",
                reason: "item-count-limit",
                inspectedItemCount,
                inspectedBytes,
                nextCursor: cursor,
              } satisfies CodexHistorySelectedItemResolution,
            } as const;
          }
          if (inspectedBytes + page.approximateBytes > selectedByteLimit) {
            return {
              turn: currentTurn,
              pagination: currentPagination,
              selection: {
                status: "bounded-incomplete",
                reason: "item-byte-limit",
                inspectedItemCount,
                inspectedBytes,
                nextCursor: cursor,
              } satisfies CodexHistorySelectedItemResolution,
            } as const;
          }
          const existingIds = new Set(currentTurn.items.map((item) => item.id));
          const unique = dedupeItems(page.items).filter((item) => !existingIds.has(item.id));
          const items = [...unique, ...currentTurn.items];
          inspectedItemCount += page.rawItemCount;
          inspectedBytes += page.approximateBytes;
          const hasLoadedOldest = page.nextCursor === null;
          currentTurn = {
            ...currentTurn,
            items,
            itemsView: hasLoadedOldest ? "full" : "summary",
          };
          currentPagination = {
            ...currentPagination,
            olderCursor: page.nextCursor,
            isLoadingOlder: false,
            hasLoadedOldest,
            itemsView: hasLoadedOldest ? "full" : "summary",
          };
          found = selectedItem(currentTurn, itemId);
        }

        if (found === null) {
          return yield* adapterError({
            operation: "items",
            threadId,
            turnId: currentTurn.id,
            reason: "selected-item-missing",
            cause: new Error(`Persisted search item '${itemId}' is no longer available`),
          });
        }
        return {
          turn: currentTurn,
          pagination: currentPagination,
          selection: {
            status: "found",
            item: found,
            inspectedItemCount,
            inspectedBytes,
          } satisfies CodexHistorySelectedItemResolution,
        } as const;
      },
    );

    const search = Effect.fn("CodexHistorySearchAdapter.search")(function* (
      input: CodexHistorySearchInput,
    ) {
      if (
        input.searchTerm.length === 0 ||
        cappedApproximateValueBytes(input.searchTerm, CODEX_HISTORY_SEARCH_TERM_MAX_BYTES) >
          CODEX_HISTORY_SEARCH_TERM_MAX_BYTES
      ) {
        return yield* adapterError({
          operation: "search",
          threadId: input.threadId,
          reason: "invalid-search-term",
          cause: new Error("Persisted-history search term must be non-empty and byte-bounded"),
        });
      }
      const snapshot = yield* capabilityForThread(input.threadId);
      const response = yield* fencedRequest({
        snapshot,
        threadId: input.threadId,
        method: "thread/searchOccurrences",
        params: {
          threadId: input.threadId,
          searchTerm: input.searchTerm,
          cursor: null,
          limit: CODEX_HISTORY_SEARCH_OCCURRENCE_LIMIT,
        },
        operation: "search",
        scheduling: SEARCH_SCHEDULING,
      });
      if (response.data.length > CODEX_HISTORY_SEARCH_OCCURRENCE_LIMIT) {
        return yield* adapterError({
          operation: "search",
          threadId: input.threadId,
          reason: "page-size-exceeded",
          cause: new Error(
            `Search page for '${input.threadId}' returned ${response.data.length} entries for limit ${CODEX_HISTORY_SEARCH_OCCURRENCE_LIMIT}`,
          ),
        });
      }
      if (
        cappedApproximateValueBytes(response.data, CODEX_HISTORY_SEARCH_OCCURRENCE_PAGE_MAX_BYTES) >
        CODEX_HISTORY_SEARCH_OCCURRENCE_PAGE_MAX_BYTES
      ) {
        return yield* adapterError({
          operation: "search",
          threadId: input.threadId,
          reason: "page-byte-limit",
          cause: new Error(`Search page for '${input.threadId}' exceeds its byte budget`),
        });
      }
      for (const occurrence of response.data) {
        const cause = invalidOccurrenceCause(occurrence);
        if (!cause) continue;
        return yield* adapterError({
          operation: "search",
          threadId: input.threadId,
          reason: "invalid-occurrence",
          cause,
        });
      }
      return {
        threadId: input.threadId,
        hostId: snapshot.hostId,
        generation: snapshot.generation,
        occurrences: [...response.data],
        isCapped: response.nextCursor !== null,
      } satisfies CodexHistorySearchPage;
    });

    const hydrateOccurrence = Effect.fn("CodexHistorySearchAdapter.hydrateOccurrence")(function* (
      input: CodexHistoryOccurrenceHydrationInput,
    ) {
      const invalidOccurrence = invalidOccurrenceCause(input.occurrence);
      if (invalidOccurrence) {
        return yield* adapterError({
          operation: "search",
          threadId: input.threadId,
          reason: "invalid-occurrence",
          cause: invalidOccurrence,
        });
      }
      const snapshot = yield* capabilityForThread(input.threadId);
      if (snapshot.hostId !== input.hostId || snapshot.generation !== input.generation) {
        return yield* adapterError({
          operation: "generation",
          threadId: input.threadId,
          reason: "stale-generation",
          cause: new Error("Persisted-history occurrence belongs to a stale Codex session"),
        });
      }
      yield* failIfStale(snapshot, input.threadId);

      const [descending, ascending] = yield* Effect.all(
        [
          loadHydratedTurnPage(snapshot, input.threadId, input.occurrence.turnCursor, "desc"),
          loadHydratedTurnPage(snapshot, input.threadId, input.occurrence.turnCursor, "asc"),
        ],
        { concurrency: "unbounded" },
      );
      if (
        descending.turns[0]?.id !== input.occurrence.turnId ||
        ascending.turns[0]?.id !== input.occurrence.turnId
      ) {
        return yield* adapterError({
          operation: "turns",
          threadId: input.threadId,
          turnId: input.occurrence.turnId,
          reason: "anchor-missing",
          cause: new Error("Inclusive search turn cursor did not return its anchor turn"),
        });
      }

      const combined = [...descending.turns.slice().reverse(), ...ascending.turns.slice(1)];
      const seenTurnIds = new Set<string>();
      let turns = combined.filter((turn) =>
        seenTurnIds.has(turn.id) ? false : (seenTurnIds.add(turn.id), true),
      );
      if (turns.length > 9) turns = turns.slice(0, 9);
      const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {
        ...ascending.itemsPaginationByTurnId,
        ...descending.itemsPaginationByTurnId,
      };
      const anchorIndex = turns.findIndex((turn) => turn.id === input.occurrence.turnId);
      const anchor = turns[anchorIndex];
      const anchorPagination = itemsPaginationByTurnId[input.occurrence.turnId];
      if (!anchor || !anchorPagination) {
        return yield* adapterError({
          operation: "turns",
          threadId: input.threadId,
          turnId: input.occurrence.turnId,
          reason: "anchor-missing",
          cause: new Error("Hydrated search island is missing its selected turn"),
        });
      }

      const selected = yield* resolveSelectedItem(
        snapshot,
        input.threadId,
        input.occurrence.itemId,
        anchor,
        anchorPagination,
      );
      turns = turns.map((turn, index) => (index === anchorIndex ? selected.turn : turn));
      itemsPaginationByTurnId[input.occurrence.turnId] = selected.pagination;
      yield* failIfStale(snapshot, input.threadId);

      const sequence = nextIslandSequence++;
      const islandId = `search:${snapshot.generation}:${sequence}`;
      const oldestLoadedTurnId = turns[0]?.id ?? null;
      const boundary = (cursor: string | null, edge: "older" | "newer"): CodexHistoryBoundary =>
        cursor === null
          ? exhaustedCodexHistoryBoundary(`${islandId}:${edge}`)
          : availableCodexHistoryBoundary(`${islandId}:${edge}`, {
              cursor,
              oldestLoadedTurnId,
            });
      const entities = turns.map((turn): CodexHistoryEntity<Turn> => ({
        key: turn.id,
        turn,
        itemCount: turn.items.length,
        approximateBytes: approximateValueBytes(turn, selectedByteLimit),
        itemsPagination: itemsPaginationByTurnId[turn.id]!,
        authority: "history",
        revision: sequence,
      }));
      const island = {
        islandId,
        entries: turns.map((turn, index) => ({
          key: `${islandId}:${index}`,
          entityKey: turn.id,
        })),
        entities,
        olderBoundary: boundary(descending.nextCursor, "older"),
        newerBoundary: boundary(ascending.nextCursor, "newer"),
      } satisfies CodexHistorySearchIslandInput;

      return {
        threadId: input.threadId,
        hostId: snapshot.hostId,
        generation: snapshot.generation,
        occurrence: input.occurrence,
        turns,
        itemsPaginationByTurnId,
        selection: selected.selection,
        island,
      } satisfies CodexHistoryOccurrenceHydration;
    });

    return CodexHistorySearchAdapter.of({ search, hydrateOccurrence });
  });
