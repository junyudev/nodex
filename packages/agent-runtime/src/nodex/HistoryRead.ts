import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  History,
  HistoryContent,
  HistoryItem,
  HistoryView,
  HistoryOrder,
  HistoryData,
  HistoryProgress,
  ThreadReadEvidence,
} from "./history-contracts.ts";

import { HISTORY_CURSOR_MAX_CHARS } from "./history-contracts.ts";

export const HISTORY_READ_MAX_BYTES = 24 * 1024;
export interface HistoryInput {
  readonly ownerId: string;
  readonly cursor?: string;
  readonly itemId?: string;
  readonly runId?: string;
  readonly sourceThreadId?: string;
  readonly textOffset?: number;
  readonly view?: HistoryView;
  readonly order?: HistoryOrder;
  readonly limit: number;
  readonly maxCharsPerItem: number;
}

export class HistoryReadError extends Schema.TaggedError<HistoryReadError>()("HistoryReadError", {
  reason: Schema.Literals([
    "invalid_cursor",
    "cursor_stale",
    "history_unavailable",
    "item_unavailable",
    "source_limit",
  ]),
  cause: Schema.Defect(),
}) {}

const identityString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const locatorSchema = Schema.Struct({
  itemId: identityString,
  sourceThreadId: Schema.optional(identityString),
  runId: Schema.optional(Schema.NullOr(identityString)),
});
/** An address only: metadata is always reconstructed by the authorized source. */
export type HistoryItemLocator = typeof locatorSchema.Type;
export interface HistoryItemReference extends HistoryItemLocator {
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly type: string;
  readonly status: string | null;
  readonly visibility?: "local" | "inherited" | "synthetic";
  readonly title?: string | null;
  readonly updatedAt?: string;
  readonly messageId?: string | null;
  readonly createdBy?: string | null;
  readonly creationSource?: string | null;
  readonly senderThreadId?: string | null;
}
const locatorOf = (reference: HistoryItemLocator): HistoryItemLocator => ({
  itemId: reference.itemId,
  ...(reference.sourceThreadId === undefined ? {} : { sourceThreadId: reference.sourceThreadId }),
  ...(reference.runId === undefined ? {} : { runId: reference.runId }),
});
const cursorBase = {
  v: Schema.Literal(2),
  ownerId: Schema.String,
  binding: Schema.String,
  view: Schema.Literals(["messages", "activity"]),
  order: Schema.Literals(["newest_first", "oldest_first"]),
};
const cursorSchema = Schema.Union([
  Schema.Struct({ ...cursorBase, kind: Schema.Literal("page"), sourceCursor: Schema.String }),
  Schema.Struct({
    ...cursorBase,
    kind: Schema.Literal("locate"),
    locator: locatorSchema,
    sourceCursor: Schema.String,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    ...cursorBase,
    kind: Schema.Literal("content"),
    locator: locatorSchema,
    format: Schema.Literals(["text", "json"]),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    version: Schema.String,
  }),
]);
type HistoryCursor = typeof cursorSchema.Type;
const parseCursor = Schema.decodeUnknownSync(cursorSchema, { onExcessProperty: "error" });

export interface HistorySourceContent {
  readonly reference: HistoryItemReference;
  readonly text: string;
  readonly textOffset: number;
  readonly totalChars: number;
  readonly nextTextOffset: number | null;
  readonly contentVersion: string;
}
export interface HistorySource {
  readonly kind: string;
  readonly page: (input: {
    readonly cursor?: string;
    readonly view: HistoryView;
    readonly order: HistoryOrder;
    readonly limit: number;
    readonly maxCharsPerItem: number;
  }) => Effect.Effect<
    {
      readonly items: readonly {
        readonly reference: HistoryItemReference;
        readonly after: string | null;
        readonly initialContent?: HistorySourceContent;
      }[];
      readonly nextCursor: string | null;
      readonly tailCursor: string | null;
    },
    HistoryReadError
  >;
  readonly content: (input: {
    readonly locator: HistoryItemLocator;
    readonly format: "text" | "json";
    readonly offset: number;
    readonly maxChars: number;
  }) => Effect.Effect<HistorySourceContent, HistoryReadError>;
  /** Sources without direct item lookup advance a bounded, resumable locator scan. */
  readonly locate?: (input: {
    readonly locator: HistoryItemLocator;
    readonly cursor?: string;
    readonly format: "text" | "json";
    readonly offset: number;
    readonly maxChars: number;
  }) => Effect.Effect<
    { readonly content: HistorySourceContent | null; readonly nextCursor: string | null },
    HistoryReadError
  >;
  readonly progress: () => Effect.Effect<
    {
      readonly latestMessage: {
        readonly reference: HistoryItemReference;
        readonly content: HistorySourceContent;
      } | null;
      readonly latestTool: HistoryProgress["latestTool"];
      readonly coverage: "complete" | "recent_window";
      readonly nextCursor: string | null;
    },
    HistoryReadError
  >;
}

