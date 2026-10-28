import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { prepareMessageSearch } from "./SessionSearchText.ts";

export interface SessionSearchInput {
  readonly query: string;
  /** Core-admitted root executions; an empty set admits no message work. */
  readonly threadIds?: readonly string[] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}
export interface SessionMessageMatch {
  readonly threadId: string;
  readonly itemId: string;
  readonly messageId: string;
  readonly runId: string | null;
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly messageAt: string;
  readonly cursor: string;
  readonly quality: number;
  readonly hits: number;
  readonly contentVersion: string;
}
export interface SessionSearchPage {
  readonly items: readonly SessionMessageMatch[];
  readonly nextCursor: string | null;
  readonly coverage: "indexed" | "scan_window";
  readonly startCursor: string | null;
}
const Pending = Schema.Struct({ row: Schema.Int, version: Schema.String, hits: Schema.Int });
const cursorKeys = new WeakMap<SqlClient.SqlClient, Uint8Array>();
const Cursor = Schema.Struct({
  v: Schema.Literal(4),
  scope: Schema.String,
  through: Schema.Int,
  threadsThrough: Schema.Int,
  thread: Schema.Int,
  after: Schema.Int,
  pending: Schema.NullOr(Pending),
});
type Position = typeof Cursor.Type;
const decodePosition = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const encodePosition = Schema.encodeSync(Schema.fromJsonString(Cursor));
export class SessionSearchError extends Schema.TaggedError<SessionSearchError>()(
  "SessionSearchError",
  {
    reason: Schema.Literals(["invalid_cursor", "cursor_stale"]),
    cause: Schema.Defect(),
  },
) {}
const failure = (reason: SessionSearchError["reason"], message: string) =>
  new SessionSearchError({ reason, cause: new Error(message) });
const CANDIDATE_LIMIT = 100;
const CANDIDATE_BYTES = 512 * 1024;
const RAW_MESSAGE_LIMIT = 1000;
const THREAD_LIMIT = 20;
interface Candidate {
  readonly row_id: number;
  readonly thread_row_id: number;
  readonly thread_id: string;
  readonly item_id: string;
  readonly message_id: string;
  readonly run_id: string | null;
  readonly role: "user" | "assistant";
  readonly created_at: string;
  readonly payload_bytes: number;
}
interface Hit {
  readonly row: Candidate;
  readonly quality: number;
  readonly snippet: string;
  readonly version: string;
}
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
const better = (left: Hit, right: Hit) =>
  left.quality > right.quality ||
  (left.quality === right.quality &&
    (Number(left.row.role === "user") > Number(right.row.role === "user") ||
      (left.row.role === right.row.role && left.row.created_at > right.row.created_at)));

const candidateFrom = (
  sql: SqlClient.SqlClient,
  indexedQuery: string | null,
  threadId: string,
) => sql`FROM ${
  indexedQuery !== null
    ? sql`orchestration_v2_session_message_search search CROSS JOIN orchestration_v2_projection_messages message ON message.rowid=search.rowid`
    : sql`orchestration_v2_projection_messages message INDEXED BY orchestration_v2_session_search_thread_messages_idx`
}

JOIN orchestration_v2_projection_threads thread ON thread.thread_id=message.thread_id
JOIN orchestration_v2_projection_turn_items item ON item.thread_id=message.thread_id AND item.turn_item_id=(
  SELECT candidate.turn_item_id FROM orchestration_v2_projection_turn_items candidate
  WHERE candidate.thread_id=message.thread_id AND candidate.type IN ('user_message','assistant_message')
    AND CASE WHEN json_valid(candidate.payload_json) THEN json_extract(candidate.payload_json,'$.messageId') END=message.message_id
  ORDER BY candidate.ordinal DESC,candidate.turn_item_id LIMIT 1)
LEFT JOIN orchestration_v2_projection_runs run ON run.run_id=item.run_id
WHERE ${
  indexedQuery !== null
    ? sql`orchestration_v2_session_message_search MATCH ${`text : (${indexedQuery}) AND thread_scope : "x${Buffer.from(threadId).toString("hex")}x"`}`
    : sql`message.streaming=0 AND message.role IN ('user','assistant')
    AND CASE WHEN json_valid(message.payload_json) THEN json_extract(message.payload_json,'$.notification') IS NULL
    AND json_extract(message.payload_json,'$.text') IS NOT NULL ELSE 0 END`
}
  AND thread.deleted_at IS NULL AND json_extract(thread.payload_json, '$.sideChat') IS NULL AND COALESCE(json_extract(thread.payload_json,'$.lineage.relationshipToParent'),'') <> 'subagent'
  AND (run.status IS NULL OR run.status <> 'rolled_back')
  AND NOT (item.type='user_message' AND run.status IS 'cancelled'
    AND json_extract(item.payload_json,'$.inputIntent')='queued_turn')`;
