// @effect-diagnostics nodeBuiltinImport:off
import { isNativeSearchThreadId } from "../orchestration-v2/NativeSearchHistory.ts";
import { hash } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";
import { searchKernel } from "@nodex/search-kernel/node";
import { searchItemBoundary, searchPairToken, searchTermTag } from "./SessionSearchIndexTokens.ts";
import { searchableMessageText } from "@nodex/runtime-shared/searchableMessageText";
import {
  actionSearchText,
  readSearchSegments,
  searchableMessageItem,
  searchableRun,
  searchableThread,
} from "./SessionSearchSources.ts";

type Sql = SqlClient.SqlClient;
type Lane = 0 | 1;
type StoredSegments = string | Uint8Array;
const sliceSize = 24;
const analysisBudgetMs = 3;

interface Cursor {
  readonly scan: 0 | 1 | 2;
  readonly message_at: string;
  readonly action_ordinal: number;
  readonly source_id: string;
}
interface DirtyThread extends Cursor {
  readonly thread_id: string;
  readonly revision: string;
  readonly eligible: number;
}
interface Key {
  readonly lane: Lane;
  readonly source_id: string;
}
interface Source {
  readonly row_id: number;
  readonly source_id: string;
  readonly user_role: number;
  readonly at: string;
  readonly ordinal: number;
  readonly text: string | null;
  readonly digest: string | null;
  readonly segments: StoredSegments | null;
}
interface IndexedSource extends Key {
  readonly row_id: number;
  readonly user_role: number;
  readonly at: string;
  readonly digest: string;
  readonly segments: StoredSegments;
}
interface Document {
  readonly message: string;
  readonly action: string;
  readonly inventory: string;
  readonly terms: string;
  readonly at: string;
  readonly messageMax: number;
  readonly actionMax: number;
}
export type SearchIndexSlice =
  | {
      readonly thread: DirtyThread;
      readonly kind: "items";
      readonly upserts: readonly IndexedSource[];
      readonly removals: readonly Key[];
      readonly processed: readonly Key[];
      readonly cursor?: Cursor;
    }
  | {
      readonly thread: DirtyThread;
      readonly kind: "document";
      readonly document: Document | null;
    };

export const searchThreadAdmission = (sql: Sql, threadIds?: readonly string[]) =>
  threadIds === undefined
    ? sql`1`
    : sql`thread_id IN (SELECT value FROM json_each(${JSON.stringify(threadIds)}))`;

const sources = (sql: Sql, threadId: string, lane: Lane, filter: Fragment) => {
  if (isNativeSearchThreadId(threadId)) {
    return sql<Source>`WITH source AS (
      SELECT id AS row_id,item_id AS message_id,item_id AS source_id,item_id AS turn_item_id,at AS created_at,at,id AS ordinal,role AS type,role,text
      FROM session_search_native_items WHERE thread_id=${threadId}
        AND ${lane === 0 ? sql`role IN ('user','assistant')` : sql`role IN ('command_execution','file_change')`} AND ${filter}
    ) SELECT source.*,role='user' AS user_role,cache.digest,cache.segments FROM source
      LEFT JOIN session_search_items cache ON cache.thread_id=${threadId} AND cache.lane=${lane} AND cache.source_id=source.source_id
      ORDER BY ${lane === 0 ? sql`at` : sql`ordinal`},source_id`;
  }
  const selection =
    lane === 0
      ? sql`SELECT rowid AS row_id,message_id AS source_id,role,streaming,payload_json,created_at AS at,0 AS ordinal
      FROM orchestration_v2_projection_messages WHERE thread_id=${threadId} AND ${filter}`
      : sql`SELECT rowid AS row_id,turn_item_id AS source_id,type,status,payload_json,updated_at AS at,ordinal,run_id
      FROM orchestration_v2_projection_turn_items WHERE thread_id=${threadId} AND ${filter}`;
  const message = lane === 0;
  const identity = message
    ? sql`LEFT JOIN orchestration_v2_projection_turn_items item ON item.rowid=(
      SELECT candidate.rowid FROM orchestration_v2_projection_turn_items candidate INDEXED BY orchestration_v2_message_item_identity_idx
      WHERE candidate.thread_id=${threadId} AND candidate.type IN ('user_message','assistant_message')
        AND CASE WHEN json_valid(candidate.payload_json) THEN json_extract(candidate.payload_json,'$.messageId') END=source.source_id
      ORDER BY candidate.ordinal DESC,candidate.turn_item_id LIMIT 1)`
    : sql``;
  const text = message
    ? sql`CASE WHEN item.rowid IS NOT NULL AND ${searchableMessageItem(sql)}
      AND source.streaming=0 AND source.role IN ('user','assistant') AND json_valid(source.payload_json)
      THEN CASE WHEN json_extract(source.payload_json,'$.notification') IS NULL
        AND json_type(source.payload_json,'$.text')='text' THEN json_extract(source.payload_json,'$.text') END END`
    : sql`CASE WHEN source.status='completed' THEN ${actionSearchText(sql, "source")} END`;
  const order = message ? sql`source.at` : sql`source.ordinal`;
  return sql<Source>`WITH source AS (${selection})
    SELECT source.row_id,source.source_id,source.at,source.ordinal,${message ? sql`source.role='user'` : sql`0`} AS user_role,
      CASE WHEN ${searchableRun(sql)} THEN ${text} END AS text,cache.digest,cache.segments
    FROM source ${identity}
    LEFT JOIN orchestration_v2_projection_runs run ON run.run_id=${message ? sql`item.run_id` : sql`source.run_id`}
    LEFT JOIN session_search_items cache ON cache.thread_id=${threadId} AND cache.lane=${lane} AND cache.source_id=source.source_id
    ORDER BY ${order},source.source_id`;
};

