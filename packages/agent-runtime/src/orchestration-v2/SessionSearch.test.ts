import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readSessionSearch, resolveSessionSearch, SessionSearchError } from "./SessionSearch.ts";
import rebuildSearch from "../persistence/Migrations/082_SessionMessageSearch.ts";

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
      assert.isEmpty(page.items);
      assert.isNotNull(page.nextCursor);
      const next = yield* readSessionSearch({ query: "中文", cursor: page.nextCursor! });
      assert.equal(next.items[0]?.messageId, "old");
      assert.equal(next.nextCursor, null);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("matches all query words, enforces short-word starts and treats quotes literally", () =>
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
      yield* f.message("decomposed", "Cafe\u0301 re\u0301sume\u0301 notes");
      assert.equal(
        (yield* readSessionSearch({ query: "cafe resume" })).items[1]?.messageId,
        "decomposed",
      );
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
      assert.isEmpty(first.items);
      assert.isNotNull(first.nextCursor);
      const second = yield* readSessionSearch({
        query: "fts",
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.equal(second.items[0]?.messageId, "old-hit");
      assert.isNull(second.nextCursor);
      yield* f.message("huge", `${"padding ".repeat(80000)}enableFTS exact suffix`);
      let huge = yield* readSessionSearch({ query: "fts", limit: 1 });
      assert.isEmpty(huge.items);
      assert.isNotNull(huge.nextCursor);
      for (let count = 0; huge.nextCursor !== null; count++) {
        assert.isBelow(count, 5);
        huge = yield* readSessionSearch({ query: "fts", limit: 1, cursor: huge.nextCursor });
      }
      assert.equal(huge.items[0]?.messageId, "huge");
      assert.include(huge.items[0]!.snippet, "enableFTS exact suffix");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "rebuilds the folded index from existing canonical messages and updates it atomically",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("legacy", "Le Café don’t change the file");
      for (const name of ["insert", "update", "delete"])
        yield* f.sql.unsafe(`DROP TRIGGER orchestration_v2_session_search_${name}`);
      yield* f.sql`DROP TABLE orchestration_v2_session_message_search`;
      yield* f.sql`DROP INDEX orchestration_v2_message_item_identity_idx`;
      yield* f.sql`DROP INDEX orchestration_v2_session_search_thread_messages_idx`;
      yield* rebuildSearch;
      assert.equal(
        (yield* readSessionSearch({ query: "cafe don't" })).items[0]?.messageId,
        "legacy",
      );
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"Résumé repaired"}' WHERE message_id='legacy'`;
      assert.equal((yield* readSessionSearch({ query: "cafe" })).items.length, 0);
      assert.equal((yield* readSessionSearch({ query: "resume" })).items[0]?.messageId, "legacy");
      yield* f.sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id='legacy'`;
      assert.equal((yield* readSessionSearch({ query: "resume" })).items.length, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
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

it.effect(
  "revalidates pending canonical content and rejects out-of-snapshot cursor coordinates",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 101; index++) yield* f.message(`hit:${index}`, "edit file");
      const first = yield* readSessionSearch({ query: "edit file" });
      assert.isEmpty(first.items);
      const cursor = JSON.parse(
        Buffer.from(first.nextCursor!.split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const pending = cursor.pending as { row: number; version: string };
      yield* f.sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"text":"edit file changed"}' WHERE rowid=${pending.row}`;
      const stale = yield* readSessionSearch({
        query: "edit file",
        cursor: first.nextCursor!,
      }).pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") {
        assert.instanceOf(stale.failure, SessionSearchError);
        if (stale.failure instanceof SessionSearchError)
          assert.equal(stale.failure.reason, "cursor_stale");
      }
      for (const patch of [
        { thread: -1 },
        { through: -1 },
        { after: 999999 },
        { pending: { row: 999999, version: pending.version } },
      ]) {
        const result = yield* readSessionSearch({
          query: "edit file",
          cursor: `nxsb3.${Buffer.from(JSON.stringify({ ...cursor, ...patch })).toString("base64url")}.${first.nextCursor!.split(".")[2]}`,
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, SessionSearchError);
          if (result.failure instanceof SessionSearchError)
            assert.equal(result.failure.reason, "invalid_cursor");
        }
      }
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
      assert.isEmpty(first.items);
      assert.equal(first.coverage, "scan_window");
      assert.isNotNull(first.nextCursor);
      const next = yield* readSessionSearch({ query: "中文", cursor: first.nextCursor! });
      assert.equal(next.items[0]?.messageId, "old-chinese");
      assert.isNull(next.nextCursor);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "keeps two-character body queries as exact-word bounded scans and ignores single letters",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.message("ai", "An AI assistant");
      for (let index = 0; index < 101; index++)
        yield* f.message(`air:${index}`, "air transport and painting");
      const first = yield* readSessionSearch({ query: "AI" });
      assert.isEmpty(first.items);
      assert.equal(first.coverage, "scan_window");
      const next = yield* readSessionSearch({ query: "AI", cursor: first.nextCursor! });
      assert.equal(next.items[0]?.messageId, "ai");
      assert.isNull(next.nextCursor);
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

it.effect("jumps to rare old indexed hits while common Thread scans retain bounded progress", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("rare-old", "uniqueneedle");
    yield* f.sql`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<1100)
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
    const common = yield* readSessionSearch({ query: "busy" });
    assert.isEmpty(common.items);
    assert.isNotNull(common.nextCursor);
    const next = yield* readSessionSearch({ query: "busy", cursor: common.nextCursor! });
    assert.isEmpty(next.items);
    assert.isNotNull(next.nextCursor);
    assert.notEqual(next.nextCursor, common.nextCursor);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("counts only best-quality messages across signed source continuations", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("whole-user", "edit file", 0, { role: "user" });
    yield* f.message("whole-assistant", "edit file");
    for (let index = 0; index < 205; index++) yield* f.message(`weak:${index}`, "edit filename");
    let page = yield* readSessionSearch({ query: "edit file" });
    assert.isEmpty(page.items);
    while (page.nextCursor !== null)
      page = yield* readSessionSearch({ query: "edit file", cursor: page.nextCursor });
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

it.effect("fences Run insertion/deletion and message-item linkage eligibility changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.message("one", "edit file");
    const before = yield* readSessionSearch({ query: "edit file" });
    yield* f.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES('run:one','thread:one',1,'codex','rolled_back','2026-10-01','{}')`;
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