const encode = (cursor: HistoryCursor): string =>
  `nxh2.${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
const decode = (value: string, ownerId: string, binding: string) =>
  Effect.try({
    try: () => {
      if (value.length > HISTORY_CURSOR_MAX_CHARS || !value.startsWith("nxh2."))
        throw new Error("Unknown history cursor");
      const parsed = parseCursor(
        JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")),
      );
      if (parsed.ownerId !== ownerId || parsed.binding !== binding)
        throw new Error("History cursor belongs to another history binding");
      return parsed;
    },
    catch: (cause) => new HistoryReadError({ reason: "invalid_cursor", cause }),
  });

const identity = (reference: HistoryItemReference) => ({
  id: reference.itemId,
  sourceThreadId: reference.sourceThreadId,
  runId: reference.runId,
  type: reference.type,
  status: reference.status,
  ...(reference.visibility === undefined ? {} : { visibility: reference.visibility }),
  ...(reference.title === undefined ? {} : { title: reference.title }),
  ...(reference.updatedAt === undefined ? {} : { updatedAt: reference.updatedAt }),
  ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
  ...(reference.createdBy === undefined ? {} : { createdBy: reference.createdBy }),
  ...(reference.creationSource === undefined ? {} : { creationSource: reference.creationSource }),
  ...(reference.senderThreadId === undefined ? {} : { senderThreadId: reference.senderThreadId }),
});

const itemContent = (input: {
  readonly ownerId: string;
  readonly binding: string;
  readonly source: HistorySource;
  readonly view: HistoryView;
  readonly order: HistoryOrder;
  readonly reference: HistoryItemReference;
  readonly slice: HistorySourceContent;
  readonly chars: number;
}): HistoryContent => {
  const { slice } = input;
  const text = slice.text.slice(0, input.chars);
  const end = slice.textOffset + text.length;
  const format = input.view === "messages" ? "text" : "json";
  const nextCursor =
    end < slice.totalChars
      ? encode({
          v: 2,
          kind: "content",
          ownerId: input.ownerId,
          binding: input.binding,
          view: input.view,
          order: input.order,
          locator: locatorOf(input.reference),
          format,
          offset: end,
          version: slice.contentVersion,
        })
      : null;
  const position = { offset: slice.textOffset, totalChars: slice.totalChars, nextCursor };
  if (format === "text") return { ...position, format, text };
  if (slice.textOffset !== 0 || end !== slice.totalChars)
    return { ...position, format: "json_fragment", text };
  return { ...position, format: "json", value: JSON.parse(text) as HistoryData };
};

/** Fragment offsets refer to the same JSON value delivered by a complete activity item. */
const readContent = Effect.fn("HistoryRead.content")(function* (
  source: HistorySource,
  input: {
    readonly locator: HistoryItemLocator;
    readonly format: "text" | "json";
    readonly offset: number;
    readonly maxChars: number;
    readonly expectedVersion?: string;
    readonly initialContent?: HistorySourceContent;
  },
) {
  const prefix = `{"source":${JSON.stringify(source.kind)},"item":`;
  const rawOffset =
    input.format === "text" ? input.offset : Math.max(0, input.offset - prefix.length);
  const raw = input.initialContent ?? (yield* source.content({ ...input, offset: rawOffset }));
  if (input.expectedVersion !== undefined && raw.contentVersion !== input.expectedVersion)
    return yield* new HistoryReadError({
      reason: "cursor_stale",
      cause: new Error("Item content changed; read a fresh history page"),
    });
  if (input.format === "text") {
    if (input.offset > raw.totalChars)
      return yield* new HistoryReadError({
        reason: "invalid_cursor",
        cause: new Error("Content offset is outside this item"),
      });
    return raw;
  }
  const totalChars = prefix.length + raw.totalChars + 1;
  if (input.offset >= totalChars)
    return yield* new HistoryReadError({
      reason: "invalid_cursor",
      cause: new Error("Content offset is outside this item"),
    });
  const before = input.offset < prefix.length ? prefix.slice(input.offset) : "";
  const after = raw.textOffset + raw.text.length === raw.totalChars ? "}" : "";
  const text = `${before}${raw.text}${after}`.slice(0, input.maxChars);
  const end = input.offset + text.length;
  return {
    ...raw,
    text,
    textOffset: input.offset,
    totalChars,
    nextTextOffset: end < totalChars ? end : null,
  };
});

/** Stateless continuations locate data; private evidence reports only ranges admitted to the final envelope. */
export const readHistory = Effect.fn("HistoryRead.read")(function* (input: {
  readonly request: HistoryInput;
  readonly binding: string;
  readonly source: HistorySource;
  readonly wrap: (history: History) => Record<string, unknown>;
}) {
  const { request, binding, source } = input;
  if (
    (request.cursor !== undefined &&
      (request.itemId !== undefined ||
        request.runId !== undefined ||
        request.sourceThreadId !== undefined ||
        request.textOffset !== undefined)) ||
    (request.itemId === undefined &&
      (request.runId !== undefined ||
        request.sourceThreadId !== undefined ||
        request.textOffset !== undefined)) ||
    (request.textOffset !== undefined &&
      (!Number.isSafeInteger(request.textOffset) || request.textOffset < 0))
  )
    return yield* new HistoryReadError({
      reason: "invalid_cursor",
      cause: new Error("Point reads require itemId and cannot include a cursor"),
    });
  const cursor = request.cursor ? yield* decode(request.cursor, request.ownerId, binding) : null;
  const view = request.view ?? cursor?.view ?? "messages";
  const order = request.order ?? cursor?.order ?? "newest_first";
  if (
    cursor &&
    (cursor.view !== view ||
      cursor.order !== order ||
      (cursor.kind === "content" && cursor.format !== (view === "messages" ? "text" : "json")))
  )
    return yield* new HistoryReadError({
      reason: "invalid_cursor",
      cause: new Error("History view changed during pagination"),
    });
  const page = (
    items: readonly HistoryItem[],
    sourceCursor: string | null,
    tailCursor: string | null = sourceCursor,
  ): History => ({
    availability: "available",
    items,
    page: {
      order,
      view,
      limit: request.limit,
      hasMore: sourceCursor !== null,
      nextCursor:
        sourceCursor === null
          ? null
          : encode({
              v: 2,
              kind: "page",
              ownerId: request.ownerId,
              binding,
              view,
              order,
              sourceCursor,
            }),
      tailCursor:
        tailCursor === null
          ? null
          : encode({
              v: 2,
              kind: "page",
              ownerId: request.ownerId,
              binding,
              view,
              order,
              sourceCursor: tailCursor,
            }),
    },
  });
  const fits = (history: History) =>
    history.availability === "available" &&
    (history.page.nextCursor?.length ?? 0) <= HISTORY_CURSOR_MAX_CHARS &&
    (history.page.tailCursor?.length ?? 0) <= HISTORY_CURSOR_MAX_CHARS &&
    history.items.every(
      (item) => (item.content.nextCursor?.length ?? 0) <= HISTORY_CURSOR_MAX_CHARS,
    ) &&
    historyResultBytes(input.wrap(history)) <= HISTORY_READ_MAX_BYTES;
  const evidence = new Map<HistoryItem, ThreadReadEvidence>();
  const finish = (history: History) => ({
    history,
    admitted:
      history.availability === "available"
        ? history.items.flatMap((item) => (evidence.has(item) ? [evidence.get(item)!] : []))
        : [],
  });
  const admit = (
    slice: HistorySourceContent,
    existing: readonly HistoryItem[],
    after: string | null,
  ): HistoryItem | null => {
    const retain = (item: HistoryItem) => {
      evidence.set(item, {
        itemId: item.id,
        sourceThreadId: item.sourceThreadId,
        format: view === "messages" ? "text" : "json",
        contentVersion: slice.contentVersion,
        offset: item.content.offset,
        length:
          item.content.format === "json"
            ? JSON.stringify(item.content.value).length
            : item.content.text.length,
        totalChars: item.content.totalChars,
      });
      return item;
    };
    const candidate = (chars: number): HistoryItem => ({
      ...identity(slice.reference),
      content: itemContent({
        ownerId: request.ownerId,
        binding,
        source,
        view,
        order,
        reference: slice.reference,
        slice,
        chars,
      }),
    });
    const whole = candidate(slice.text.length);
    if (fits(page([...existing, whole], after))) return retain(whole);
    if (existing.length > 0) return null;
    let low = 0;
    let high = slice.text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(page([candidate(middle)], after))) low = middle;
      else high = middle - 1;
    }
    if (slice.text.length > 0 && low === 0) return null;
    const bounded = candidate(low);
    return fits(page([bounded], after)) ? retain(bounded) : null;
  };
  if (cursor?.kind === "content" || cursor?.kind === "locate" || request.itemId !== undefined) {
    const locator =
      cursor?.kind === "content" || cursor?.kind === "locate"
        ? cursor.locator
        : {
            itemId: request.itemId!,
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            ...(request.sourceThreadId === undefined
              ? {}
              : { sourceThreadId: request.sourceThreadId }),
          };
    const offset =
      cursor?.kind === "content" || cursor?.kind === "locate"
        ? cursor.offset
        : (request.textOffset ?? 0);
    const format = view === "messages" ? "text" : "json";
    const located =
      source.locate && cursor?.kind !== "content"
        ? yield* source.locate({
            locator,
            format,
            offset:
              format === "text"
                ? offset
                : Math.max(0, offset - `{"source":${JSON.stringify(source.kind)},"item":`.length),
            maxChars: request.maxCharsPerItem,
            ...(cursor?.kind === "locate" ? { cursor: cursor.sourceCursor } : {}),
          })
        : null;
    if (located && !located.content) {
      if (located.nextCursor === null)
        return yield* new HistoryReadError({
          reason: "item_unavailable",
          cause: new Error("Item is not visible in this history"),
        });
      const continuation = encode({
        v: 2,
        kind: "locate",
        ownerId: request.ownerId,
        binding,
        view,
        order,
        locator: locatorOf(locator),
        offset,
        sourceCursor: located.nextCursor,
      });
      const result: History = {
        availability: "available",
        items: [],
        page: {
          order,
          view,
          limit: request.limit,
          hasMore: true,
          locating: true,
          nextCursor: continuation,
          tailCursor: null,
        },
      };
      if (fits(result)) return finish(result);
      return yield* new HistoryReadError({
        reason: "source_limit",
        cause: new Error("Locator continuation exceeds response budget"),
      });
    }
    const slice = yield* readContent(source, {
      locator,
      format,
      offset,
      maxChars: request.maxCharsPerItem,
      ...(cursor?.kind === "content" ? { expectedVersion: cursor.version } : {}),
      ...(located?.content ? { initialContent: located.content } : {}),
    });
    const selected = admit(slice, [], null);
    if (selected) return finish(page([selected], null));
    return yield* new HistoryReadError({
      reason: "source_limit",
      cause: new Error("Item identity exceeds response budget"),
    });
  }
  const sourcePage = yield* source.page({
    ...(cursor?.kind === "page" ? { cursor: cursor.sourceCursor } : {}),
    view,
    order,
    limit: request.limit,
    maxCharsPerItem: request.maxCharsPerItem,
  });
  const selected: HistoryItem[] = [];
  let after = cursor?.kind === "page" ? cursor.sourceCursor : null;
  for (const entry of sourcePage.items) {
    const slice = yield* readContent(source, {
      locator: locatorOf(entry.reference),
      ...(entry.initialContent === undefined ? {} : { initialContent: entry.initialContent }),
      format: view === "messages" ? "text" : "json",
      offset: 0,
      maxChars: request.maxCharsPerItem,
    });
    const candidate = admit(slice, selected, entry.after);
    if (!candidate) {
      if (selected.length > 0) return finish(page(selected, after));
      return yield* new HistoryReadError({
        reason: "source_limit",
        cause: new Error("Item identity exceeds response budget"),
      });
    }
    selected.push(candidate);
    after = entry.after;
  }
  const result = page(selected, sourcePage.nextCursor, sourcePage.tailCursor);
  if (fits(result)) return finish(result);
  return yield* new HistoryReadError({
    reason: "source_limit",
    cause: new Error("History metadata exceeds response budget"),
  });
});

export const readHistoryProgress = Effect.fn("HistoryRead.progress")(function* (input: {
  readonly ownerId: string;
  readonly binding: string;
  readonly source: HistorySource;
}): Effect.fn.Return<HistoryProgress, HistoryReadError> {
  const progress = yield* input.source.progress();
  const reply = progress.latestMessage;
  const result: HistoryProgress = {
    availability: "available",
    coverage: progress.coverage,
    nextCursor:
      progress.nextCursor === null
        ? null
        : encode({
            v: 2,
            kind: "page",
            ownerId: input.ownerId,
            binding: input.binding,
            view: "messages",
            order: "newest_first",
            sourceCursor: progress.nextCursor,
          }),
    latestMessage: reply
      ? {
          ...identity(reply.reference),
          content: itemContent({
            ...input,
            view: "messages",
            order: "newest_first",
            reference: reply.reference,
            slice: reply.content,
            chars: 160,
          }),
        }
      : null,
    latestTool: progress.latestTool,
  };
  if (
    (result.nextCursor?.length ?? 0) > HISTORY_CURSOR_MAX_CHARS ||
    (result.latestMessage?.content.nextCursor?.length ?? 0) > HISTORY_CURSOR_MAX_CHARS
  )
    return yield* new HistoryReadError({
      reason: "source_limit",
      cause: new Error("Progress identity exceeds the cursor budget"),
    });
  return result;
});

/** Admission charges text plus structuredContent exactly as the MCP transport delivers them. */
export const historyResultBytes = (value: Record<string, unknown>): number =>
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    }),
    "utf8",
  );