const readSource = (sql: Sql, threadId: string, key: Key) =>
  sources(
    sql,
    threadId,
    key.lane,
    key.lane === 0 ? sql`message_id=${key.source_id}` : sql`turn_item_id=${key.source_id}`,
  );

const scanSources = (sql: Sql, thread: DirtyThread, lane: Lane) =>
  sources(
    sql,
    thread.thread_id,
    lane,
    lane === 0
      ? sql`(created_at,message_id)>(${thread.message_at},${thread.source_id})
      ORDER BY created_at,message_id LIMIT ${sliceSize}`
      : sql`type IN ('command_execution','file_change') AND (ordinal,turn_item_id)>(${thread.action_ordinal},${thread.source_id})
      ORDER BY ordinal,turn_item_id LIMIT ${sliceSize}`,
  );

// Larger values can allocate a whole overflow page in the WITHOUT ROWID table.
const compression = { params: { [constants.ZSTD_c_compressionLevel]: 1 } };
function storeSegments(segments: string): StoredSegments {
  const bytes = Buffer.byteLength(segments);
  if (bytes < 768) return segments;
  const compressed = zstdCompressSync(segments, compression);
  return compressed.length < bytes ? compressed : segments;
}

function analyze(key: Key, row: Source | undefined): IndexedSource | null {
  if (!row || typeof row.text !== "string") return null;
  const digest = hash("sha256", `${searchKernel().analyzerVersion()}:${row.text}`, "base64url");
  const segments =
    row.digest === digest && row.segments !== null
      ? row.segments
      : storeSegments(
          searchKernel().indexText(key.lane === 0 ? searchableMessageText(row.text) : row.text),
        );
  if (!segments) return null;
  return { ...key, digest, segments, row_id: row.row_id, user_role: row.user_role, at: row.at };
}

interface DocumentItem {
  readonly lane: Lane;
  readonly row_id: number;
  readonly at: string;
  readonly segments: string;
}

function makeDocument(items: readonly DocumentItem[]): Document | null {
  if (!items.length) return null;
  let at = "";
  let messageMax = 0;
  let actionMax = 0;
  const inventory = new Set<string>();
  const terms = new Set<string>();
  const fields: [string[], string[]] = [[], []];
  for (const item of items) {
    fields[item.lane].push(item.segments);
    if (item.lane === 0) messageMax = Math.max(messageMax, item.row_id);
    else actionMax = Math.max(actionMax, item.row_id);
    if (item.at > at) at = item.at;
    const tag = searchTermTag(item.lane === 0 ? "message" : "action");
    let previous = "";
    for (const segment of item.segments.split(" ")) {
      const token = tag + segment;
      if (!inventory.has(token) && segment.length >= 4 && Array.from(segment).length >= 4)
        terms.add(segment);
      inventory.add(token);
      if (segment.length < 4 || segment.length >= 4000) {
        previous = "";
        continue;
      }
      if (previous) inventory.add(searchPairToken(previous, segment));
      previous = segment;
    }
  }
  const boundary = ` ${searchItemBoundary} `;
  return {
    message: fields[0].join(boundary),
    action: fields[1].join(boundary),
    inventory: [...inventory].join(" "),
    terms: JSON.stringify([...terms]),
    at,
    messageMax,
    actionMax,
  };
}

