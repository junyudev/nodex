import { nativeSearchThreadId, syncNativeSearchHistory } from "./NativeSearchHistory.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readSessionSearch, resolveSessionSearch, SessionSearchError } from "./SessionSearch.ts";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  prepareSearchIndexSlice,
  publishSearchIndexSlice,
} from "../persistence/SessionSearchIndexer.ts";
import { reconcileSessionSearchAnalyzer } from "../persistence/SessionSearchProjection.ts";
import { searchKernel } from "@nodex/search-kernel/node";
import { fieldRank, rankQuality } from "./SessionSearchText.ts";

/** Raw storage fixture exercises index migration/triggers and bounded query execution together. */
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-10-01T00:00:00.000Z";
  const thread = (id: string) =>
    sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: "project:a", title: "Unrelated title", default_provider: "codex", provider_instance_id: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: at, updated_at: at, payload_json: JSON.stringify({ lineage: { parentThreadId: null } }) })}`;
  yield* thread("thread:one");
  const message = (
    id: string,
    text: string,
    streaming = 0,
    options: {
      readonly threadId?: string;
      readonly role?: "user" | "assistant";
      readonly createdAt?: string;
    } = {},
  ) =>
    Effect.gen(function* () {
      const threadId = options.threadId ?? "thread:one";
      const role = options.role ?? "assistant";
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({ message_id: id, thread_id: threadId, role, streaming, created_at: options.createdAt ?? at, updated_at: at, payload_json: JSON.stringify({ text, createdBy: "agent" }) })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({ turn_item_id: `item:${id}`, thread_id: threadId, run_id: "run:one", node_id: null, provider_thread_id: null, provider_turn_id: null, type: `${role}_message`, status: "completed", ordinal: 1, updated_at: at, payload_json: JSON.stringify({ messageId: id }) })}`;
    });
  return { sql, message, thread };
});
it.effect(
  "indexes completed message bodies, supports Unicode, and preserves every bounded hit",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("first", "old anime 二次元 message");
      yield* f.message("second", "new anime 二次元 message");
      yield* f.message("streaming", "unfinished anime", 1);
      // A fork is an independently bound Session even though its lineage has a parent.
      yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"lineage":{"parentThreadId":"ancestor","relationshipToParent":"fork"}}' WHERE thread_id='thread:one'`;
      const first = yield* readSessionSearch({ query: "anime", limit: 1 });
      assert.equal(first.items[0]?.messageId, "second");
      assert.equal(first.items[0]?.source, "assistant");
      assert.equal(first.nextCursor, null);
      assert.equal((yield* readSessionSearch({ query: "二次元" })).items.length, 1);
      assert.equal(
        (yield* readSessionSearch({
          query: "anime",
          cursor: JSON.stringify({ v: 1, query: "other", after: 1, through: 1 }),
        }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET streaming=0 WHERE message_id='streaming'`;
      assert.equal(
        (yield* readSessionSearch({ query: "unfinished" })).items[0]?.messageId,
        "streaming",
      );
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='invalid' WHERE message_id='streaming'`;
      assert.equal((yield* readSessionSearch({ query: "unfinished" })).items.length, 0);
      yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
        VALUES('run:one','thread:one',1,'codex','cancelled','2026-10-01','{}')`;
      yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET type='user_message',payload_json='{"messageId":"first","inputIntent":"queued_turn"}' WHERE turn_item_id='item:first'`;
      assert.deepEqual(
        (yield* readSessionSearch({ query: "anime" })).items.map((item) => item.messageId),
        ["second"],
      );
      yield* f.sql`UPDATE orchestration_v2_projection_runs SET status='rolled_back' WHERE run_id='run:one'`;
      assert.equal((yield* readSessionSearch({ query: "anime" })).items.length, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
it.effect("requeues old analyzer output once and resumes its scan after restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("indexed", "database migration");
    const query = { query: "migration" };
    assert.equal((yield* readSessionSearch(query)).items[0]?.messageId, "indexed");
    yield* f.sql`UPDATE orchestration_v2_projection_metadata SET schema_version=0 WHERE projection_name='session-search-analyzer'`;
    yield* f.sql`UPDATE session_search_threads SET analyzer_version=0`;

    yield* reconcileSessionSearchAnalyzer;
    const [queued] =
      yield* f.sql`SELECT revision FROM session_search_dirty WHERE thread_id='thread:one'`;
    assert.isDefined(queued);
    yield* reconcileSessionSearchAnalyzer;
    const [resumed] =
      yield* f.sql`SELECT revision FROM session_search_dirty WHERE thread_id='thread:one'`;
    assert.deepEqual(resumed, queued);
    assert.equal((yield* readSessionSearch(query)).items[0]?.messageId, "indexed");
    const [indexed] =
      yield* f.sql`SELECT analyzer_version FROM session_search_threads WHERE thread_id='thread:one'`;
    assert.equal(indexed?.analyzer_version, searchKernel().analyzerVersion());
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "advances two-character search through sparse history windows without silently losing old hits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("old", "只有中文命中");
      yield* f.sql`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<1001)
 INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
 SELECT 'padding:'||value,'thread:one','system',0,'2026-10-02','2026-10-02','{}' FROM n`;
      const page = yield* readSessionSearch({ query: "中文" });
      assert.equal(page.items[0]?.messageId, "old");
      assert.equal(page.items[0]?.matchedText, "中文");
      assert.isNull(page.nextCursor);
      assert.isFalse(page.truncated);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("requires all query words, ranks ordered matches, and accepts wrapping quotes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("apart", "The file rendering works after an edit.");
    yield* f.thread("thread:phrase");
    yield* f.message("phrase", "Fix edit file display", 0, { threadId: "thread:phrase" });
    yield* f.message("missing", "Only the editor was changed");
    assert.deepEqual(
      (yield* readSessionSearch({ query: '"edit file"' })).items.map((item) => item.messageId),
      ["phrase", "apart"],
    );
    yield* f.message("hidden", "saved drafts with connection state");
    yield* f.message("word", "EnableFTS and fix CI");
    assert.deepEqual(
      (yield* readSessionSearch({ query: "fts" })).items.map((item) => item.messageId),
      ["word"],
    );
    assert.deepEqual(
      (yield* readSessionSearch({ query: "fix ci" })).items.map((item) => item.messageId),
      ["word"],
    );
    assert.equal((yield* readSessionSearch({ query: "ci" })).items[0]?.messageId, "word");
    assert.equal((yield* readSessionSearch({ query: 'file" OR anything' })).items.length, 0);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "folds accents, case and apostrophes while centering visible-text snippets on the match",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("plain", "The cafe has a resume guide");
      yield* f.thread("thread:accented");
      yield* f.message("accented", "Le CAFÉ has Résumé indexing", 0, {
        threadId: "thread:accented",
      });
      for (const query of ["cafe resume", "café résumé"]) {
        assert.deepEqual(
          (yield* readSessionSearch({ query })).items.map((item) => item.messageId),
          ["accented", "plain"],
        );
      }
      const original = "Cafe\u0301 re\u0301sume\u0301";
      yield* f.message("decomposed", `${original} notes`);
      const decomposed = (yield* readSessionSearch({ query: "cafe resume" })).items[0];
      assert.equal(decomposed?.messageId, "decomposed");
      assert.equal(decomposed?.matchedText, original);
      yield* f.message("apostrophe", "I don’t know why");
      assert.equal(
        (yield* readSessionSearch({ query: "don't know" })).items[0]?.messageId,
        "apostrophe",
      );
      yield* f.message("turkish", "Trip to İstanbul");
      assert.equal(
        (yield* readSessionSearch({ query: "istanbul" })).items[0]?.messageId,
        "turkish",
      );
      const lead = "Ordinary notes. ".repeat(100);
      yield* f.message(
        "snippet",
        `${lead}Fix the **sidebar** with [Edit file](https://secret.example/hiddenneedle). 😀`,
      );
      const snippet = (yield* readSessionSearch({ query: "sidebar edit file" })).items[0]!.snippet;
      assert.isTrue(snippet.startsWith("…"));
      assert.include(snippet, "sidebar");
      assert.include(snippet, "Edit file");
      assert.notInclude(snippet, "**");
      assert.notInclude(snippet, "secret.example");
      assert.isAtMost(snippet.length, 240);
      assert.equal((yield* readSessionSearch({ query: "hiddenneedle" })).items.length, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "continues past rejected index candidates and matches complete oversized message suffixes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("old-hit", "Enable FTS now");
      for (let index = 0; index < 101; index++)
        yield* f.message(`noise:${index}`, "Saved the drafts");
      const first = yield* readSessionSearch({ query: "fts", limit: 1 });
      assert.equal(first.items[0]?.messageId, "old-hit");
      assert.isNull(first.nextCursor);
      yield* f.message("huge", `${"padding ".repeat(80000)}enableFTS exact suffix`);
      const huge = yield* readSessionSearch({ query: "fts", limit: 1 });
      assert.equal(huge.items[0]?.messageId, "huge");
      assert.include(huge.items[0]!.snippet, "enableFTS exact suffix");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "rebuilds the folded index from existing canonical messages and updates it atomically",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 98 });
      const f = yield* fixture;
      yield* f.message("legacy", "Le Café don’t change the file");
      yield* runMigrations();
      const schema = yield* f.sql<{ readonly name: string }>`SELECT name FROM sqlite_schema
        WHERE name GLOB 'orchestration_v2_session_*search*' OR type='trigger' AND name GLOB 'session_search_*'
        ORDER BY name`;
      assert.deepEqual(
        schema.map(({ name }) => name),
        ["item", "message", "native", "run", "thread"].flatMap((source) =>
          ["delete", "insert", "update"].map(
            (operation) => `session_search_${source}_${operation}`,
          ),
        ),
      );
      assert.equal(
        (yield* readSessionSearch({ query: "cafe don't" })).items[0]?.messageId,
        "legacy",
      );
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"Résumé repaired"}' WHERE message_id='legacy'`;
      assert.equal((yield* readSessionSearch({ query: "cafe" })).items.length, 0);
      assert.equal((yield* readSessionSearch({ query: "resume" })).items[0]?.messageId, "legacy");
      yield* f.sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id='legacy'`;
      assert.equal((yield* readSessionSearch({ query: "resume" })).items.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "indexes changed sources and rejects an obsolete slice without touching older evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("older", "Unrelated evergreen evidence");
      yield* readSessionSearch({ query: "evergreen" });
      const cached = () => f.sql`SELECT * FROM session_search_items WHERE source_id='older'`;
      const before = yield* cached();

      yield* f.message("new", "Preliminary checkpoint");
      const proposed = yield* prepareSearchIndexSlice(f.sql);
      if (proposed?.kind !== "items") return assert.fail("Expected one pending source");
      assert.deepEqual(
        proposed.processed.map((change) => change.source_id),
        ["new"],
      );

      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"Verified conclusion"}' WHERE message_id='new'`;
      assert.isFalse(yield* publishSearchIndexSlice(f.sql, proposed));
      assert.equal((yield* readSessionSearch({ query: "conclusion" })).items[0]?.messageId, "new");
      assert.isEmpty((yield* readSessionSearch({ query: "checkpoint" })).items);
      assert.deepEqual(yield* cached(), before);

      yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES('run:one','thread:one',1,'codex','rolled_back','2026-10-01','{}')`;
      assert.equal((yield* prepareSearchIndexSlice(f.sql))?.kind, "items");
      assert.isEmpty((yield* readSessionSearch({ query: "evergreen" })).items);
      assert.isEmpty(yield* cached());
      yield* f.sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='run:one'`;
      assert.equal((yield* readSessionSearch({ query: "evergreen" })).items[0]?.messageId, "older");
      assert.deepEqual(yield* cached(), before);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("omits invisible history from storage and rescans roots when they become visible", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 98 });
    const f = yield* fixture;
    yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"sideChat":{}}' WHERE thread_id='thread:one'`;
    yield* f.message("earlier", "evergreen checkpoint");
    yield* runMigrations();

    const cached = () =>
      f.sql`SELECT source_id FROM session_search_items WHERE thread_id='thread:one'`;
    assert.isNull(yield* prepareSearchIndexSlice(f.sql));
    assert.isEmpty(yield* cached());

    yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json='{}' WHERE thread_id='thread:one'`;
    const admitted = yield* readSessionSearch({ query: "evergreen checkpoint" });
    assert.equal(admitted.items[0]?.itemId, "item:earlier");
    assert.isFalse(admitted.truncated);

    yield* f.sql`UPDATE orchestration_v2_projection_threads
      SET payload_json='{"lineage":{"relationshipToParent":"subagent"}}' WHERE thread_id='thread:one'`;
    yield* f.message("later", "evergreen second checkpoint");
    const hidden = yield* readSessionSearch({ query: "evergreen" });
    assert.isEmpty(hidden.items);
    assert.isFalse(hidden.truncated);
    assert.isEmpty(yield* cached());
    assert.isEmpty(yield* f.sql`SELECT term FROM session_search_terms WHERE term='evergreen'`);

    yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json='{}' WHERE thread_id='thread:one'`;
    const restored = yield* readSessionSearch({ query: "second" });
    assert.equal(restored.items[0]?.itemId, "item:later");
    assert.lengthOf(yield* cached(), 2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("preserves tokenized snapshot pagination across unrelated appends", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (let index = 0; index < 110; index++) {
      const threadId = `thread:${index}`;
      yield* f.thread(threadId);
      yield* f.message(`match:${index}`, "file display after edit", 0, { threadId });
    }
    let page = yield* readSessionSearch({ query: "edit file", limit: 13 });
    const found = page.items.map((item) => item.messageId);
    for (let count = 0; page.nextCursor !== null; count++) {
      assert.isBelow(count, 20);
      page = yield* readSessionSearch({ query: "edit file", limit: 13, cursor: page.nextCursor });
      found.push(...page.items.map((item) => item.messageId));
    }
    assert.deepEqual(
      found,
      Array.from({ length: 110 }, (_value, index) => `match:${109 - index}`),
    );
    const beforeAppend = yield* readSessionSearch({ query: "edit file", limit: 1 });
    yield* f.thread("thread:later");
    yield* f.message("later", "edit file", 0, { threadId: "thread:later" });
    const continued = yield* readSessionSearch({
      query: "edit file",
      cursor: beforeAppend.nextCursor!,
    });
    assert.isFalse(continued.items.some((item) => item.messageId === "later"));
    assert.isNotEmpty(continued.items);
    assert.equal(
      (yield* readSessionSearch({ query: "edit file", limit: 1 })).items[0]?.messageId,
      "later",
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "returns one best hit per Thread across bounded scans and retains older exact matches",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("older-valid", "Enable FTS now");
      for (let index = 0; index < 205; index++)
        yield* f.message(`rejected:${index}`, "Saved drafts");
      yield* f.thread("thread:busy");
      yield* f.message("best-user", "Fix edit file display", 0, {
        threadId: "thread:busy",
        role: "user",
        createdAt: "2025-01-01",
      });
      for (let index = 0; index < 205; index++)
        yield* f.message(`busy:${index}`, "Fix edit file display and enable FTS", 0, {
          threadId: "thread:busy",
        });
      yield* f.thread("thread:other");
      yield* f.message("other", "Fix edit file display and enable FTS", 0, {
        threadId: "thread:other",
      });
      let page = yield* readSessionSearch({ query: "fts", limit: 1 });
      const found = page.items.map((item) => item.threadId);
      for (let count = 0; page.nextCursor !== null; count++) {
        assert.isBelow(count, 10);
        assert.isAtMost(page.nextCursor.length, 350);
        page = yield* readSessionSearch({ query: "fts", limit: 1, cursor: page.nextCursor });
        found.push(...page.items.map((item) => item.threadId));
      }
      assert.deepEqual(found, ["thread:other", "thread:busy", "thread:one"]);
      page = yield* readSessionSearch({ query: "edit file", limit: 1 });
      const best = [...page.items];
      while (page.nextCursor !== null) {
        page = yield* readSessionSearch({ query: "edit file", limit: 1, cursor: page.nextCursor });
        best.push(...page.items);
      }
      assert.deepEqual(
        best.map((item) => item.messageId),
        ["other", "best-user"],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects tampered ranked cursors and rejects stale canonical evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("edit", "edit file");
    const first = yield* readSessionSearch({ query: "edit file" });
    const [prefix, payload, signature] = first.startCursor!.split(".");
    const coordinates = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as object;
    const tampered = Buffer.from(JSON.stringify({ ...coordinates, offset: 42 })).toString(
      "base64url",
    );
    const invalid = yield* readSessionSearch({
      query: "edit file",
      cursor: `${prefix}.${tampered}.${signature}`,
    }).pipe(Effect.flip);
    assert.instanceOf(invalid, SessionSearchError);
    assert.equal((invalid as SessionSearchError).reason, "invalid_cursor");
    yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"edit file changed"}' WHERE message_id='edit'`;
    const stale = yield* resolveSessionSearch({ query: "edit file", references: first.items }).pipe(
      Effect.flip,
    );
    assert.instanceOf(stale, SessionSearchError);
    assert.equal((stale as SessionSearchError).reason, "cursor_stale");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "continues short CJK scans through complete rejected bodies before emitting a Thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("old-chinese", "中文命中");
      for (let index = 0; index < 101; index++)
        yield* f.message(`latin:${index}`, "unrelated completed body");
      const first = yield* readSessionSearch({ query: "中文" });
      assert.equal(first.coverage, "indexed");
      assert.equal(first.items[0]?.messageId, "old-chinese");
      assert.isNull(first.nextCursor);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "ranks two-character exact matches above prefixes and admits single letters as whole words",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("ai", "An AI assistant");
      for (let index = 0; index < 101; index++)
        yield* f.message(`air:${index}`, "air transport and painting");
      const first = yield* readSessionSearch({ query: "AI" });
      assert.equal(first.coverage, "indexed");
      assert.equal(first.items[0]?.messageId, "ai");
      assert.isNull(first.nextCursor);
      assert.isEmpty((yield* readSessionSearch({ query: "a" })).items);
      assert.isEmpty((yield* readSessionSearch({ query: "a b" })).items);
      yield* f.thread("字");
      yield* f.message("scoped", "distinct indexed needle", 0, { threadId: "字" });
      assert.equal((yield* readSessionSearch({ query: "needle" })).items[0]?.messageId, "scoped");
      assert.isEmpty(
        (yield* readSessionSearch({ query: Buffer.from("字").toString("hex") })).items,
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "keeps the same ordered phrase evidence when the pair lookup falls back to positions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("split-left", "checkpoint");
      yield* f.message("split-right", "outputs");
      yield* f.thread("thread:phrase");
      yield* f.message("ordered", "checkpoint outputs", 0, { threadId: "thread:phrase" });
      const query = "check outp";
      const pair = yield* readSessionSearch({ query });
      assert.equal(pair.items[0]?.messageId, "ordered");
      assert.isAbove(pair.items[0]!.quality, pair.items[0]!.wordQuality);
      assert.equal(pair.items[1]?.quality, pair.items[1]?.wordQuality);

      // Unrelated short prefix variants force the positional lookup without changing the hits.
      yield* f.thread("thread:variants");
      const variants = Array.from(
        { length: 50 },
        (_, index) =>
          `checkvariant${String.fromCharCode(97 + (index % 26), 97 + Math.floor(index / 26))}`,
      );
      yield* f.message("variants", variants.join(" "), 0, { threadId: "thread:variants" });
      const positional = yield* readSessionSearch({ query });
      assert.deepEqual(
        positional.items.map(({ messageId, quality }) => ({ messageId, quality })),
        pair.items.map(({ messageId, quality }) => ({ messageId, quality })),
      );
      assert.isFalse(positional.truncated);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("ranks all 5,001 common matches and finds a rare two-character Chinese word", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("rare-old", "uniqueneedle 数据库迁移");
    yield* f.sql`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<5001)
      INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      SELECT 'pressure:'||value,'thread:one','assistant',0,'2026-10-02','2026-10-02','{"text":"busy common word"}' FROM n`;
    yield* f.sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,type,status,ordinal,updated_at,payload_json)
      SELECT 'item:'||message_id,thread_id,'assistant_message','completed',rowid,'2026-10-02',json_object('messageId',message_id)
      FROM orchestration_v2_projection_messages WHERE message_id LIKE 'pressure:%'`;
    for (let index = 0; index < 25; index++) {
      const threadId = `newer:${index}`;
      yield* f.thread(threadId);
      yield* f.message(`newer-message:${index}`, "other indexed text", 0, { threadId });
    }
    const rare = yield* readSessionSearch({ query: "uniqueneedle" });
    assert.equal(rare.items[0]?.messageId, "rare-old");
    assert.isNull(rare.nextCursor);
    const deep = yield* readSessionSearch({ query: "迁移" });
    assert.equal(deep.coverage, "indexed");
    assert.equal(deep.items[0]?.matchedText, "迁移");
    assert.isFalse(deep.truncated);
    const common = yield* readSessionSearch({ query: "busy" });
    assert.equal(common.items[0]?.hits, 5001);
    assert.isFalse(common.truncated);
    assert.isNull(common.nextCursor);
    // The newest records in a large chat must not change a cursor's already chosen evidence.
    yield* f.message("one-more", "busy common word");
    assert.equal(
      (yield* readSessionSearch({ query: "busy", cursor: common.startCursor! })).items[0]
        ?.messageId,
      common.items[0]?.messageId,
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("counts only best-quality messages across candidate batches", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("whole-user", "edit file", 0, { role: "user" });
    yield* f.message("whole-assistant", "edit file");
    for (let index = 0; index < 205; index++) yield* f.message(`weak:${index}`, "edit filename");
    const page = yield* readSessionSearch({ query: "edit file" });
    assert.equal(page.items[0]?.messageId, "whole-user");
    assert.equal(page.items[0]?.hits, 2);
    const resolved = yield* resolveSessionSearch({
      query: "edit file",
      references: page.items,
    });
    assert.equal(resolved.items[0]?.contentVersion, page.items[0]?.contentVersion);
    assert.equal(resolved.items[0]?.snippet, "edit file");
    const missing = yield* resolveSessionSearch({
      query: "edit file",
      references: [{ ...page.items[0]!, itemId: "absent" }],
    }).pipe(Effect.result);
    assert.equal(missing._tag, "Failure");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "fences completed ranking evidence while allowing unrelated streaming and Thread updates",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("one", "edit file");
      const first = yield* readSessionSearch({ query: "edit file" });
      yield* f.message("streaming", "unfinished", 1);
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"unfinished growing"}' WHERE message_id='streaming'`;
      yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.contextWindow',123)`;
      const replay = yield* readSessionSearch({ query: "edit file", cursor: first.startCursor! });
      assert.equal(replay.items[0]?.messageId, "one");
      yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.branch','new')`;
      const stale = yield* resolveSessionSearch({
        query: "edit file",
        references: first.items,
      }).pipe(Effect.result);
      assert.equal(stale._tag, "Success");
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"changed source"}' WHERE message_id='one'`;
      assert.equal(
        (yield* resolveSessionSearch({ query: "edit file", references: first.items }).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("admits only the named execution subtree roots before bounded source work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("admitted", "needle now");
    for (let index = 0; index < 45; index++) {
      const threadId = `foreign:${index}`;
      yield* f.thread(threadId);
      yield* f.message(`foreign-message:${index}`, "needle now", 0, { threadId });
    }
    const page = yield* readSessionSearch({ query: "needle", threadIds: ["thread:one"], limit: 1 });
    assert.deepEqual(
      page.items.map((item) => item.messageId),
      ["admitted"],
    );
    assert.equal(page.nextCursor, null);
    assert.isEmpty((yield* readSessionSearch({ query: "needle", threadIds: [] })).items);
    yield* f.message("two-letter", "CI ready");
    const short = yield* readSessionSearch({ query: "CI", threadIds: ["thread:one"] });
    assert.deepEqual(
      short.items.map((item) => item.messageId),
      ["two-letter"],
    );
    const changedScope = yield* readSessionSearch({
      query: "needle",
      threadIds: ["foreign:1"],
      cursor: page.startCursor!,
    }).pipe(Effect.result);
    assert.equal(changedScope._tag, "Failure");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("fences Run upserts, deletion and message-item linkage eligibility changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("one", "edit file");
    yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES('run:one','thread:one',1,'codex','completed','2026-10-01','{}')`;
    const before = yield* readSessionSearch({ query: "edit file" });
    yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES('run:one','thread:one',1,'codex','rolled_back','2026-10-01','{}')
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status`;
    assert.equal(
      (yield* resolveSessionSearch({
        query: "edit file",
        references: before.items,
      }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.isEmpty((yield* readSessionSearch({ query: "edit file" })).items);
    yield* f.sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id='run:one'`;
    const visible = yield* readSessionSearch({ query: "edit file" });
    assert.equal(visible.items[0]?.messageId, "one");
    yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET status='running' WHERE turn_item_id='item:one'`;
    yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json='{"messageId":"absent"}' WHERE turn_item_id='item:one'`;
    assert.equal(
      (yield* resolveSessionSearch({
        query: "edit file",
        references: visible.items,
      }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.isEmpty((yield* readSessionSearch({ query: "edit file" })).items);
    yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json='{"messageId":"one"}' WHERE turn_item_id='item:one'`;
    assert.equal((yield* readSessionSearch({ query: "edit file" })).items[0]?.messageId, "one");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("ranks older whole words before truncating the first result page", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("older", "marigold", 0, { createdAt: "2025-01-01" });
    for (let index = 0; index < 21; index++) {
      const threadId = `newer:${index}`;
      yield* f.thread(threadId);
      yield* f.message(threadId, "semimarigold", 0, { threadId });
    }
    const page = yield* readSessionSearch({ query: "marigold", limit: 5 });
    assert.equal(page.items[0]?.messageId, "older");
    assert.equal(page.items[0]?.wordQuality, rankQuality(fieldRank("exact", "message")));
    assert.isNotNull(page.nextCursor);
    assert.isFalse(page.truncated);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "combines message and metadata evidence within one Thread and ranks the weakest word",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("first", "Semaphoric");
      yield* f.message("second", "Conclusion");
      yield* f.thread("title");
      yield* f.message("body", "Conclusion", 0, { threadId: "title" });
      yield* f.thread("weak");
      yield* f.message("weak", "Semaphoric preconclusion", 0, { threadId: "weak" });
      yield* f.thread("phrase");
      yield* f.message("phrase", "Semaphoric conclusion", 0, { threadId: "phrase" });
      const query = "semaphoric and conclusion";
      const page = yield* readSessionSearch({
        query,
        metadata: [{ threadId: "title", withoutTypos: [0, null], withTypos: [0, null] }],
      });
      assert.deepEqual(
        page.items.map((item) => item.threadId),
        ["phrase", "title", "thread:one", "weak"],
      );
      const [title] = (yield* resolveSessionSearch({ query, references: [page.items[1]!] })).items;
      assert.equal(page.items[2]?.quality, page.items[2]?.wordQuality);
      assert.equal(title?.itemId, "item:body");
      assert.equal(title?.matchedText, "Conclusion");
      assert.isEmpty((yield* readSessionSearch({ query: "absent conclusion" })).items);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "backfills and maintains searchable commands and paths with lower weight than messages",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 98 });
      const f = yield* fixture;
      const at = "2026-10-01";
      for (const [id, type, payload] of [
        [
          "command",
          "command_execution",
          {
            input: `vp run bluestem ${"padding ".repeat(1000)}oversizedsuffix`,
            output: "stdoutsecret",
          },
        ],
        [
          "change",
          "file_change",
          {
            fileName: "2 files",
            changes: [
              { path: "src/diffonly.ts", oldPath: "src/formerly.ts", diff: "diffsecret" },
              { path: "src/second.ts" },
            ],
          },
        ],
        ["other", "dynamic_tool", { input: "toolsecret" }],
      ] as const)
        yield* f.sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, type, status, ordinal, updated_at, payload_json)
        VALUES(${id}, 'thread:one', ${type}, 'completed', 1, ${at}, ${JSON.stringify(payload)})`;
      yield* runMigrations();

      const command = (yield* readSessionSearch({ query: "vp run bluestem" })).items[0]!;
      assert.equal(command.source, "command_execution");
      assert.equal(command.itemId, "command");
      assert.equal(command.matchedText, "vp run bluestem");
      const resolved = yield* resolveSessionSearch({
        query: "vp run bluestem",
        references: [command],
      });
      assert.equal(resolved.items[0]?.itemId, "command");
      for (const query of ["src/diffonly.ts", "src/second.ts", "src/formerly.ts"])
        assert.equal((yield* readSessionSearch({ query })).items[0]?.source, "file_change");
      for (const query of ["stdoutsecret", "toolsecret", "diffsecret", "oversizedsuffix"])
        assert.isEmpty((yield* readSessionSearch({ query })).items);
      yield* f.thread("transcript");
      yield* f.message("transcript", "bluestem", 0, { threadId: "transcript" });
      assert.deepEqual(
        (yield* readSessionSearch({ query: "bluestem" })).items.map((item) => item.source),
        ["assistant", "command_execution"],
      );
      yield* f.sql`UPDATE orchestration_v2_projection_turn_items
      SET payload_json='{"input":"vp run azure"}' WHERE turn_item_id='command'`;
      assert.isEmpty((yield* readSessionSearch({ query: "vp run bluestem" })).items);
      assert.equal((yield* readSessionSearch({ query: "azure" })).items[0]?.itemId, "command");
      yield* f.sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id='change'`;
      assert.isEmpty((yield* readSessionSearch({ query: "src/diffonly.ts" })).items);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "reveals an ordered command phrase when separate messages supply the strongest words",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("first", "evergreen");
      yield* f.message("second", "checkpoint");
      yield* f.sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id,thread_id,type,status,ordinal,updated_at,payload_json)
      VALUES('command','thread:one','command_execution','completed',2,'2026-10-01','{"input":"echo evergreen checkpoint"}')`;
      const query = "evergreen checkpoint";
      const page = yield* readSessionSearch({ query });
      assert.isFalse(page.truncated);
      assert.equal(page.items[0]?.itemId, "command");
      const resolved = yield* resolveSessionSearch({ query, references: page.items });
      assert.equal(resolved.items[0]?.matchedText, query);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("finds full-width text, punctuation and camelCase through the word index", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("width", "The ＵＮＩＱＵＥＷＩＤＴＨ marker");
    assert.equal(
      (yield* readSessionSearch({ query: "uniquewidth" })).items[0]?.matchedText,
      "ＵＮＩＱＵＥＷＩＤＴＨ",
    );
    yield* f.thread("camel");
    yield* f.message("camel", "PageSearchKernel notes", 0, { threadId: "camel" });
    yield* f.message("path", "library/page_search.rs");
    const split = yield* readSessionSearch({ query: "page_search" });
    assert.deepEqual(
      split.items.map((item) => item.matchedText),
      ["page_search", "PageSearch"],
    );
    assert.equal((yield* readSessionSearch({ query: "kernel" })).items[0]?.messageId, "camel");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("tries typos only when the word has no strong evidence in the admitted corpus", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("mistyped", "Database Migration");
    yield* f.thread("outside");
    yield* f.message("exact", "migartion", 0, { threadId: "outside" });
    const query = "database migartion";
    const admitted = yield* readSessionSearch({ query, threadIds: ["thread:one"] });
    assert.equal(admitted.items[0]?.matchedText, "Migration");
    assert.equal(admitted.items[0]?.wordQuality, rankQuality(fieldRank("typo", "message")));
    assert.isEmpty((yield* readSessionSearch({ query })).items);
    assert.isEmpty(
      (yield* readSessionSearch({ query, threadIds: ["thread:one"], strongWords: [false, true] }))
        .items,
    );
    assert.equal((yield* readSessionSearch({ query: "migrate" })).items[0]?.messageId, "mistyped");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "indexes native history with shared word ranks, coordinates, incremental updates and analyzer rebuilds",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const threadId = nativeSearchThreadId("remote", "native-thread");
      const sync = syncNativeSearchHistory;
      yield* sync({ kind: "admit", threadId, revision: "one" });
      assert.isTrue((yield* readSessionSearch({ query: "中文", threadIds: [threadId] })).truncated);
      yield* sync({
        kind: "page",
        threadId,
        revision: "one",
        cursor: "anchor",
        complete: true,
        items: [
          {
            itemId: "early",
            runId: "turn-one",
            role: "user",
            text: "database 中文 evergreen",
            at: "2026-01-01",
          },
          {
            itemId: "late",
            runId: "turn-two",
            role: "assistant",
            text: "migration",
            at: "2026-01-02",
          },
        ],
      });
      for (const query of ["中文", "databsae", "ergreen", "migration database"]) {
        const page = yield* readSessionSearch({ query, threadIds: [threadId] });
        assert.equal(page.items[0]?.threadId, threadId);
        assert.isFalse(page.truncated);
        assert.include(["early", "late"], page.items[0]?.itemId);
      }
      const missing = nativeSearchThreadId("offline", "not-admitted-yet");
      const partial = yield* readSessionSearch({ query: "中文", threadIds: [missing, threadId] });
      assert.isTrue(partial.truncated);
      assert.equal(partial.items[0]?.itemId, "early");
      assert.isFalse(
        (yield* readSessionSearch({ query: "中文", threadIds: [threadId] })).truncated,
      );
      yield* sync({
        kind: "page",
        threadId,
        revision: "one",
        cursor: "anchor",
        complete: true,
        items: [
          {
            itemId: "command",
            runId: "turn-one",
            role: "command_execution",
            text: "deploy evergreen",
            at: "2026-01-01",
          },
        ],
      });
      assert.equal(
        (yield* readSessionSearch({ query: "deploy" })).items[0]?.source,
        "command_execution",
      );
      assert.equal(
        (yield* readSessionSearch({ query: "evergreen", limit: 1 })).items[0]?.itemId,
        "early",
      );
      assert.equal(
        (yield* readSessionSearch({
          query: "titleword 中文",
          threadIds: [threadId],
          metadata: [{ threadId, withoutTypos: [0, null], withTypos: [0, null] }],
        })).items[0]?.itemId,
        "early",
      );
      const selected = (yield* readSessionSearch({ query: "中文", threadIds: [threadId] }))
        .items[0]!;
      assert.equal(selected.runId, "turn-one");
      assert.equal(selected.matchedText, "中文");
      assert.equal(
        (yield* resolveSessionSearch({ query: "中文", references: [selected] })).items[0]?.itemId,
        "early",
      );
      yield* sync({ kind: "admit", threadId, revision: "two" });
      assert.deepEqual(yield* sync({ kind: "admit", threadId, revision: "two" }), {
        cursor: "anchor",
        complete: false,
      });
      yield* sync({
        kind: "page",
        threadId,
        revision: "two",
        cursor: "next",
        complete: true,
        items: [
          { itemId: "new", runId: "turn-three", role: "user", text: "rarefind", at: "2026-01-03" },
        ],
      });
      assert.equal((yield* readSessionSearch({ query: "rarefind" })).items[0]?.itemId, "new");
      assert.equal((yield* readSessionSearch({ query: "中文" })).items[0]?.itemId, "early");
      yield* f.sql`UPDATE orchestration_v2_projection_metadata SET schema_version=0 WHERE projection_name='session-search-analyzer'`;
      yield* reconcileSessionSearchAnalyzer;
      assert.equal((yield* readSessionSearch({ query: "中文" })).items[0]?.itemId, "early");
      yield* sync({ kind: "reset", threadId });
      assert.isEmpty((yield* readSessionSearch({ query: "中文" })).items);
      yield* sync({ kind: "prune", threadIds: [] });
      assert.isEmpty(yield* f.sql`SELECT 1 FROM session_search_native_threads`);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("orders the picker window by hit frequency before hydrating the first page", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.thread("thread:two");
    yield* f.message("recent", "checkpoint", 0, { createdAt: "2026-10-02" });
    yield* f.message("older1", "checkpoint", 0, {
      threadId: "thread:two",
      createdAt: "2026-10-01",
    });
    yield* f.message("older2", "checkpoint", 0, {
      threadId: "thread:two",
      createdAt: "2026-10-01",
    });
    const input = {
      query: "checkpoint",
      limit: 1,
      picker: {
        now: 0,
        subjects: ["thread:one", "thread:two"].map((threadId) => ({
          threadId,
          sessionId: threadId,
          activityAt: 0,
          opens: null,
        })),
      },
    };
    const first = yield* readSessionSearch(input);
    assert.equal(first.items[0]?.threadId, "thread:two");
    assert.equal(first.items[0]?.hits, 2);
    assert.isTrue("pickerOrdered" in first && first.pickerOrdered);
    assert.isNotNull(first.nextCursor);
    const second = yield* readSessionSearch({ ...input, cursor: first.nextCursor! });
    assert.equal(second.items[0]?.threadId, "thread:one");
    assert.isNull(second.nextCursor);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
