import { ThreadId, TurnItemId } from "@t3tools/contracts";
import type { ThreadId as ThreadIdentity } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { runtimeHistoryContent } from "../nodex/RuntimeHistoryContent.ts";
import { HistoryReadError, type HistorySource } from "../nodex/HistoryRead.ts";
import type { HistoryItem } from "../nodex/history-contracts.ts";

/** Task routing stays task-relative; source addresses remain private to cursors and read evidence. */
export const taskReadView = <Item extends HistoryItem, Result>(
  result: Result & { readonly items: readonly Item[] },
) => ({
  ...result,
  items: result.items.map(({ sourceThreadId: _source, senderThreadId: _sender, ...item }) => item),
});

const anchorSchema = Schema.Struct({ sourceThreadId: Schema.String, sourceItemId: Schema.String });
const start = JSON.stringify({ start: true });
const parseAnchor = Schema.decodeUnknownSync(anchorSchema, { onExcessProperty: "error" });
const unavailable = (cause: unknown) =>
  new HistoryReadError({ reason: "history_unavailable", cause });

/** Task authorization is resolved for each invocation before this canonical history reader is created. */
export const taskHistorySource = (
  projections: Pick<
    Threads.ThreadManagementService["Service"],
    "getTimelineMetadataPage" | "getVisibleTurnItemRecord"
  >,
  threadId: ThreadIdentity,
): HistorySource => ({
  kind: "runtime",
  page: (input) =>
    Effect.gen(function* () {
      const anchor =
        input.cursor === undefined || input.cursor === start
          ? undefined
          : yield* Effect.try({
              try: () => parseAnchor(JSON.parse(input.cursor!)),
              catch: (cause) => new HistoryReadError({ reason: "invalid_cursor", cause }),
            });
      const identity =
        anchor === undefined
          ? undefined
          : {
              sourceThreadId: ThreadId.make(anchor.sourceThreadId),
              sourceItemId: TurnItemId.make(anchor.sourceItemId),
            };
      const page = yield* projections
        .getTimelineMetadataPage(threadId, {
          view: input.view,
          order: input.order,
          limit: input.limit,
          ...(identity === undefined
            ? {}
            : input.order === "newest_first"
              ? { beforeItem: identity }
              : { afterItem: identity }),
        })
        .pipe(Effect.mapError(unavailable));
      if (!page.anchorFound)
        return yield* new HistoryReadError({
          reason: "cursor_stale",
          cause: new Error("Task history anchor is no longer visible"),
        });
      const items = page.items.map((row) => ({
        reference: {
          itemId: row.sourceItemId,
          sourceThreadId: row.sourceThreadId,
          runId: row.item.runId,
          type: row.item.type,
          status: row.item.status,
          visibility: row.visibility,
          updatedAt: DateTime.formatIso(row.item.updatedAt),
          ...row.metadata,
        },
        after: JSON.stringify({
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
        }),
      }));
      const tailCursor = items.at(-1)?.after ?? input.cursor ?? start;
      return { items, nextCursor: page.hasMore ? tailCursor : null, tailCursor };
    }),
  content: (input) =>
    Effect.gen(function* () {
      const record = yield* projections
        .getVisibleTurnItemRecord({
          threadId,
          ...(input.locator.sourceThreadId === undefined
            ? {}
            : { sourceThreadId: ThreadId.make(input.locator.sourceThreadId) }),
          itemId: TurnItemId.make(input.locator.itemId),
        })
        .pipe(Effect.mapError(unavailable));
      if (
        !record ||
        (input.locator.runId !== undefined && record.item.runId !== input.locator.runId)
      )
        return yield* new HistoryReadError({
          reason: "item_unavailable",
          cause: new Error("Task item is no longer visible"),
        });
      return yield* runtimeHistoryContent(record, input).pipe(Effect.mapError(unavailable));
    }),
  progress: () =>
    Effect.fail(
      new HistoryReadError({
        reason: "history_unavailable",
        cause: new Error("Task progress is observed through task_status"),
      }),
    ),
});
