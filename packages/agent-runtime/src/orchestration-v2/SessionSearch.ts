import { compileSearchQuery, type SearchTextQuery } from "@nodex/search-kernel/node";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  fieldRank,
  matchedRanges,
  phraseBonus,
  rankQuality,
  searchEvidenceExcerpt,
  searchableMessageText,
} from "./SessionSearchText.ts";
import {
  chooseSearchItems,
  indexedHistory,
  type CatalogWordRanks,
  type IndexedHit,
  type RankedHistory,
} from "./SessionSearchIndex.ts";
import { refreshSessionSearch } from "../persistence/SessionSearchProjection.ts";
import {
  actionSearchSource,
  searchableMessageItem,
  searchableRun,
  searchableThread,
} from "../persistence/SessionSearchSources.ts";

export interface SessionSearchInput {
  readonly query: string;
  /** Core-admitted root executions; an empty set admits no history work. */
  readonly threadIds?: readonly string[] | undefined;
  /** Best catalog evidence per required query word, in query order. */
  readonly metadata?: readonly CatalogWordRanks[] | undefined;
  readonly strongWords?: readonly boolean[] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export type SessionSearchItemSource = "user" | "assistant" | "command_execution" | "file_change";
export interface SessionMessageMatch {
  readonly threadId: string;
  readonly itemId: string;
  readonly messageId: string | null;
  readonly runId: string | null;
  readonly source: SessionSearchItemSource;
  readonly snippet: string;
  readonly matchedText: string;
  /** When the selected item contributes one word of a distributed match. */
  readonly matchedWord?: number;
  readonly matchRank?: number;
  readonly messageAt: string;
  readonly cursor: string;
  readonly wordQuality: number;
  readonly quality: number;
  readonly hits: number;
  readonly contentVersion: string;
}
export interface SessionSearchPage {
  readonly items: readonly SessionMessageMatch[];
  readonly nextCursor: string | null;
  readonly coverage: "indexed";
  readonly strongWords: readonly boolean[];
  readonly startCursor: string | null;
  /** Some eligible history is still indexing or changed before the page was hydrated. */
  readonly truncated: boolean;
}
type Fact = Omit<SessionMessageMatch, "cursor">;
type Snapshot = RankedHistory & {
  readonly scope: string;
  readonly selected: Map<string, IndexedHit | null>;
};
const searchStates = new WeakMap<
  SqlClient.SqlClient,
  {
    readonly key: Uint8Array;
    readonly snapshots: Map<string, Snapshot>;
  }
>();
const Cursor = Schema.Struct({ id: Schema.String, offset: Schema.Int });
const decodePosition = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor));
export class SessionSearchError extends Schema.TaggedError<SessionSearchError>()(
  "SessionSearchError",
  {
    reason: Schema.Literals(["invalid_cursor", "cursor_stale"]),
    cause: Schema.Defect(),
  },
) {}
const failure = (reason: SessionSearchError["reason"], message: string) =>
  new SessionSearchError({ reason, cause: new Error(message) });

interface Candidate {
  readonly row_id: number;
  readonly thread_id: string;
  readonly item_id: string;
  readonly message_id: string | null;
  readonly run_id: string | null;
  readonly role: SessionSearchItemSource;
  readonly created_at: string;
  readonly body: string;
}
const actionSource = (source: SessionSearchItemSource) =>
  source !== "user" && source !== "assistant";
const versionOf = (row: Candidate, text: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        row.thread_id,
        row.item_id,
        row.message_id,
        row.run_id,
        row.role,
        row.created_at,
        text,
      ]),
    )
    .digest("base64url");
const candidateSource = (sql: SqlClient.SqlClient, action: boolean) => {
  const text = action
    ? sql`source.text`
    : sql`CASE WHEN json_valid(source.payload_json) THEN json_extract(source.payload_json,'$.text') END`;
  const item = action ? sql`source.turn_item_id` : sql`item.turn_item_id`;
  const messageId = action ? sql`NULL` : sql`source.message_id`;
  const run = action ? sql`source.run_id` : sql`item.run_id`;
  const rowId = action ? sql`source.row_id` : sql`source.rowid`;
  const fields = sql`${rowId} AS row_id,source.thread_id,
    ${item} AS item_id,${messageId} AS message_id,${run} AS run_id,
    ${action ? sql`source.type` : sql`source.role`} AS role,
    ${action ? sql`source.updated_at` : sql`source.created_at`} AS created_at,${text} AS body`;
  const from = sql`FROM ${action ? actionSearchSource(sql) : sql`orchestration_v2_projection_messages`} source
    JOIN orchestration_v2_projection_threads thread ON thread.thread_id=source.thread_id
    ${
      action
        ? sql``
        : sql`JOIN orchestration_v2_projection_turn_items item ON item.thread_id=source.thread_id AND item.turn_item_id=(
      SELECT candidate.turn_item_id FROM orchestration_v2_projection_turn_items candidate
      WHERE candidate.thread_id=source.thread_id AND candidate.type IN ('user_message','assistant_message')
        AND CASE WHEN json_valid(candidate.payload_json) THEN json_extract(candidate.payload_json,'$.messageId') END=source.message_id
      ORDER BY candidate.ordinal DESC,candidate.turn_item_id LIMIT 1)`
    }
    LEFT JOIN orchestration_v2_projection_runs run ON run.run_id=${run}
    WHERE ${searchableThread(sql, "thread")} AND ${searchableRun(sql)} AND typeof(${text})='text'
      ${
        action
          ? sql``
          : sql`AND source.streaming=0 AND source.role IN ('user','assistant')
        AND CASE WHEN json_valid(source.payload_json) THEN json_extract(source.payload_json,'$.notification') IS NULL ELSE 0 END
        AND ${searchableMessageItem(sql)}`
      }`;
  return { fields, from, rowId, item, messageId };
};

