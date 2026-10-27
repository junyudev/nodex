import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { prepareMessageSearch } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import {
  projectCodexGatewayThreadItemsList,
  projectCodexGatewayThreadItemsRead,
} from "../codex-runtime/CodexGatewayProtocolProjection";

const Position = z.strictObject({ after: z.string().nullable(), through: z.string() });
export class NativeSessionSearchStale extends Schema.TaggedError<NativeSessionSearchStale>()(
  "NativeSessionSearchStale",
  { cause: Schema.Defect() },
) {}
export interface NativeSearchTarget {
  readonly hostId: string;
  readonly threadId: string;
}
export interface NativeSearchReference {
  readonly itemId: string;
  readonly runId: string;
  readonly contentVersion: string;
}
export interface NativeSearchFact {
  readonly reference: NativeSearchReference;
  readonly source: "user" | "assistant";
  readonly quality: number;
  readonly hits: number;
  readonly messageAt: string;
  readonly snippet: string;
}
const textOf = ({ item }: ThreadItemEntry): string | null => {
  if (item.type === "agentMessage") return item.text;
  if (item.type !== "userMessage") return null;
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};
const versionOf = (entry: ThreadItemEntry, text: string) =>
  createHash("sha256")
    .update(JSON.stringify([entry.turnId, entry.item.id, entry.item.type, entry.startedAtMs, text]))
    .digest("base64url");
const timestampOf = (value: unknown): string | null => {
  if (typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const factOf = (entry: ThreadItemEntry, query: string): NativeSearchFact | null => {
  const text = textOf(entry);
  if (text === null) return null;
  const match = prepareMessageSearch(query)?.match(text);
  if (!match) return null;
  return {
    reference: {
      itemId: entry.item.id,
      runId: entry.turnId,
      contentVersion: versionOf(entry, text),
    },
    ...match,
    hits: 1,
    source: entry.item.type === "userMessage" ? "user" : "assistant",
    messageAt: timestampOf(entry.startedAtMs) ?? "",
  };
};

/** Native facts use bounded producer pages and a fixed tail, with the same complete-text matcher
 * as Runtime facts. Only compact references survive; selected messages are canonically reread. */
export const makeNativeSessionSearch = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const managers = yield* CodexMainConversationManagers;
  const read = (
    target: NativeSearchTarget,
    cursor: string | null,
    direction: "asc" | "desc" = "asc",
    limit = 20,
  ) =>
    Effect.gen(function* () {
      const manager = yield* managers.get(target.hostId);
      const page = yield* gateway
        .requestOnHost(
          target.hostId,
          "thread/items/list",
          {
            threadId: target.threadId,
            cursor,
            limit,
            sortDirection: direction,
          },
          {
            expectedHostId: target.hostId,
            expectedGeneration: manager.generation,
            timeoutMs: 10_000,
          },
        )
        .pipe(
          Effect.mapError((cause) => {
            if (
              cursor === null ||
              !Schema.is(CodexRuntimeError)(cause) ||
              !Schema.is(CodexAppServerRequestError)(cause.cause)
            )
              return cause;
            const error = cause.cause;
            return error.code === -32602 ||
              (error.code === -32600 && error.message.startsWith("invalid cursor:"))
              ? new NativeSessionSearchStale({ cause })
              : cause;
          }),
        );
      yield* Effect.try({ try: manager.assertCurrent, catch: (cause) => cause });
      if (page.nextCursor !== null && page.nextCursor === cursor)
        return yield* Effect.fail(new Error("Native search cursor did not advance"));
      return projectCodexGatewayThreadItemsList(page);
    });
  return {
    page: (
      input: NativeSearchTarget & { readonly query: string; readonly cursor: string | null },
    ) =>
      Effect.gen(function* () {
        const position =
          input.cursor === null
            ? null
            : yield* Effect.try(() => Position.parse(JSON.parse(input.cursor!)));
        const through = position?.through ?? (yield* read(input, null, "desc", 1)).data[0]?.item.id;
        if (through === undefined)
          return { items: [], nextCursor: null, latestUserMessageAt: null };
        const after = position?.after ?? null;
        const page = yield* read(input, after);
        const end = page.data.findIndex((entry) => entry.item.id === through);
        if (end < 0 && page.nextCursor === null)
          return yield* new NativeSessionSearchStale({
            cause: "Native search tail is no longer visible",
          });
        const visible = end < 0 ? page.data : page.data.slice(0, end + 1);
        const latestUserMessageAt = visible.reduce<string | null>((latest, entry) => {
          if (entry.item.type !== "userMessage") return latest;
          const at = timestampOf(entry.startedAtMs);
          if (at === null) return latest;
          return latest === null || at > latest ? at : latest;
        }, null);
        const items = visible.flatMap((entry) => {
          const fact = factOf(entry, input.query);
          return fact ? [fact] : [];
        });
        return {
          items,
          latestUserMessageAt,
          nextCursor:
            end >= 0 || page.nextCursor === null
              ? null
              : JSON.stringify({ after: page.nextCursor, through }),
        };
      }),
    resolve: (
      input: NativeSearchTarget & {
        readonly query: string;
        readonly reference: NativeSearchReference;
      },
    ) =>
      Effect.gen(function* () {
        const manager = yield* managers.get(input.hostId);
        const response = yield* gateway.requestOnHost(
          input.hostId,
          "thread/items/read",
          {
            threadId: input.threadId,
            turnId: input.reference.runId,
            itemIds: [input.reference.itemId],
          },
          {
            expectedHostId: input.hostId,
            expectedGeneration: manager.generation,
            timeoutMs: 10_000,
          },
        );
        yield* Effect.try({ try: manager.assertCurrent, catch: (cause) => cause });
        const page = projectCodexGatewayThreadItemsRead(response);
        const entry = page.data.find(
          (candidate) =>
            candidate.item.id === input.reference.itemId &&
            candidate.turnId === input.reference.runId,
        );
        const fact = entry ? factOf(entry, input.query) : null;
        if (fact === null || fact.reference.contentVersion !== input.reference.contentVersion)
          return yield* new NativeSessionSearchStale({
            cause: "Native search message changed or is no longer visible",
          });
        return fact;
      }),
  };
});
export type NativeSessionSearch = Effect.Success<typeof makeNativeSessionSearch>;
