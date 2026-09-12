import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { SortDirection, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";
import type { CodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import type { CodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexGateway,
  codexGatewayGenerationFence,
  type CodexGatewayRequestOptions,
} from "../codex-runtime/CodexGateway";

export const CODEX_HISTORY_TURN_PAGE_SIZE = 5;
export const CODEX_HISTORY_ITEM_PAGE_SIZE = 100;
export const CODEX_HISTORY_INITIAL_ITEM_BUDGET = 500;
export const CODEX_HISTORY_INITIAL_BYTE_BUDGET = 8 * 1024 * 1024;
export const CODEX_HISTORY_ITEM_BYTE_BUDGET = 8 * 1024 * 1024;
export type CodexHistoryPagePurpose = "export" | "initial" | "older" | "search" | "tool";
export type CodexHistoryRequestOptions = Pick<
  CodexGatewayRequestOptions,
  "priority" | "source" | "timeoutMs"
>;

export interface CodexHydratedHistoryTurnPage {
  readonly turns: readonly Turn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  /** Chronological physical item pages with both exact app-server edge cursors. */
  readonly itemSegmentsByTurnId: Readonly<
    Record<string, readonly CodexHydratedHistoryItemSegment[]>
  >;
  readonly loadedItemCount: number;
}

export interface CodexHydratedHistoryItemSegment {
  readonly itemIds: readonly string[];
  readonly approximateBytes: number;
  /** Same-direction continuation toward older items; `null` means exhausted. */
  readonly olderCursor: string | null;
  /** Reverse-direction cursor toward newer items; `null` means exhausted. */
  readonly newerCursor: string | null;
}

type OpeningMessageMetadata = Pick<
  CodexHistoryTurnItemsPagination,
  "oldestUserInput" | "openingUserMessageId" | "openingUserMessageClientId"
>;

export interface CodexResidentHistory {
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}

export interface CodexHistoryTurnPageInput {
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly threadId: string;
  readonly cursor: string | null;
  readonly initialItemsCursor: string | null;
  /** Read after the Turn response so opening metadata reflects current residency. */
  readonly readResidentHistory?: () => CodexResidentHistory | undefined;
  readonly limit?: number;
  readonly sortDirection?: SortDirection;
  readonly itemBudget?: number;
  readonly turnItemLimit?: number;
  readonly byteBudget?: number;
  readonly purpose?: CodexHistoryPagePurpose;
  readonly requestOptions?: CodexHistoryRequestOptions;
}

export interface CodexHistoryItemPageInput {
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly threadId: string;
  readonly turnId: string;
  readonly cursor: string | null;
  readonly limit?: number;
  readonly sortDirection?: SortDirection;
  readonly purpose?: CodexHistoryPagePurpose;
  readonly requestOptions?: CodexHistoryRequestOptions;
  readonly byteBudget?: number;
}

export interface CodexHydratedHistoryItemPage {
  readonly items: readonly ThreadItem[];
  readonly nextCursor: string | null;
  /** Exact cursor for reversing this physical page's direction. */
  readonly backwardsCursor: string | null;
  readonly approximateBytes: number;
}

export class CodexHistoryPageAdapterError extends Schema.TaggedError<CodexHistoryPageAdapterError>()(
  "CodexHistoryPageAdapterError",
  {
    operation: Schema.Literals(["turns", "items", "opening-user"]),
    threadId: Schema.String,
    turnId: Schema.NullOr(Schema.String),
    reason: Schema.Literals([
      "request-failed",
      "cursor-stalled",
      "foreign-item",
      "item-byte-limit",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class CodexHistoryPageAdapter extends Context.Service<
  CodexHistoryPageAdapter,
  {
    readonly loadTurnPage: (
      input: CodexHistoryTurnPageInput,
    ) => Effect.Effect<CodexHydratedHistoryTurnPage, CodexHistoryPageAdapterError>;
    readonly loadTurnItemsPage: (
      input: CodexHistoryItemPageInput,
    ) => Effect.Effect<CodexHydratedHistoryItemPage, CodexHistoryPageAdapterError>;
  }
>()("nodex/main/codex-application/CodexHistoryPageAdapter") {}

const error = (input: {
  readonly operation: CodexHistoryPageAdapterError["operation"];
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly reason: CodexHistoryPageAdapterError["reason"];
  readonly cause: unknown;
}) =>
  new CodexHistoryPageAdapterError({
    operation: input.operation,
    threadId: input.threadId,
    turnId: input.turnId ?? null,
    reason: input.reason,
    cause: input.cause,
  });

type GatewayHistoryTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];

const normalizeTurn = (
  turn: GatewayHistoryTurn,
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

const cappedValueBytes = (value: unknown, limit = Number.MAX_SAFE_INTEGER): number =>
  cappedApproximateValueBytes(value, limit);

/**
 * A raw protocol item becomes both a canonical item and one or more renderer rows. Admission
 * charges the canonical copy, renderer copy, and one same-sized lifecycle expansion reserve,
 * plus bounded per-item metadata, before the page can enter the resident window.
 */
export const estimateCodexHistoryProjectedItemPageBytes = (
  items: readonly ThreadItem[],
  limit = Number.MAX_SAFE_INTEGER,
): number => {
  const metadataBytes = items.length * 1024;
  if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limit) return limit + 1;
  const perProjectionLimit = Math.floor((limit - metadataBytes) / 3);
  const singleProjectionBytes = cappedValueBytes(items, perProjectionLimit);
  if (singleProjectionBytes > perProjectionLimit) return limit + 1;
  return singleProjectionBytes * 3 + metadataBytes;
};

const schedulingForPurpose = (purpose: CodexHistoryPagePurpose) =>
  purpose === "export"
    ? ({ priority: "background", source: "history_export" } as const)
    : purpose === "tool"
      ? ({ priority: "interactive", source: "read_thread" } as const)
      : purpose === "older" || purpose === "search"
        ? ({ priority: "interactive", source: "visible_history" } as const)
        : ({ priority: "interactive", source: "thread_hydration" } as const);

export const make: Effect.Effect<CodexHistoryPageAdapter["Service"], never, CodexGateway> =
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;

    const loadItemsPage = Effect.fn("CodexHistoryPageAdapter.loadItemsPage")(function* (input: {
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly threadId: string;
      readonly turnId: string;
      readonly cursor: string | null;
      readonly limit: number;
      readonly sortDirection: SortDirection;
      readonly operation: CodexHistoryPageAdapterError["operation"];
      readonly purpose: CodexHistoryPagePurpose;
      readonly requestOptions?: CodexHistoryRequestOptions;
    }) {
      const response = yield* gateway
        .requestForThread(
          input.threadId,
          "thread/items/list",
          {
            threadId: input.threadId,
            turnId: input.turnId,
            cursor: input.cursor,
            limit: input.limit,
            sortDirection: input.sortDirection,
          },
          {
            ...schedulingForPurpose(input.purpose),
            ...input.requestOptions,
            ...codexGatewayGenerationFence(input.capability),
          },
        )
        .pipe(
          Effect.mapError((cause) =>
            error({
              operation: input.operation,
              threadId: input.threadId,
              turnId: input.turnId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
      if (response.nextCursor !== null && response.nextCursor === input.cursor) {
        return yield* error({
          operation: input.operation,
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "cursor-stalled",
          cause: new Error(`Item cursor did not advance for turn '${input.turnId}'`),
        });
      }
      const items: ThreadItem[] = [];
      for (const entry of response.data) {
        if (entry.turnId !== input.turnId) {
          return yield* error({
            operation: input.operation,
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "foreign-item",
            cause: new Error(
              `Expected items for turn '${input.turnId}' but received '${entry.turnId}'`,
            ),
          });
        }
        items.push(entry.item as unknown as ThreadItem);
      }
      return {
        items: input.sortDirection === "desc" ? items.reverse() : items,
        nextCursor: response.nextCursor ?? null,
        backwardsCursor: response.backwardsCursor ?? null,
        approximateBytes: cappedValueBytes(items),
      };
    });

    const loadOpeningUser = Effect.fn("CodexHistoryPageAdapter.loadOpeningUser")(function* (
      capability: CodexAppServerCapabilitySnapshot,
      threadId: string,
      turn: GatewayHistoryTurn,
      purpose: CodexHistoryPagePurpose,
      requestOptions?: CodexHistoryRequestOptions,
    ) {
      const empty: Pick<
        CodexHistoryTurnItemsPagination,
        "oldestUserInput" | "openingUserMessageId" | "openingUserMessageClientId"
      > = {};
      const opening = yield* loadItemsPage({
        capability,
        threadId,
        turnId: turn.id,
        cursor: null,
        limit: 2,
        sortDirection: "asc",
        operation: "opening-user",
        purpose,
        requestOptions,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!opening) return empty;
      const first = opening.items.find((item) => item.type !== "contextCompaction");
      if (first?.type === "userMessage")
        return {
          oldestUserInput: [...first.content],
          openingUserMessageId: first.id,
          openingUserMessageClientId: first.clientId,
        };
      if (first || (opening.nextCursor === null && turn.status !== "inProgress")) {
        return {
          oldestUserInput: [],
          openingUserMessageId: null,
          openingUserMessageClientId: null,
        };
      }
      return empty;
    });

    const loadDurableTurnItems = Effect.fn("CodexHistoryPageAdapter.loadDurableTurnItems")(
      function* (
        input: CodexHistoryTurnPageInput,
        turnId: string,
        requestOptions: CodexHistoryRequestOptions,
      ) {
        const items: ThreadItem[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let limit = 500;
        for (;;) {
          const result: Result.Result<CodexHydratedHistoryItemPage, CodexHistoryPageAdapterError> =
            yield* loadItemsPage({
              capability: input.capability,
              threadId: input.threadId,
              turnId,
              cursor,
              limit,
              sortDirection: "asc",
              operation: "items",
              purpose: input.purpose ?? "initial",
              requestOptions,
            }).pipe(Effect.result);
          if (result._tag === "Failure") {
            const failure = result.failure;
            if (
              failure.reason !== "request-failed" ||
              limit <= 1 ||
              !encodeCodexNativeRequestFailure(failure).message.includes(
                "decoded message length too large",
              )
            )
              return yield* Effect.fail(failure);
            limit = Math.floor(limit / 2);
            continue;
          }
          const page: CodexHydratedHistoryItemPage = result.success;
          items.push(...page.items);
          if (page.nextCursor === null) return items;
          if (seenCursors.has(page.nextCursor))
            return yield* error({
              operation: "items",
              threadId: input.threadId,
              turnId,
              reason: "cursor-stalled",
              cause: new Error(`Repeated item cursor for turn '${turnId}'`),
            });
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      },
    );

    const loadTurnPage = Effect.fn("CodexHistoryPageAdapter.loadTurnPage")(function* (
      input: CodexHistoryTurnPageInput,
    ) {
      const durable = input.capability.hostId === "durable";
      const requestOptions = durable
        ? { timeoutMs: 30_000, ...input.requestOptions }
        : input.requestOptions;
      const limit = Math.max(1, input.limit ?? CODEX_HISTORY_TURN_PAGE_SIZE);
      const turnItemLimit = input.turnItemLimit ?? Number.POSITIVE_INFINITY;
      const defaultItemBudget = Math.min(limit, CODEX_HISTORY_TURN_PAGE_SIZE) * 100;
      const itemBudgetLimit = Math.max(
        0,
        Math.min(input.itemBudget ?? defaultItemBudget, CODEX_HISTORY_INITIAL_ITEM_BUDGET),
      );
      // Interactive history is count-bounded. Background excerpt consumers may request a byte budget.
      const byteBudgetLimit = Math.max(0, input.byteBudget ?? Number.MAX_SAFE_INTEGER);
      const sortDirection = input.sortDirection ?? "desc";
      const purpose = input.purpose ?? "initial";
      const response = yield* gateway
        .requestForThread(
          input.threadId,
          "thread/turns/list",
          {
            threadId: input.threadId,
            cursor: input.cursor,
            limit,
            itemsView: "notLoaded",
            sortDirection,
          },
          {
            ...schedulingForPurpose(purpose),
            ...requestOptions,
            ...codexGatewayGenerationFence(input.capability),
          },
        )
        .pipe(
          Effect.mapError((cause) =>
            error({
              operation: "turns",
              threadId: input.threadId,
              reason: "request-failed",
              cause,
            }),
          ),
        );
      if (response.nextCursor !== null && response.nextCursor === input.cursor) {
        return yield* error({
          operation: "turns",
          threadId: input.threadId,
          reason: "cursor-stalled",
          cause: new Error(`Turn cursor did not advance for '${input.threadId}'`),
        });
      }
      if (durable) {
        const turns = new Array<Turn>(response.data.length);
        // Each worker retains its stride, so a slow Turn cannot reassign another worker's tail.
        const worker = Effect.fn("CodexHistoryPageAdapter.hydrateDurableWorker")(function* (
          start: number,
        ) {
          for (let index = start; index < response.data.length; index += 5) {
            const turn = response.data[index]!;
            const items = yield* loadDurableTurnItems(input, turn.id, requestOptions!);
            turns[index] = normalizeTurn(turn, items, "full");
          }
        });
        yield* Effect.forEach(
          Array.from({ length: Math.min(response.data.length, 5) }, (_, index) => index),
          worker,
          { concurrency: "unbounded", discard: true },
        );
        return {
          turns: sortDirection === "desc" ? turns.reverse() : turns,
          nextCursor: response.nextCursor ?? null,
          backwardsCursor: response.backwardsCursor ?? null,
          itemsPaginationByTurnId: {},
          itemSegmentsByTurnId: {},
          loadedItemCount: turns.reduce((count, turn) => count + turn.items.length, 0),
        } satisfies CodexHydratedHistoryTurnPage;
      }
      const resident = input.readResidentHistory?.();
      let remainingBudget = itemBudgetLimit;
      let remainingBytes = byteBudgetLimit;
      let loadedItemCount = 0;
      const hydrated: Turn[] = [];
      const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {};
      const itemSegmentsByTurnId: Record<string, readonly CodexHydratedHistoryItemSegment[]> = {};
      const openingProbes: Array<{
        turnId: string;
        fiber: Fiber.Fiber<OpeningMessageMetadata>;
      }> = [];
      const probeOpening = Effect.fn("CodexHistoryPageAdapter.probeOpening")(function* (
        turn: GatewayHistoryTurn,
      ) {
        const read = loadOpeningUser(
          input.capability,
          input.threadId,
          turn,
          purpose,
          input.requestOptions,
        );
        // Explicit excerpt budgets must account for an opening before admitting another page.
        if (input.byteBudget !== undefined) return yield* read;
        const fiber = yield* read.pipe(Effect.forkScoped({ startImmediately: true }));
        openingProbes.push({ turnId: turn.id, fiber });
        return {} as OpeningMessageMetadata;
      });
      for (const turn of response.data) {
        let cursor = input.initialItemsCursor;
        let requested = false;
        let items: readonly ThreadItem[] = [];
        const itemSegments: CodexHydratedHistoryItemSegment[] = [];
        const seenCursors = new Set<string | null>();
        while (
          (!requested || cursor !== null) &&
          remainingBudget > 0 &&
          remainingBytes > 0 &&
          items.length < turnItemLimit
        ) {
          if (seenCursors.has(cursor)) {
            return yield* error({
              operation: "items",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "cursor-stalled",
              cause: new Error(`Repeated item cursor for turn '${turn.id}'`),
            });
          }
          seenCursors.add(cursor);
          requested = true;
          const itemRequestLimit = Math.min(
            CODEX_HISTORY_ITEM_PAGE_SIZE,
            remainingBudget,
            turnItemLimit - items.length,
          );
          const itemPage = yield* loadItemsPage({
            capability: input.capability,
            threadId: input.threadId,
            turnId: turn.id,
            cursor,
            limit: itemRequestLimit,
            sortDirection: "desc",
            operation: "items",
            purpose,
            requestOptions: input.requestOptions,
          });
          const unique = dedupeItems(itemPage.items).filter(
            (item) => !items.some((current) => current.id === item.id),
          );
          const uniqueBytes = estimateCodexHistoryProjectedItemPageBytes(unique, remainingBytes);
          if (uniqueBytes > remainingBytes) {
            if (cursor === null) {
              return yield* error({
                operation: "items",
                threadId: input.threadId,
                turnId: turn.id,
                reason: "item-byte-limit",
                cause: new Error(
                  `Initial item page for turn '${turn.id}' exceeds the projected byte budget without a retry cursor`,
                ),
              });
            }
            // Explicit excerpt consumers stop at a physical page boundary; never split a page
            // behind its server cursor. Ordinary interactive reads have no byte budget.
            cursor = [...seenCursors].at(-1) ?? null;
            remainingBudget = 0;
            remainingBytes = 0;
            break;
          }
          items = [...unique, ...items];
          if (unique.length > 0) {
            itemSegments.unshift({
              itemIds: unique.map((item) => item.id),
              approximateBytes: uniqueBytes,
              olderCursor: itemPage.nextCursor,
              newerCursor: itemPage.backwardsCursor,
            });
          }
          loadedItemCount += unique.length;
          remainingBudget -= unique.length;
          remainingBytes = Math.max(0, remainingBytes - uniqueBytes);
          cursor = itemPage.nextCursor ?? null;
        }
        const hasLoadedOldest = requested && cursor === null;
        const residentTurn = residentConversationTurns(resident?.canonicalState).find(
          (candidate) => candidate.turnId === turn.id,
        );
        const residentPagination = resident?.turnItemsPaginationById[turn.id];
        const residentInput =
          residentPagination?.oldestUserInput ??
          (residentTurn &&
          residentPagination?.hasLoadedOldest !== false &&
          residentTurn.params.input.length > 0
            ? residentTurn.params.input
            : undefined);
        let openingCandidate: Pick<
          CodexHistoryTurnItemsPagination,
          "oldestUserInput" | "openingUserMessageId" | "openingUserMessageClientId"
        > = hasLoadedOldest
          ? {}
          : {
              openingUserMessageId: residentPagination?.openingUserMessageId,
              ...(residentInput == null
                ? {}
                : {
                    oldestUserInput: residentInput,
                    openingUserMessageClientId:
                      residentPagination?.oldestUserInput == null
                        ? residentTurn?.params.clientUserMessageId
                        : residentPagination.openingUserMessageClientId,
                  }),
            };
        if (
          !hasLoadedOldest &&
          residentPagination?.openingUserMessageId === undefined &&
          items.length > 0 &&
          remainingBytes > 0
        ) {
          openingCandidate = {
            ...openingCandidate,
            ...(yield* probeOpening(turn)),
          };
        }
        const openingBytes = cappedValueBytes(openingCandidate.oldestUserInput, remainingBytes);
        const opening =
          openingCandidate.oldestUserInput != null && openingBytes > remainingBytes
            ? {
                oldestUserInput: undefined,
                openingUserMessageId: undefined,
                openingUserMessageClientId: undefined,
              }
            : openingCandidate;
        if (opening.oldestUserInput != null) remainingBytes -= openingBytes;
        itemsPaginationByTurnId[turn.id] = {
          newestSnapshotItemId: items.at(-1)?.id,
          olderCursor: cursor,
          isLoadingOlder: false,
          hasLoadedOldest,
          oldestUserInput: opening.oldestUserInput,
          openingUserMessageId: opening.openingUserMessageId,
          openingUserMessageClientId: opening.openingUserMessageClientId,
          itemsView: hasLoadedOldest ? "full" : "summary",
        };
        itemSegmentsByTurnId[turn.id] = itemSegments;
        hydrated.push(normalizeTurn(turn, items, hasLoadedOldest ? "full" : "summary"));
      }

      for (const { turnId, fiber } of openingProbes) {
        const opening = yield* Fiber.join(fiber);
        const pagination = itemsPaginationByTurnId[turnId];
        if (pagination) itemsPaginationByTurnId[turnId] = { ...pagination, ...opening };
      }

      return {
        turns: sortDirection === "desc" ? hydrated.reverse() : hydrated,
        nextCursor: response.nextCursor ?? null,
        backwardsCursor: response.backwardsCursor ?? null,
        itemsPaginationByTurnId,
        itemSegmentsByTurnId,
        loadedItemCount,
      } satisfies CodexHydratedHistoryTurnPage;
    }, Effect.scoped);

    const loadTurnItemsPage = Effect.fn("CodexHistoryPageAdapter.loadTurnItemsPage")(function* (
      input: CodexHistoryItemPageInput,
    ) {
      const page = yield* loadItemsPage({
        ...input,
        limit: Math.max(
          1,
          Math.min(input.limit ?? CODEX_HISTORY_ITEM_PAGE_SIZE, CODEX_HISTORY_ITEM_PAGE_SIZE),
        ),
        sortDirection: input.sortDirection ?? "desc",
        operation: "items",
        purpose: input.purpose ?? "older",
      });
      const byteBudget = Math.max(1, input.byteBudget ?? Number.MAX_SAFE_INTEGER);
      const projectedBytes = estimateCodexHistoryProjectedItemPageBytes(page.items, byteBudget);
      if (projectedBytes > byteBudget) {
        return yield* error({
          operation: "items",
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "item-byte-limit",
          cause: new Error(
            `Item page for turn '${input.turnId}' exceeds the ${byteBudget}-byte resident budget`,
          ),
        });
      }
      return { ...page, approximateBytes: projectedBytes };
    });

    return CodexHistoryPageAdapter.of({ loadTurnPage, loadTurnItemsPage });
  });