/** Prepare against a read snapshot. WASM and full-chat document assembly run on the worker. */
export const prepareSearchIndexSlice = Effect.fn("SessionSearch.prepareIndex")(function* (
  sql: Sql,
  threadIds?: readonly string[],
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [thread] = yield* sql<DirtyThread>`SELECT dirty.*,EXISTS(
        SELECT 1 FROM orchestration_v2_projection_threads thread
        WHERE thread.thread_id=dirty.thread_id AND ${searchableThread(sql, "thread")}
       ) OR EXISTS(SELECT 1 FROM session_search_native_threads native WHERE native.thread_id=dirty.thread_id)
      AS eligible FROM session_search_dirty dirty WHERE ${searchThreadAdmission(sql, threadIds)}
      ORDER BY scan DESC,thread_id LIMIT 1`;
      if (!thread) return null;
      if (!thread.eligible)
        return { thread, kind: "document", document: null } satisfies SearchIndexSlice;
      const keys = yield* sql<Key>`SELECT lane,source_id FROM session_search_changes
        WHERE thread_id=${thread.thread_id} ORDER BY lane,source_id LIMIT ${sliceSize}`;
      const upserts: IndexedSource[] = [];
      const removals: Key[] = [];
      const processed: Key[] = [];
      const pending = { thread, kind: "items", upserts, removals, processed } as const;
      const add = (key: Key, row: Source | undefined) => {
        const item = analyze(key, row);
        if (item) upserts.push(item);
        else if (!row || row.digest !== null) removals.push(key);
      };
      if (keys.length) {
        const start = performance.now();
        for (const key of keys) {
          const [row] = yield* readSource(sql, thread.thread_id, key);
          add(key, row);
          processed.push(key);
          if (performance.now() - start >= analysisBudgetMs) break;
        }
        return pending;
      }
      if (thread.scan === 2) {
        const items =
          yield* sql<DocumentItem>`SELECT lane,row_id,at,${readSearchSegments(sql, "item")} AS segments FROM session_search_items item
          WHERE thread_id=${thread.thread_id} ORDER BY lane,row_id`;
        return {
          thread,
          kind: "document",
          document: makeDocument(items),
        } satisfies SearchIndexSlice;
      }

      const lane = thread.scan;
      const rows = yield* scanSources(sql, thread, lane);
      const start = performance.now();
      let count = 0;
      for (const row of rows) {
        add({ lane, source_id: row.source_id }, row);
        count++;
        if (performance.now() - start >= analysisBudgetMs) break;
      }
      const last = rows[count - 1];
      const advance = !last || (rows.length < sliceSize && count === rows.length);
      const cursor: Cursor = advance
        ? { scan: lane === 0 ? 1 : 2, message_at: "", action_ordinal: -1, source_id: "" }
        : {
            scan: lane,
            message_at: last.at,
            action_ordinal: last.ordinal,
            source_id: last.source_id,
          };
      return { ...pending, cursor };
    }),
  );
});

