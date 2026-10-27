import {
  projectCodexGatewayThreadItemsList,
  projectCodexGatewayThreadItemsRead,
} from "../codex-runtime/CodexGatewayProtocolProjection";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import type { ThreadItem, ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  SessionHistoryReadError,
  type SessionHistorySource,
  type SessionItemReference,
  type SessionItemLocator,
  type SessionSourceContent,
} from "./SessionHistoryRead";

const failure = (cause: unknown) =>
  new SessionHistoryReadError({ reason: "history_unavailable", cause });
const readFailure = (
  cause: unknown,
  cursor: string | null,
  direction: "asc" | "desc",
  method: "thread/items/list" | "thread/items/read" = "thread/items/list",
) => {
  if (!Schema.is(CodexRuntimeError)(cause) || cause.reason !== "request" || cause.method !== method)
    return failure(cause);
  const request = cause.cause;
  if (
    !Schema.is(CodexAppServerRequestError)(request) ||
    request.operation !== "receive-response" ||
    request.method !== method
  )
    return failure(cause);
  if (request.code === -32601)
    return new SessionHistoryReadError({ reason: "source_limit", cause });
  if (method === "thread/items/read" && request.code === -32602)
    return new SessionHistoryReadError({ reason: "item_unavailable", cause });
  if (
    cursor === null ||
    (request.code !== -32602 &&
      !(request.code === -32600 && request.message.startsWith("invalid cursor:")))
  )
    return failure(cause);
  return new SessionHistoryReadError({
    reason: direction === "desc" ? "invalid_cursor" : "cursor_stale",
    cause,
  });
};
const message = (item: ThreadItem) =>
  item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan";
const forwardAnchor = z
  .strictObject({
    version: z.literal(1),
    nativeCursor: z.string().min(1).nullable(),
    itemId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
  })
  .refine((value) =>
    value.nativeCursor === null
      ? value.itemId === null && value.runId === null
      : value.itemId !== null && value.runId !== null,
  );
const startCursor = JSON.stringify({ version: 1, nativeCursor: null, itemId: null, runId: null });
const textOf = (item: ThreadItem): string => {
  if (item.type === "userMessage")
    return item.content
      .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
      .join("\n");
  if (item.type === "agentMessage" || item.type === "plan") return item.text;
  return JSON.stringify(item);
};
const sliceOf = (
  item: ThreadItem,
  reference: SessionItemReference,
  format: "text" | "json",
  offset: number,
  maxChars: number,
): SessionSourceContent => {
  const text = format === "text" ? textOf(item) : JSON.stringify(item);
  const textOffset = Math.min(offset, text.length);
  const end = Math.min(textOffset + maxChars, text.length);
  return {
    reference,
    text: text.slice(textOffset, end),
    textOffset,
    totalChars: text.length,
    nextTextOffset: end < text.length ? end : null,
    contentVersion: createHash("sha256").update(text).digest("hex"),
  };
};
const referenceOf = (threadId: string, entry: ThreadItemEntry): SessionItemReference => ({
  itemId: entry.item.id,
  sourceThreadId: threadId,
  runId: entry.turnId,
  type: entry.item.type,
  status:
    "status" in entry.item && typeof entry.item.status === "string" ? entry.item.status : null,
});