function pointEvidence(
  row: Candidate,
  query: SearchTextQuery,
  matchedWord: number | undefined,
  expectedRank: number | undefined,
) {
  const action = actionSource(row.role);
  const field = action ? "action" : "message";
  const text = action ? row.body : searchableMessageText(row.body);
  const allowTypo = expectedRank === undefined || expectedRank === fieldRank("typo", field);
  const evidence = query.evidence(text, "long_text", allowTypo);
  const words = matchedWord === undefined ? evidence.words : [evidence.words[matchedWord] ?? null];
  if (!words.length || words.some((word) => word === null)) return null;
  const rank = Math.max(...words.map((word) => fieldRank(word!.quality, field)));
  if (expectedRank !== undefined && rank !== expectedRank) return null;
  const ordered = matchedWord === undefined && evidence.ordered;
  const excerpt = searchEvidenceExcerpt(text, matchedRanges(words), ordered);
  if (!excerpt) return null;
  const wordQuality = rankQuality(rank);
  return {
    ...excerpt,
    threadId: row.thread_id,
    itemId: row.item_id,
    messageId: row.message_id,
    source: row.role,
    runId: row.run_id,
    messageAt: row.created_at,
    contentVersion: versionOf(row, row.body),
    wordQuality,
    quality: wordQuality + (ordered ? phraseBonus : 0),
  };
}

const readFacts = Effect.fn("SessionSearch.excerpts")(function* (
  sql: SqlClient.SqlClient,
  query: SearchTextQuery,
  items: readonly (IndexedHit | null)[],
) {
  const candidates: Map<number, Candidate>[] = [];
  for (const lane of [0, 1] as const) {
    const rowIds = items.flatMap((item) => (item?.lane === lane ? [item.row_id] : []));
    const { fields, from, rowId } = candidateSource(sql, lane === 1);
    const rows = rowIds.length
      ? yield* sql<Candidate>`SELECT ${fields} ${from}
          AND ${rowId} IN (SELECT value FROM json_each(${JSON.stringify(rowIds)}))`
      : [];
    candidates.push(new Map(rows.map((row) => [row.row_id, row])));
  }
  return items.map((item): Fact | null => {
    if (!item) return null;
    const row = candidates[item.lane]!.get(item.row_id);
    if (row?.thread_id !== item.thread_id) return null;
    const matchedWord = item.ordered ? undefined : item.word;
    const matchRank = item.ordered ? undefined : item.word_rank;
    const evidence = pointEvidence(row, query, matchedWord, matchRank);
    if (!evidence) return null;
    const wordQuality = rankQuality(item.weakest);
    return {
      ...evidence,
      ...(matchedWord === undefined ? {} : { matchedWord }),
      ...(matchRank === undefined ? {} : { matchRank }),
      wordQuality,
      quality: wordQuality + (item.ordered ? phraseBonus : 0),
      hits: item.hits,
    };
  });
});

