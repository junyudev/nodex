import * as Effect from "effect/Effect";
import { z } from "zod";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import {
  SessionHistoryReadError,
  type SessionHistorySource,
  type SessionItemReference,
} from "./SessionHistoryRead";

const failure = (cause: unknown) =>
  new SessionHistoryReadError({ reason: "history_unavailable", cause });
const anchor = z.strictObject({
  version: z.literal(1),
  sourceThreadId: z.string().min(1).max(4096),
  sourceItemId: z.string().min(1).max(4096),
});
const start = JSON.stringify({ version: 1, start: true });

/** Runtime owns canonical items and ancestry; Main owns only their bounded tool presentation. */
export const runtimeSessionHistory = (
  application: AgentRuntimeApplication["Service"],
  sessionId: string,
  runId?: string,
  execution?: { readonly threadId: string },
): SessionHistorySource => ({
  kind: "runtime",
  page: (input) =>
    Effect.gen(function* () {
      const cursor = input.cursor;
      const selected =
        cursor === undefined || cursor === start
          ? undefined
          : yield* Effect.try({
              try: () => anchor.parse(JSON.parse(cursor)),
              catch: (cause) => new SessionHistoryReadError({ reason: "invalid_cursor", cause }),
            });
      const page = yield* application
        .timeline({
          sessionId,
          ...(execution ? { threadId: execution.threadId } : {}),
          view: input.view,
          order: input.order,
          ...(selected === undefined
            ? {}
            : {
                [input.order === "oldest_first" ? "afterItem" : "beforeItem"]: {
                  sourceThreadId: selected.sourceThreadId,
                  sourceItemId: selected.sourceItemId,
                },
              }),
          limit: input.limit,
        })
        .pipe(Effect.mapError(failure));
      if (page.anchorFound === false)
        return yield* new SessionHistoryReadError({
          reason: "cursor_stale",
          cause: new Error("History anchor is no longer visible; read a fresh page"),
        });
      const items = page.items.map((row) => ({
        reference: {
          itemId: row.sourceItemId,
          sourceThreadId: row.sourceThreadId,
          runId: row.item.runId,
          type: row.item.type,
          status: row.item.status,
          visibility: row.visibility,
          updatedAt: row.item.updatedAt,
          ...row.metadata,
        } satisfies SessionItemReference,
        after: JSON.stringify({
          version: 1,
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
        }),
      }));
      return {
        items,
        nextCursor: page.hasMore ? (items.at(-1)?.after ?? null) : null,
        tailCursor: items.at(-1)?.after ?? cursor ?? start,
      };
    }),
  content: (input) =>
    Effect.gen(function* () {
      const content = yield* application
        .itemContent({
          sessionId,
          ...(execution ? { threadId: execution.threadId } : {}),
          itemId: input.locator.itemId,
          ...(input.locator.runId === undefined ? {} : { runId: input.locator.runId }),
          sourceThreadId: input.locator.sourceThreadId,
          format: input.format,
          textOffset: input.offset,
          maxChars: input.maxChars,
        })
        .pipe(Effect.mapError(failure));
      if (content)
        return {
          ...content,
          reference: content.reference,
        };
      return yield* new SessionHistoryReadError({
        reason: "item_unavailable",
        cause: new Error("Item is no longer visible in this Session"),
      });
    }),
  progress: () =>
    application
      .progress({
        sessionId,
        ...(execution ? { threadId: execution.threadId } : {}),
        ...(runId === undefined ? {} : { runId }),
      })
      .pipe(
        Effect.mapError(failure),
        Effect.map((progress) => ({
          coverage: "complete" as const,
          nextCursor: null,
          latestMessage: progress.latestReply
            ? {
                reference: {
                  itemId: progress.latestReply.itemId,
                  sourceThreadId: progress.latestReply.sourceThreadId,
                  runId: progress.latestReply.runId,
                  type: progress.latestReply.type,
                  status: progress.latestReply.status,
                },
                content: {
                  ...progress.latestReply,
                  reference: {
                    itemId: progress.latestReply.itemId,
                    sourceThreadId: progress.latestReply.sourceThreadId,
                    runId: progress.latestReply.runId,
                    type: progress.latestReply.type,
                    status: progress.latestReply.status,
                  },
                },
              }
            : null,
          latestTool: progress.latestActivity
            ? {
                id: progress.latestActivity.itemId,
                runId: progress.latestActivity.runId,
                type: progress.latestActivity.type,
                status: progress.latestActivity.status,
              }
            : null,
        })),
      ),
});