/** Native items use their producer's cursor and generated protocol types, without resuming a Thread. */
export const makeNativeSessionHistory = Effect.gen(function* () {
  const lookup = yield* CodexNativeThreadLookup;
  const gateway = yield* CodexGateway;
  return Effect.fn("NativeSessionHistory.resolve")(function* (
    threadId: string,
    hostId?: string,
    runId?: string,
  ) {
    const resolved = yield* lookup.resolve(threadId, hostId).pipe(Effect.mapError(failure));
    if (hostId !== undefined && resolved.hostId !== hostId)
      return yield* failure(new Error("The Session's bound execution host is unavailable"));
    const read = (
      cursor: string | null,
      direction: "asc" | "desc" = "desc",
      limit = 1,
      turnId = runId,
    ) =>
      gateway
        .requestOnHost(
          resolved.hostId,
          "thread/items/list",
          {
            threadId,
            cursor,
            limit,
            sortDirection: direction,
            ...(turnId === undefined ? {} : { turnId }),
          },
          {
            expectedHostId: resolved.hostId,
            expectedGeneration: resolved.manager.generation,
            timeoutMs: 10_000,
          },
        )
        .pipe(
          Effect.mapError((cause) => readFailure(cause, cursor, direction)),
          Effect.flatMap((page) =>
            Effect.try({
              try: () => {
                resolved.manager.assertCurrent();
                return projectCodexGatewayThreadItemsList(page);
              },
              catch: failure,
            }),
          ),
        );
    const page: SessionHistorySource["page"] = (input) =>
      Effect.gen(function* () {
        const items: Array<{
          reference: SessionItemReference;
          after: string | null;
          initialContent: SessionSourceContent;
        }> = [];
        if (input.order === "oldest_first") {
          const anchor = yield* Effect.try({
            try: () => forwardAnchor.parse(JSON.parse(input.cursor ?? startCursor)),
            catch: (cause) => new SessionHistoryReadError({ reason: "invalid_cursor", cause }),
          });
          let cursor = anchor.nativeCursor;
          let tailCursor = input.cursor ?? startCursor;
          if (cursor !== null) {
            const check = yield* read(cursor, "asc");
            const entry = check.data[0];
            if (!entry || entry.item.id !== anchor.itemId || entry.turnId !== anchor.runId)
              return yield* new SessionHistoryReadError({
                reason: "cursor_stale",
                cause: new Error("Forward history anchor is no longer visible"),
              });
            cursor = check.nextCursor ?? null;
            if (cursor === null) return { items, nextCursor: null, tailCursor };
          }
          for (let count = 0; count < input.limit; count++) {
            const response = yield* read(cursor, "asc");
            if (response.nextCursor !== null && response.nextCursor === cursor)
              return yield* new SessionHistoryReadError({
                reason: "invalid_cursor",
                cause: new Error("Native item cursor did not advance"),
              });
            const entry = response.data[0] as ThreadItemEntry | undefined;
            if (!entry) return { items, nextCursor: null, tailCursor };
            if (!response.backwardsCursor)
              return yield* new SessionHistoryReadError({
                reason: "source_limit",
                cause: new Error("Native history did not return a stable forward anchor"),
              });
            tailCursor = JSON.stringify({
              version: 1,
              nativeCursor: response.backwardsCursor,
              itemId: entry.item.id,
              runId: entry.turnId,
            });
            if (input.view === "activity" || message(entry.item))
              items.push({
                reference: referenceOf(threadId, entry),
                after: tailCursor,
                initialContent: sliceOf(
                  entry.item,
                  referenceOf(threadId, entry),
                  input.view === "messages" ? "text" : "json",
                  0,
                  input.maxCharsPerItem,
                ),
              });
            cursor = response.nextCursor ?? null;
            if (cursor === null) break;
          }
          return { items, nextCursor: cursor === null ? null : tailCursor, tailCursor };
        }
        let cursor = input.cursor ?? null;
        for (let count = 0; count < input.limit; count++) {
          const response = yield* read(cursor);
          if (response.nextCursor !== null && response.nextCursor === cursor)
            return yield* new SessionHistoryReadError({
              reason: "invalid_cursor",
              cause: new Error("Native item cursor did not advance"),
            });
          const entry = response.data[0] as ThreadItemEntry | undefined;
          if (entry && (input.view === "activity" || message(entry.item))) {
            if (!response.backwardsCursor)
              return yield* new SessionHistoryReadError({
                reason: "source_limit",
                cause: new Error("Native history did not return a resumable item cursor"),
              });
            items.push({
              reference: referenceOf(threadId, entry),
              after: response.nextCursor ?? null,
              initialContent: sliceOf(
                entry.item,
                referenceOf(threadId, entry),
                input.view === "messages" ? "text" : "json",
                0,
                input.maxCharsPerItem,
              ),
            });
          }
          cursor = response.nextCursor ?? null;
          if (cursor === null) break;
        }
        return { items, nextCursor: cursor, tailCursor: cursor };
      });
    const readItem = Effect.fn("NativeSessionHistory.item")(function* (
      locator: SessionItemLocator,
    ) {
      if (
        (locator.sourceThreadId !== undefined && locator.sourceThreadId !== threadId) ||
        !locator.runId
      )
        return yield* new SessionHistoryReadError({
          reason: "item_unavailable",
          cause: new Error("A native point item needs its original Thread and Run"),
        });
      const response = yield* gateway
        .requestOnHost(
          resolved.hostId,
          "thread/items/read",
          {
            threadId,
            turnId: locator.runId,
            itemIds: [locator.itemId],
          },
          {
            expectedHostId: resolved.hostId,
            expectedGeneration: resolved.manager.generation,
            timeoutMs: 10_000,
          },
        )
        .pipe(Effect.mapError((cause) => readFailure(cause, null, "asc", "thread/items/read")));
      yield* Effect.try({ try: () => resolved.manager.assertCurrent(), catch: failure });
      const entry = projectCodexGatewayThreadItemsRead(response).data.find(
        (entry) => entry.item.id === locator.itemId && entry.turnId === locator.runId,
      );
      if (!entry)
        return yield* new SessionHistoryReadError({
          reason: "item_unavailable",
          cause: new Error("Native item is no longer visible in this Run"),
        });
      return { entry, reference: referenceOf(threadId, entry) };
    });
    const content: SessionHistorySource["content"] = (input) =>
      readItem(input.locator).pipe(
        Effect.map(({ entry, reference }) =>
          sliceOf(entry.item, reference, input.format, input.offset, input.maxChars),
        ),
      );
    const source: SessionHistorySource = {
      kind: "codex",
      page,
      content,
      locate: (input) =>
        Effect.gen(function* () {
          if (
            input.locator.sourceThreadId !== undefined &&
            input.locator.sourceThreadId !== threadId
          )
            return yield* new SessionHistoryReadError({
              reason: "item_unavailable",
              cause: new Error("Item belongs to another Thread"),
            });
          if (input.locator.runId) {
            const selected = yield* readItem(input.locator);
            return {
              content: sliceOf(
                selected.entry.item,
                selected.reference,
                input.format,
                input.offset,
                input.maxChars,
              ),
              nextCursor: null,
            };
          }
          let cursor = input.cursor ?? null;
          for (let count = 0; count < 4; count++) {
            const response = yield* read(cursor, "desc", 20);
            const entry = response.data.find((entry) => entry.item.id === input.locator.itemId);
            if (entry) {
              if (!response.backwardsCursor)
                return yield* new SessionHistoryReadError({
                  reason: "source_limit",
                  cause: new Error("Native history did not return a resumable item cursor"),
                });
              const reference = referenceOf(threadId, entry);
              return {
                content: sliceOf(entry.item, reference, input.format, input.offset, input.maxChars),
                nextCursor: null,
              };
            }
            const next = response.nextCursor ?? null;
            if (next !== null && next === cursor)
              return yield* new SessionHistoryReadError({
                reason: "invalid_cursor",
                cause: new Error("Native locator did not advance"),
              });
            if (next === null) return { content: null, nextCursor: null };
            cursor = next;
          }
          return { content: null, nextCursor: cursor };
        }),
      progress: () =>
        Effect.gen(function* () {
          const recent = yield* page({
            view: "activity",
            order: "newest_first",
            limit: 20,
            maxCharsPerItem: 160,
          });
          const reply = recent.items.find((entry) => entry.reference.type === "agentMessage");
          const activity = recent.items.find(
            (entry) =>
              !["agentMessage", "userMessage", "plan", "reasoning"].includes(entry.reference.type),
          );
          return {
            coverage: recent.nextCursor === null ? "complete" : "recent_window",
            nextCursor: recent.nextCursor,
            latestMessage: reply
              ? {
                  reference: reply.reference,
                  content: yield* content({
                    locator: reply.reference,
                    format: "text",
                    offset: 0,
                    maxChars: 160,
                  }),
                }
              : null,
            latestTool: activity
              ? {
                  id: activity.reference.itemId,
                  runId: activity.reference.runId,
                  type: activity.reference.type,
                  status: activity.reference.status,
                }
              : null,
          };
        }),
    };
    return { source, readItem, thread: resolved.thread, hostId: resolved.hostId };
  });
});