const candidateColumns = (
  sql: SqlClient.SqlClient,
) => sql`message.rowid AS row_id,thread.rowid AS thread_row_id,message.thread_id,
item.turn_item_id AS item_id,message.message_id,item.run_id,message.role,message.created_at,
length(CAST(message.payload_json AS BLOB)) AS payload_bytes`;

/** Candidates form a stable Thread/message stream. Only a completed Thread emits its best
 * exact hit; a long Thread carries one versioned source reference across bounded scan pages. */
export const readSessionSearch = Effect.fn("SessionSearch.read")(function* (
  input: SessionSearchInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const query = input.query.trim();
  const key = cursorKeys.get(sql) ?? randomBytes(32);
  cursorKeys.set(sql, key);
  const encode = (value: Position) => {
    const payload = Buffer.from(encodePosition(value)).toString("base64url");
    return `nxsb4.${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  };
  const decode = (value: string) =>
    Effect.try({
      try: () => {
        const [prefix, payload, signature, ...rest] = value.split(".");
        if (prefix !== "nxsb4" || !payload || !signature || rest.length)
          throw new Error("Malformed search cursor");
        const actual = Buffer.from(signature, "base64url");
        const expected = createHmac("sha256", key).update(payload).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new Error("Search cursor signature changed");
        return Buffer.from(payload, "base64url").toString("utf8");
      },
      catch: (cause) => new SessionSearchError({ reason: "invalid_cursor", cause }),
    }).pipe(Effect.flatMap(decodePosition));
  const threadIds = input.threadIds === undefined ? null : [...new Set(input.threadIds)].sort();
  if (threadIds !== null && threadIds.length > 100)
    return yield* failure("invalid_cursor", "Too many admitted execution identities");
  const scope = createHash("sha256")
    .update(JSON.stringify([query, threadIds]))
    .digest("base64url");
  const cursor =
    input.cursor === undefined
      ? null
      : yield* decode(input.cursor).pipe(
          Effect.mapError((cause) => new SessionSearchError({ reason: "invalid_cursor", cause })),
        );
  if (query.length === 0 || (cursor !== null && cursor.scope !== scope))
    return yield* failure("invalid_cursor", "Message search scope changed");
  if (
    cursor !== null &&
    (![
      cursor.through,
      cursor.threadsThrough,
      cursor.thread,
      cursor.after,
      cursor.pending?.row ?? 0,
    ].every(Number.isSafeInteger) ||
      cursor.through < 0 ||
      cursor.threadsThrough < 0 ||
      cursor.thread < 1 ||
      cursor.thread > cursor.threadsThrough + 1 ||
      cursor.after < 0 ||
      cursor.after > cursor.through + 1 ||
      (cursor.thread === cursor.threadsThrough + 1 &&
        (cursor.after !== cursor.through + 1 || cursor.pending !== null)) ||
      (cursor.pending !== null &&
        (cursor.after === 0 ||
          cursor.pending.row < cursor.after ||
          cursor.pending.row < 1 ||
          cursor.pending.row > cursor.through ||
          cursor.pending.version.length !== 43 ||
          cursor.pending.hits < 1 ||
          !Number.isSafeInteger(cursor.pending.hits))))
  )
    return yield* failure(
      "invalid_cursor",
      "Message search coordinates are outside their snapshot",
    );
  const prepared = prepareMessageSearch(query);
  if (prepared === null)
    return {
      items: [],
      nextCursor: null,
      startCursor: null,
      coverage: "indexed",
    } satisfies SessionSearchPage;
  const indexed = prepared.indexedQuery !== null;
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const bounds =
        cursor ??
        (yield* sql<{ readonly through: number; readonly threadsThrough: number }>`
      SELECT (SELECT COALESCE(MAX(rowid),0) FROM orchestration_v2_projection_messages) AS through,
        (SELECT COALESCE(MAX(rowid),0) FROM orchestration_v2_projection_threads) AS threadsThrough`)[0]!;
      let position: Position = cursor ?? {
        v: 4,
        scope,
        through: bounds.through,
        threadsThrough: bounds.threadsThrough,
        thread: bounds.threadsThrough + 1,
        after: bounds.through + 1,
        pending: null,
      };
      const startCursor = encode({
        v: 4,
        scope,
        through: bounds.through,
        threadsThrough: bounds.threadsThrough,
        thread: bounds.threadsThrough + 1,
        after: bounds.through + 1,
        pending: null,
      });
      const textQuery = `text : (${prepared.indexedQuery})`;
      const candidatesFrom = (
        threadId: string,
      ) => sql`${candidateFrom(sql, prepared.indexedQuery, threadId)}
        AND message.rowid <= ${position.through} AND thread.rowid <= ${position.threadsThrough}`;
      const admitted =
        threadIds === null
          ? sql`1=1`
          : sql`thread.thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))`;
      const columns = candidateColumns(sql);
      const hydrate = (rows: readonly Candidate[]) =>
        Effect.gen(function* () {
          if (rows.length === 0) return new Map<number, string>();
          const texts = yield* sql<{ readonly row_id: number; readonly text: string }>`
        SELECT rowid AS row_id,json_extract(payload_json,'$.text') AS text
        FROM orchestration_v2_projection_messages
        WHERE rowid IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.row_id))}))`;
          return new Map(texts.map((row) => [row.row_id, row.text]));
        });
      const hit = (row: Candidate, textById: ReadonlyMap<number, string>): Hit | null => {
        const body = textById.get(row.row_id);
        if (typeof body !== "string") return null;
        const match = prepared.match(body);
        return match === null ? null : { row, ...match, version: versionOf(row, body) };
      };
      const currentThread =
        position.thread <= position.threadsThrough && position.after > 0
          ? (yield* sql<{
              readonly row_id: number;
              readonly thread_id: string;
            }>`SELECT rowid AS row_id,thread_id
          FROM orchestration_v2_projection_threads WHERE rowid=${position.thread}`)[0]
          : undefined;
      const pendingRows =
        position.pending === null || currentThread === undefined
          ? []
          : yield* sql<Candidate>`SELECT ${columns} ${candidatesFrom(currentThread.thread_id)}
      AND thread.rowid=${position.thread} AND message.rowid=${position.pending.row}`;
      let hits = position.pending?.hits ?? 0;
      let best =
        pendingRows[0] === undefined ? null : hit(pendingRows[0], yield* hydrate(pendingRows));
      if (position.pending !== null && (best === null || best.version !== position.pending.version))
        return yield* failure("cursor_stale", "Pending message changed or is no longer visible");
      // A partial indexed Thread already has a stable owner anchor and needs no global regroup.
      // Only selecting a new window groups indexed identities in SQLite; message bodies stay out.
      const partialIndexed =
        indexed && position.thread <= position.threadsThrough && position.after > 0;
      const threads = partialIndexed
        ? currentThread === undefined
          ? []
          : [currentThread]
        : indexed
          ? yield* sql<{ readonly row_id: number; readonly thread_id: string }>`
        SELECT thread.rowid AS row_id,thread.thread_id FROM orchestration_v2_session_message_search search
        JOIN orchestration_v2_projection_messages message ON message.rowid=search.rowid
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id=message.thread_id
        WHERE orchestration_v2_session_message_search MATCH ${textQuery}
          AND message.rowid <= ${position.through} AND thread.rowid <= ${position.threadsThrough}
          AND thread.rowid < ${position.thread} AND thread.deleted_at IS NULL AND json_extract(thread.payload_json, '$.sideChat') IS NULL
          AND ${admitted}
          AND COALESCE(json_extract(thread.payload_json,'$.lineage.relationshipToParent'),'') <> 'subagent'
        GROUP BY thread.rowid ORDER BY thread.rowid DESC LIMIT ${THREAD_LIMIT + 1}`
          : yield* sql<{ readonly row_id: number; readonly thread_id: string }>`
        SELECT thread.rowid AS row_id,thread_id FROM orchestration_v2_projection_threads thread
        WHERE thread.rowid <= ${position.threadsThrough}
          AND (thread.rowid < ${position.thread} OR (thread.rowid=${position.thread} AND ${position.after} > 0))
          AND ${admitted}
          AND deleted_at IS NULL AND json_extract(payload_json, '$.sideChat') IS NULL AND COALESCE(json_extract(payload_json,'$.lineage.relationshipToParent'),'') <> 'subagent'
        ORDER BY rowid DESC LIMIT ${THREAD_LIMIT + 1}`;
      const items: SessionMessageMatch[] = [];
      const finish = () => {
        position = { ...position, after: 0, pending: null };
        if (best === null) return;
        const row = best.row;
        items.push({
          threadId: row.thread_id,
          itemId: row.item_id,
          messageId: row.message_id,
          runId: row.run_id,
          source: row.role,
          snippet: best.snippet,
          messageAt: row.created_at,
          quality: best.quality,
          hits,
          contentVersion: best.version,
          cursor: encode(position),
        });
        best = null;
        hits = 0;
      };
      const page = (more: boolean): SessionSearchPage => ({
        items,
        startCursor,
        coverage: indexed ? "indexed" : "scan_window",
        nextCursor: more
          ? encode({
              ...position,
              pending: best === null ? null : { row: best.row.row_id, version: best.version, hits },
            })
          : null,
      });
      let remainingRows = RAW_MESSAGE_LIMIT;
      let remainingCandidates = CANDIDATE_LIMIT;
      let bodyBytes = 0;
      for (const [index, thread] of threads.slice(0, THREAD_LIMIT).entries()) {
        if (thread.row_id !== position.thread)
          position = {
            ...position,
            thread: thread.row_id,
            after: position.through + 1,
            pending: null,
          };
        const raw = indexed
          ? null
          : yield* sql<{ readonly row_id: number }>`SELECT rowid AS row_id
        FROM orchestration_v2_projection_messages INDEXED BY orchestration_v2_session_search_thread_messages_idx
        WHERE thread_id=${thread.thread_id} AND rowid < ${position.after} AND rowid <= ${position.through}
        ORDER BY rowid DESC LIMIT ${remainingRows + 1}`;
        if (raw !== null && raw.length === 0) {
          finish();
          if (items.length === limit) return page(threads[index + 1] !== undefined);
          continue;
        }
        const window = raw?.slice(0, remainingRows);
        const floor = window === undefined ? 1 : window[window.length - 1]!.row_id;
        const candidates =
          yield* sql<Candidate>`SELECT ${columns} ${candidatesFrom(thread.thread_id)}
        AND message.thread_id=${thread.thread_id} AND message.rowid < ${position.after} AND message.rowid >= ${floor}
        ORDER BY ${indexed ? sql`search.rowid` : sql`message.rowid`} DESC LIMIT ${remainingCandidates + 1}`;
        const selected: Candidate[] = [];
        for (const row of candidates.slice(0, remainingCandidates)) {
          if (
            remainingCandidates < CANDIDATE_LIMIT &&
            bodyBytes + row.payload_bytes > CANDIDATE_BYTES
          )
            break;
          if (selected.length > 0 && bodyBytes + row.payload_bytes > CANDIDATE_BYTES) break;
          selected.push(row);
          bodyBytes += row.payload_bytes;
        }
        // The pending best is hydrated separately. Row-prefix admission never truncates text;
        // one oversized candidate may still match a suffix and does not starve the next scan.
        const texts = yield* hydrate(selected);
        for (const row of selected) {
          position = { ...position, after: row.row_id };
          const candidate = hit(row, texts);
          if (candidate === null) continue;
          if (best === null || candidate.quality > best.quality) hits = 1;
          else if (candidate.quality === best.quality) hits++;
          if (best === null || better(candidate, best)) best = candidate;
        }
        remainingCandidates -= selected.length;
        if (selected.length < candidates.length) return page(true);
        remainingRows -= window?.length ?? 0;
        position = { ...position, after: floor };
        if (raw !== null && raw.length > window!.length) return page(true);
        finish();
        const more = (partialIndexed && thread.row_id > 1) || threads[index + 1] !== undefined;
        if (
          items.length === limit ||
          remainingRows === 0 ||
          remainingCandidates === 0 ||
          bodyBytes >= CANDIDATE_BYTES
        )
          return page(more);
      }
      if (partialIndexed && threads.length === 0)
        position = { ...position, after: 0, pending: null };
      return page(partialIndexed ? position.thread > 1 : threads.length > THREAD_LIMIT);
    }),
  );
}, NodeSqliteClient.readOnly);

export interface SessionSearchReference {
  readonly threadId: string;
  readonly itemId: string;
  readonly messageId: string;
  readonly contentVersion: string;
}
export interface SessionSearchResolveInput {
  readonly query: string;
  readonly references: readonly SessionSearchReference[];
}
export interface SessionSearchResolvePage {
  readonly items: readonly Omit<SessionMessageMatch, "cursor" | "hits">[];
}
/** Winners are regenerated from canonical point reads. Query resources retain identities and
 * rank keys only; stale sources never turn cached snippets into authoritative search results. */
export const resolveSessionSearch = Effect.fn("SessionSearch.resolve")(function* (
  input: SessionSearchResolveInput,
) {
  const sql = yield* SqlClient.SqlClient;
  if (input.references.length > 50)
    return yield* failure("invalid_cursor", "Invalid search reference count");
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const prepared = prepareMessageSearch(input.query);
      if (input.references.length > 0 && prepared === null)
        return yield* failure("cursor_stale", "Search query no longer admits these references");
      const items = yield* Effect.forEach(input.references, (reference) =>
        Effect.gen(function* () {
          const rows =
            yield* sql<Candidate>`SELECT ${candidateColumns(sql)} ${candidateFrom(sql, prepared!.indexedQuery, reference.threadId)}
        AND message.thread_id=${reference.threadId} AND message.message_id=${reference.messageId}
        AND item.turn_item_id=${reference.itemId}`;
          const row = rows[0];
          if (row === undefined)
            return yield* failure("cursor_stale", "Search source is no longer visible");
          const bodies = yield* sql<{
            readonly text: string;
          }>`SELECT json_extract(payload_json,'$.text') AS text
        FROM orchestration_v2_projection_messages WHERE rowid=${row.row_id}`;
          const text = bodies[0]?.text;
          const matched = typeof text === "string" ? prepared!.match(text) : null;
          if (matched === null || versionOf(row, text!) !== reference.contentVersion)
            return yield* failure("cursor_stale", "Search source changed during ranking");
          return {
            threadId: row.thread_id,
            itemId: row.item_id,
            messageId: row.message_id,
            runId: row.run_id,
            source: row.role,
            snippet: matched.snippet,
            messageAt: row.created_at,
            quality: matched.quality,
            contentVersion: reference.contentVersion,
          };
        }),
      );
      return { items } satisfies SessionSearchResolvePage;
    }),
  );
}, NodeSqliteClient.readOnly);