const publishItems = Effect.fn("SessionSearch.publishItems")(function* (
  sql: Sql,
  slice: Extract<SearchIndexSlice, { kind: "items" }>,
) {
  const threadId = slice.thread.thread_id;
  if (slice.upserts.length)
    yield* sql`INSERT INTO session_search_items ${sql.insert(slice.upserts.map((item) => ({ thread_id: threadId, ...item })))}
      ON CONFLICT(thread_id,lane,source_id) DO UPDATE SET
        row_id=excluded.row_id,user_role=excluded.user_role,at=excluded.at,digest=excluded.digest,segments=excluded.segments
      WHERE session_search_items.row_id IS NOT excluded.row_id OR session_search_items.user_role IS NOT excluded.user_role
        OR session_search_items.at IS NOT excluded.at OR session_search_items.digest IS NOT excluded.digest`;
  for (const { lane, source_id } of slice.removals)
    yield* sql`DELETE FROM session_search_items WHERE thread_id=${threadId} AND lane=${lane} AND source_id=${source_id}`;
  for (const { lane, source_id } of slice.processed)
    yield* sql`DELETE FROM session_search_changes WHERE thread_id=${threadId} AND lane=${lane} AND source_id=${source_id}`;
  const cursor = slice.cursor ?? slice.thread;
  yield* sql`UPDATE session_search_dirty SET revision=hex(randomblob(16)),scan=${cursor.scan},message_at=${cursor.message_at},
    action_ordinal=${cursor.action_ordinal},source_id=${cursor.source_id} WHERE thread_id=${threadId}`;
});

const publishDocument = Effect.fn("SessionSearch.publishDocument")(function* (
  sql: Sql,
  slice: Extract<SearchIndexSlice, { kind: "document" }>,
) {
  const threadId = slice.thread.thread_id;
  if (!slice.thread.eligible) {
    yield* sql`DELETE FROM session_search_items WHERE thread_id=${threadId}`;
    yield* sql`DELETE FROM session_search_changes WHERE thread_id=${threadId}`;
  }
  const [previous] = yield* sql<{
    readonly id: number;
    readonly terms: string;
  }>`SELECT id,terms FROM session_search_threads WHERE thread_id=${threadId}`;
  if (previous) {
    yield* sql`DELETE FROM session_search_words WHERE rowid=${previous.id}`;
    yield* sql`DELETE FROM session_search_inventory WHERE rowid=${previous.id}`;
  }
  const document = slice.document;
  if (document) {
    const [row] = yield* sql<{
      readonly id: number;
    }>`INSERT INTO session_search_threads(thread_id,terms,at,message_max,action_max,analyzer_version)
      VALUES(${threadId},${document.terms},${document.at},${document.messageMax},${document.actionMax},${searchKernel().analyzerVersion()})
      ON CONFLICT(thread_id) DO UPDATE SET terms=excluded.terms,at=excluded.at,message_max=excluded.message_max,
      action_max=excluded.action_max,analyzer_version=excluded.analyzer_version RETURNING id`;
    yield* sql`INSERT INTO session_search_words(rowid,message,action) VALUES(${row!.id},${document.message},${document.action})`;
    yield* sql`INSERT INTO session_search_inventory(rowid,tokens) VALUES(${row!.id},${document.inventory})`;
  } else if (previous) {
    yield* sql`DELETE FROM session_search_threads WHERE thread_id=${threadId}`;
  }
  // Track distinct terms by chat. The dictionary can expand loose queries without reading postings.
  const oldTerms = previous?.terms ?? "[]";
  const newTerms = document?.terms ?? "[]";
  if (oldTerms !== newTerms) {
    const removed = sql`SELECT value FROM json_each(${oldTerms}) EXCEPT SELECT value FROM json_each(${newTerms})`;
    yield* sql`UPDATE session_search_terms SET chats=chats-1 WHERE term IN (${removed})`;
    yield* sql`DELETE FROM session_search_terms WHERE chats=0 AND term IN (${removed})`;
    yield* sql`INSERT INTO session_search_terms(term,chats) SELECT value,1 FROM (
      SELECT value FROM json_each(${newTerms}) EXCEPT SELECT value FROM json_each(${oldTerms})
    ) WHERE 1 ON CONFLICT(term) DO UPDATE SET chats=chats+1`;
  }
  yield* sql`DELETE FROM session_search_dirty WHERE thread_id=${threadId}`;
});

/** The revision fences concurrent canonical writes, other builders and interrupted batches. */
export const publishSearchIndexSlice = Effect.fn("SessionSearch.publishIndex")(function* (
  sql: Sql,
  slice: SearchIndexSlice,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [current] = yield* sql`SELECT 1 FROM session_search_dirty
        WHERE thread_id=${slice.thread.thread_id} AND revision=${slice.thread.revision}`;
      if (!current) return false;
      yield* slice.kind === "items" ? publishItems(sql, slice) : publishDocument(sql, slice);
      return true;
    }),
  );
});
