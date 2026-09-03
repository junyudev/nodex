import type {
  SortDirection,
  ThreadItem,
  Turn,
  TurnsPage,
} from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import type { CodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";

export const CODEX_HISTORY_TURN_PAGE_SIZE = 5;
export const CODEX_HISTORY_ITEM_PAGE_SIZE = 100;
export const CODEX_HISTORY_INITIAL_MAX_ITEM_PAGE_REQUESTS = 20;
export const CODEX_HISTORY_INITIAL_ITEM_BUDGET = 500;
export const CODEX_HISTORY_INITIAL_BYTE_BUDGET = 8 * 1024 * 1024;
export const CODEX_HISTORY_ITEM_BYTE_BUDGET = 8 * 1024 * 1024;
export type CodexHistoryPagePurpose = "export" | "initial" | "older" | "search" | "tool";

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

export interface CodexHistoryTurnPageInput {
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly threadId: string;
  readonly cursor: string | null;
  readonly initialItemsCursor: string | null;
  readonly limit?: number;
  readonly sortDirection?: SortDirection;
  readonly itemBudget?: number;
  readonly byteBudget?: number;
  readonly purpose?: CodexHistoryPagePurpose;
}

export interface CodexHistoryItemPageInput {
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly threadId: string;
  readonly turnId: string;
  readonly cursor: string | null;
  readonly limit?: number;
  readonly sortDirection?: SortDirection;
  readonly purpose?: CodexHistoryPagePurpose;
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
      "page-size-exceeded",
      "item-byte-limit",
      "incomplete-resume-page",
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

const cappedValueBytes = (value: unknown, limit = CODEX_HISTORY_ITEM_BYTE_BUDGET): number =>
  cappedApproximateValueBytes(value, limit);

/**
 * A raw protocol item becomes both a canonical item and one or more renderer rows. Admission
 * charges the canonical copy, renderer copy, and one same-sized lifecycle expansion reserve,
 * plus bounded per-item metadata, before the page can enter the resident window.
 */
export const estimateCodexHistoryProjectedItemPageBytes = (
  items: readonly ThreadItem[],
  limit = CODEX_HISTORY_ITEM_BYTE_BUDGET,
): number => {
  const metadataBytes = items.length * 1_024;
  if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limit) return limit + 1;
  const perProjectionLimit = Math.floor((limit - metadataBytes) / 3);
  const singleProjectionBytes = cappedValueBytes(items, perProjectionLimit);
  if (singleProjectionBytes > perProjectionLimit) return limit + 1;
  return singleProjectionBytes * 3 + metadataBytes;
};

/** Admit the bounded inline resume page when independent history RPCs are unproven. */
export const acceptCodexResumeInitialTurnsPage = Effect.fn("acceptCodexResumeInitialTurnsPage")(
  function* (threadId: string, page: TurnsPage) {
    if (page.data.length > CODEX_HISTORY_TURN_PAGE_SIZE) {
      return yield* error({
        operation: "turns",
        threadId,
        reason: "page-size-exceeded",
        cause: new Error("Resume history exceeded the requested Turn limit"),
      });
    }
    let remainingItems = CODEX_HISTORY_INITIAL_ITEM_BUDGET;
    let remainingBytes = CODEX_HISTORY_INITIAL_BYTE_BUDGET;
    for (const turn of page.data) {
      if (turn.itemsView !== "full") {
        return yield* error({
          operation: "turns",
          threadId,
          turnId: turn.id,
          reason: "incomplete-resume-page",
          cause: new Error("Resume history must include full items without optional history RPCs"),
        });
      }
      remainingItems -= turn.items.length;
      if (remainingItems < 0) {
        return yield* error({
          operation: "items",
          threadId,
          turnId: turn.id,
          reason: "page-size-exceeded",
          cause: new Error("Resume history exceeded the resident item budget"),
        });
      }
      remainingBytes -= estimateCodexHistoryProjectedItemPageBytes(turn.items, remainingBytes);
      if (remainingBytes < 0) {
        return yield* error({
          operation: "items",
          threadId,
          turnId: turn.id,
          reason: "item-byte-limit",
          cause: new Error("Resume history exceeded the resident byte budget"),
        });
      }
    }
    if (page.data.length === 0 && page.nextCursor !== null) {
      return yield* error({
        operation: "turns",
        threadId,
        reason: "incomplete-resume-page",
        cause: new Error("Resume history returned an empty page with unloaded Turns"),
      });
    }
    return page.data.slice().reverse();
  },
);

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
      if (response.data.length > input.limit) {
        return yield* error({
          operation: input.operation,
          threadId: input.threadId,
          turnId: input.turnId,
          reason: "page-size-exceeded",
          cause: new Error(
            `Item page for turn '${input.turnId}' returned ${response.data.length} entries for limit ${input.limit}`,
          ),
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
    ) {
      let cursor: string | null = null;
      for (let requestCount = 0; requestCount < 2; requestCount += 1) {
        const opening: CodexHydratedHistoryItemPage = yield* loadItemsPage({
          capability,
          threadId,
          turnId: turn.id,
          cursor,
          limit: 1,
          sortDirection: "asc",
          operation: "opening-user",
          purpose,
        });
        const first = opening.items[0];
        if (first?.type === "userMessage") {
          return {
            oldestUserInput: [...first.content],
            openingUserMessageId: first.id,
          } as const;
        }
        if (first && first.type !== "contextCompaction") {
          return { oldestUserInput: null, openingUserMessageId: null } as const;
        }
        if (opening.nextCursor === null) {
          return turn.status === "inProgress"
            ? ({ oldestUserInput: null, openingUserMessageId: null } as const)
            : ({ oldestUserInput: [], openingUserMessageId: null } as const);
        }
        cursor = opening.nextCursor;
      }
      return { oldestUserInput: null, openingUserMessageId: null } as const;
    });

    const loadTurnPage = Effect.fn("CodexHistoryPageAdapter.loadTurnPage")(function* (
      input: CodexHistoryTurnPageInput,
    ) {
      const limit = Math.max(1, Math.min(input.limit ?? CODEX_HISTORY_TURN_PAGE_SIZE, 5));
      const defaultItemBudget = Math.min(limit, CODEX_HISTORY_TURN_PAGE_SIZE) * 100;
      const itemBudgetLimit = Math.max(
        0,
        Math.min(input.itemBudget ?? defaultItemBudget, CODEX_HISTORY_INITIAL_ITEM_BUDGET),
      );
      const byteBudgetLimit = Math.max(
        0,
        Math.min(
          input.byteBudget ?? CODEX_HISTORY_INITIAL_BYTE_BUDGET,
          CODEX_HISTORY_INITIAL_BYTE_BUDGET,
        ),
      );
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
      if (response.data.length > limit) {
        return yield* error({
          operation: "turns",
          threadId: input.threadId,
          reason: "page-size-exceeded",
          cause: new Error(
            `Turn page for '${input.threadId}' returned ${response.data.length} entries for limit ${limit}`,
          ),
        });
      }

      let remainingBudget = itemBudgetLimit;
      let remainingBytes = byteBudgetLimit;
      let loadedItemCount = 0;
      let itemPageRequestCount = 0;
      const hydrated: Turn[] = [];
      const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {};
      const itemSegmentsByTurnId: Record<string, readonly CodexHydratedHistoryItemSegment[]> = {};
      for (const turn of response.data) {
        let cursor = input.initialItemsCursor;
        let requested = false;
        let items: readonly ThreadItem[] = [];
        const itemSegments: CodexHydratedHistoryItemSegment[] = [];
        const seenCursors = new Set<string | null>();
        while ((!requested || cursor !== null) && remainingBudget > 0 && remainingBytes > 0) {
          if (itemPageRequestCount >= CODEX_HISTORY_INITIAL_MAX_ITEM_PAGE_REQUESTS) {
            remainingBudget = 0;
            remainingBytes = 0;
            break;
          }
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
          itemPageRequestCount += 1;
          // A first request of one item bounds the decoded working set before projected-byte
          // admission. No item is retained when even that single-item page exceeds the budget.
          const itemRequestLimit =
            items.length === 0 ? 1 : Math.min(CODEX_HISTORY_ITEM_PAGE_SIZE, remainingBudget);
          const itemPage = yield* loadItemsPage({
            capability: input.capability,
            threadId: input.threadId,
            turnId: turn.id,
            cursor,
            limit: itemRequestLimit,
            sortDirection: "desc",
            operation: "items",
            purpose,
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
            // A server cursor identifies the whole page. Keeping a partial page would silently
            // skip items. An arbitrarily large item must not become a permanent resident-budget
            // exception, so leave the cursor at the page boundary and expose an inert partial Turn.
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
          if (itemPage.items.length === 0 && cursor !== null) {
            return yield* error({
              operation: "items",
              threadId: input.threadId,
              turnId: turn.id,
              reason: "cursor-stalled",
              cause: new Error(`Item page made no progress for turn '${turn.id}'`),
            });
          }
        }
        const hasLoadedOldest = requested && cursor === null;
        const openingCandidate =
          hasLoadedOldest || remainingBytes === 0
            ? { oldestUserInput: null, openingUserMessageId: null }
            : yield* loadOpeningUser(input.capability, input.threadId, turn, purpose);
        const openingBytes = cappedValueBytes(openingCandidate.oldestUserInput, remainingBytes);
        const opening =
          openingCandidate.oldestUserInput !== null && openingBytes > remainingBytes
            ? { oldestUserInput: null, openingUserMessageId: null }
            : openingCandidate;
        if (opening.oldestUserInput !== null) remainingBytes -= openingBytes;
        itemsPaginationByTurnId[turn.id] = {
          olderCursor: cursor,
          isLoadingOlder: false,
          hasLoadedOldest,
          oldestUserInput: opening.oldestUserInput,
          openingUserMessageId: opening.openingUserMessageId,
          itemsView: hasLoadedOldest ? "full" : "summary",
        };
        itemSegmentsByTurnId[turn.id] = itemSegments;
        hydrated.push(normalizeTurn(turn, items, hasLoadedOldest ? "full" : "summary"));
      }

      return {
        turns: sortDirection === "desc" ? hydrated.reverse() : hydrated,
        nextCursor: response.nextCursor ?? null,
        backwardsCursor: response.backwardsCursor ?? null,
        itemsPaginationByTurnId,
        itemSegmentsByTurnId,
        loadedItemCount,
      } satisfies CodexHydratedHistoryTurnPage;
    });

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
      const byteBudget = Math.max(
        1,
        Math.min(
          input.byteBudget ?? CODEX_HISTORY_ITEM_BYTE_BUDGET,
          CODEX_HISTORY_ITEM_BYTE_BUDGET,
        ),
      );
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