/** Rank from the index once, then hydrate excerpts for each page of winning items. */
export const readSessionSearch = Effect.fn("SessionSearch.read")(function* (
  input: SessionSearchInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const state = searchStates.get(sql) ?? {
    key: randomBytes(32),
    snapshots: new Map<string, Snapshot>(),
  };
  searchStates.set(sql, state);
  const query = input.query.trim();
  const threadIds =
    input.threadIds === undefined ? undefined : [...new Set(input.threadIds)].sort();
  const scope = createHash("sha256")
    .update(JSON.stringify([query, threadIds, input.metadata, input.strongWords]))
    .digest("base64url");
  using prepared = compileSearchQuery(query);
  if (
    !query ||
    query.length > 400 ||
    (threadIds?.length ?? 0) > 10_000 ||
    (input.metadata?.length ?? 0) > 10_000
  )
    return yield* failure("invalid_cursor", "Invalid message search scope");
  const sign = (payload: string) => createHmac("sha256", state.key).update(payload).digest();
  const encode = (id: string, offset: number) => {
    const payload = Buffer.from(JSON.stringify({ id, offset })).toString("base64url");
    return `nxsb5.${payload}.${sign(payload).toString("base64url")}`;
  };
  const position =
    input.cursor === undefined
      ? null
      : yield* Effect.try({
          try: () => {
            const [prefix, payload, signature, extra] = input.cursor!.split(".");
            if (prefix !== "nxsb5" || !payload || !signature || extra !== undefined)
              throw new Error("Malformed message search cursor");
            const actual = Buffer.from(signature, "base64url");
            const expected = sign(payload);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
              throw new Error("Message search cursor signature changed");
            return decodePosition(Buffer.from(payload, "base64url").toString("utf8"));
          },
          catch: (cause) => new SessionSearchError({ reason: "invalid_cursor", cause }),
        });
  if (!prepared.words().length)
    return {
      items: [],
      nextCursor: null,
      startCursor: null,
      coverage: "indexed",
      strongWords: [],
      truncated: false,
    } satisfies SessionSearchPage;
  const id = position?.id ?? randomUUID();
  const offset = position?.offset ?? 0;
  let snapshot = state.snapshots.get(id);
  if (position && !snapshot)
    return yield* failure("cursor_stale", "Message search snapshot expired");
  if (snapshot && (snapshot.scope !== scope || offset < 0 || offset > snapshot.threads.length))
    return yield* failure("invalid_cursor", "Message search scope or position changed");
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  if (!snapshot) yield* refreshSessionSearch(threadIds);
  return yield* NodeSqliteClient.readOnly(
    sql.withTransaction(
      Effect.gen(function* () {
        const ranked = snapshot ?? {
          ...(yield* indexedHistory(
            sql,
            prepared,
            threadIds,
            input.metadata ?? [],
            input.strongWords ?? [],
          )),
          scope,
          selected: new Map<string, IndexedHit | null>(),
        };
        state.snapshots.delete(id);
        state.snapshots.set(id, ranked);
        if (state.snapshots.size > 16) state.snapshots.delete(state.snapshots.keys().next().value!);
        const page = ranked.threads.slice(offset, offset + limit);
        const unseen = page.filter(({ thread_id }) => !ranked.selected.has(thread_id));
        const selected = yield* chooseSearchItems(
          sql,
          prepared,
          ranked.plan,
          unseen,
          ranked.strongWords,
        );
        for (const [index, thread] of unseen.entries())
          ranked.selected.set(thread.thread_id, selected[index] ?? null);
        const facts = yield* readFacts(
          sql,
          prepared,
          page.map(({ thread_id }) => ranked.selected.get(thread_id) ?? null),
        );
        const items = facts.flatMap((fact, index) =>
          fact
            ? [
                {
                  ...fact,
                  cursor: encode(id, offset + index + 1),
                },
              ]
            : [],
        );
        const end = offset + page.length;
        return {
          items,
          startCursor: encode(id, 0),
          nextCursor: end < ranked.threads.length ? encode(id, end) : null,
          coverage: "indexed",
          strongWords: ranked.strongWords,
          truncated: ranked.truncated || facts.length !== items.length,
        } satisfies SessionSearchPage;
      }),
    ),
  );
});

export interface SessionSearchReference {
  readonly threadId: string;
  readonly itemId: string;
  readonly messageId: string | null;
  readonly contentVersion: string;
  readonly source?: SessionSearchItemSource | undefined;
  readonly matchedWord?: number | undefined;
  readonly matchRank?: number | undefined;
}
export interface SessionSearchResolveInput {
  readonly query: string;
  readonly references: readonly SessionSearchReference[];
}
export interface SessionSearchResolvePage {
  readonly items: readonly Omit<SessionMessageMatch, "cursor" | "hits">[];
}
/** Resolve coordinates from the canonical history and reject edits to the selected item. */
export const resolveSessionSearch = Effect.fn("SessionSearch.resolve")(function* (
  input: SessionSearchResolveInput,
) {
  const sql = yield* SqlClient.SqlClient;
  using prepared = compileSearchQuery(input.query);
  if (input.references.length > 50)
    return yield* failure("invalid_cursor", "Invalid search reference count");
  if (!prepared.words().length && input.references.length)
    return yield* failure("cursor_stale", "Search query no longer admits these references");
  const items = yield* sql.withTransaction(
    Effect.forEach(input.references, (reference) =>
      Effect.gen(function* () {
        const action = reference.source !== undefined && actionSource(reference.source);
        const { fields, from, messageId, item } = candidateSource(sql, action);
        const [row] = yield* sql<Candidate>`SELECT ${fields} ${from}
          AND source.thread_id=${reference.threadId} AND ${messageId} IS ${reference.messageId}
          AND ${item}=${reference.itemId}`;
        if (!row || versionOf(row, row.body) !== reference.contentVersion)
          return yield* failure("cursor_stale", "Search source changed or is no longer visible");
        const evidence = pointEvidence(row, prepared, reference.matchedWord, reference.matchRank);
        if (!evidence) return yield* failure("cursor_stale", "Search source no longer matches");
        return evidence;
      }),
    ),
  );
  return { items } satisfies SessionSearchResolvePage;
}, NodeSqliteClient.readOnly);
