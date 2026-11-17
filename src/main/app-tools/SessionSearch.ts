import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { compileSearchQuery } from "@nodex/search-kernel/node";
import type { ChatHistoryMatch } from "../../shared/chat-search";
import { STRONG_RANK_LIMIT } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import { createHash, randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  sessionSearchSubject,
  sessionMetadataEvidence,
} from "@nodex/agent-runtime/orchestration/SessionSearchRanking";
import {
  rankSessionBody,
  sessionBodyUsage,
} from "@nodex/agent-runtime/orchestration/SessionBodyRanking";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { makeTemporarySqlite } from "../platform/node/TemporarySqlite";
import { AgentRuntimeApplicationError } from "../agent-runtime/AgentRuntimeApplication";
import {
  summaryOf,
  withSessionMetadata,
  SessionDiscoveryError,
  type SessionListingSummary,
} from "./SessionDiscovery";

type Operations = AgentRuntimeOperations;
type Metadata = Operations["sessions.metadata"]["output"][number];
type RuntimeFact = Operations["sessions.search"]["output"]["items"][number];
export interface SessionSearchInput {
  readonly query: string;
  readonly archived: boolean;
  readonly scope?: "project" | "profile";
  readonly projectId?: string;
  readonly projectlessOnly?: boolean;
  readonly cursor?: string;
  readonly limit: number;
}
export interface SessionSearchMatch extends Partial<ChatHistoryMatch> {
  readonly session: SessionListingSummary;
  readonly source:
    | "title"
    | "branch"
    | "pull_request"
    | "project"
    | "user"
    | "assistant"
    | "message"
    | "reference"
    | "command_execution"
    | "file_change";
  readonly snippet?: string;
  readonly messageAt?: string;
  readonly quality?: number;
  readonly hits?: number;
}
export interface SessionSearchResult {
  readonly matches: readonly SessionSearchMatch[];
  readonly nextCursor: string | null;
  readonly sources: readonly {
    readonly source: string;
    readonly availability: "available" | "unavailable";
    readonly reason?: string;
  }[];
  readonly coverage: "complete" | "partial";
  readonly state: "preparing" | "ready";
  readonly entryCursors: readonly string[];
}
interface Dependencies {
  readonly core: CoreModules["Service"];
  readonly sessionSearch: (
    input: Operations["sessions.search"]["input"],
  ) => Effect.Effect<
    Operations["sessions.search"]["output"] & { readonly runtimeId: string | null },
    unknown
  >;
  readonly sessionSearchResolve: (
    input: Operations["sessions.search-resolve"]["input"],
  ) => Effect.Effect<
    Operations["sessions.search-resolve"]["output"] & { readonly runtimeId: string | null },
    unknown
  >;
  readonly sessionMetadata: (
    input: Operations["sessions.metadata"]["input"] & { readonly runtimeId: string },
  ) => Effect.Effect<readonly Metadata[], unknown>;
}
const Position = z.strictObject({
  v: z.literal(4),
  query: z.string().uuid(),
  scope: z.string(),
  after: z.number().int().nonnegative(),
});
type Position = z.infer<typeof Position>;
const encode = (position: Position) =>
  `nxs4.${Buffer.from(JSON.stringify(position)).toString("base64url")}`;
const fail = (reason: SessionDiscoveryError["reason"], cause: unknown) =>
  new SessionDiscoveryError({ reason, cause });
const cursorFailure = (cause: unknown): SessionDiscoveryError | null => {
  if (Schema.is(SessionDiscoveryError)(cause))
    return cause.reason === "cursor_stale" || cause.reason === "invalid_cursor" ? cause : null;
  if (Schema.is(AgentRuntimeApplicationError)(cause) && cause.cursorReason)
    return fail(cause.cursorReason, cause);
  return null;
};
const decode = (cursor: string) =>
  Effect.try({
    try: () => {
      if (!cursor.startsWith("nxs4.")) throw new Error("Invalid search cursor");
      return Position.parse(JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8")));
    },
    catch: (cause) => fail("invalid_cursor", cause),
  });
type Body = {
  readonly kind: "runtime";
  readonly fact: Omit<RuntimeFact, "snippet" | "matchedText" | "cursor">;
  readonly runtimeId: string;
};
interface Row {
  readonly id: string;
  readonly summary: string;
  readonly metadata_rank: string | null;
  readonly published: number;
  readonly body: string | null;
}
interface Work {
  readonly id: number;
  readonly kind: "runtime" | "metadata";
  readonly source: string;
  readonly input: string;
  readonly cursor: string | null;
}
const bodyFact = (body: Body) => body.fact;
const itemIdOf = (body: Body) => body.fact.itemId;
/** One Scope owns one query's private source positions and compact disk-backed rank index.
 * Output positions are immutable, so envelope admission and retries never repeat source scans. */
export const makeSessionSearch = (dependencies: Dependencies) =>
  Effect.gen(function* () {
    const queries = yield* RcMap.make({
      capacity: 32,
      idleTimeToLive: "5 minutes",
      lookup: (_key: string) =>
        Effect.gen(function* () {
          const db = yield* makeTemporarySqlite;
          yield* db.execute(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY,summary TEXT NOT NULL,index_runtime TEXT,index_thread TEXT,metadata_words TEXT,metadata_rank TEXT,body TEXT,word INTEGER,word_quality REAL,quality REAL,score REAL,authored TEXT,published INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute(
            "CREATE INDEX body_rank ON sessions(published,word DESC,word_quality DESC,quality DESC,score DESC,authored DESC,id) WHERE body IS NOT NULL",
          );
          yield* db.execute(
            "CREATE INDEX execution_binding ON sessions(index_runtime,index_thread)",
          );
          yield* db.execute(
            "CREATE TABLE work(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,input TEXT NOT NULL,cursor TEXT,done INTEGER NOT NULL DEFAULT 0,error TEXT,strong_words TEXT,truncated INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute(
            "CREATE TABLE output(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL)",
          );
          yield* db.execute(
            "CREATE TABLE sources(source TEXT PRIMARY KEY,attempt INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute("CREATE INDEX work_schedule ON work(source,done,attempt,id)");
          const lane = yield* Semaphore.make(1);
          return {
            db,
            lane,
            now: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
            initialized: false,
            scope: "",
            coreCursor: null as string | null,
            coreDone: false,
            coreError: null as string | null,
            attempts: 0,
          };
        }),
    });
    return Effect.fn("SessionSearch.search")(function* (input: SessionSearchInput) {
      const provenance = yield* CoreApplicationAgent;
      const scope = createHash("sha256")
        .update(
          JSON.stringify([
            provenance?.profile_id ?? null,
            provenance?.authority?.store_epoch ?? null,
            input.query,
            input.archived,
            input.projectId ?? null,
            input.projectlessOnly ?? false,
          ]),
        )
        .digest("hex");
      const position =
        input.cursor === undefined
          ? { v: 4 as const, query: randomUUID(), scope, after: 0 }
          : yield* decode(input.cursor);
      if (position.scope !== scope) return yield* fail("invalid_cursor", "Search scope changed");
      if (input.cursor !== undefined && !(yield* RcMap.has(queries, position.query)))
        return yield* fail("cursor_stale", "Search query expired; start a fresh search");
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const query = yield* RcMap.get(queries, position.query).pipe(
            Effect.mapError((cause) => fail("source_limit", cause)),
          );
          return yield* query.lane.withPermit(
            Effect.gen(function* () {
              const { db } = query;
              using compiled = compileSearchQuery(input.query);
              const words = compiled.words();
              if (query.initialized && query.scope !== scope)
                return yield* fail("invalid_cursor", "Search query scope changed");
              query.initialized = true;
              query.scope = scope;
              const placement = (ids?: readonly string[], after?: string | null) =>
                dependencies.core.workspace
                  .read(
                    {
                      kind: "session_window",
                      order: "identity",
                      archived: input.archived,
                      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
                      ...(input.projectlessOnly ? { projectless_only: true } : {}),
                      ...(ids === undefined ? {} : { session_ids: ids }),
                      window: { first: 100, ...(after ? { after } : {}) },
                    },
                    { deadlineMs: 10_000 },
                  )
                  .pipe(
                    Effect.flatMap((response) =>
                      response.value.kind === "session_window"
                        ? Effect.succeed(response.value.sessions)
                        : Effect.fail(new Error("Session placement unavailable")),
                    ),
                  );
              const metadataFor = (session: SessionListingSummary) =>
                sessionMetadataEvidence(sessionSearchSubject(session), compiled, input.query);
              const writeSummary = (session: SessionListingSummary) => {
                const { withoutTypos } = metadataFor(session);
                return db.execute(
                  "INSERT INTO sessions(id,summary,metadata_words,index_runtime,index_thread) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,metadata_words=excluded.metadata_words,index_runtime=excluded.index_runtime,index_thread=excluded.index_thread",
                  [
                    session.sessionId,
                    JSON.stringify(session),
                    JSON.stringify(withoutTypos),
                    session.binding?.kind === "native"
                      ? "native"
                      : (session.binding?.runtimeId ?? null),
                    session.binding?.kind === "native"
                      ? nativeSearchThreadId(session.binding.hostId, session.binding.threadId)
                      : (session.binding?.threadId ?? null),
                  ],
                );
              };
              const corpusWords = Effect.gen(function* () {
                const strong = yield* db.rows<{ word: number }>(
                  `SELECT DISTINCT key AS word FROM sessions CROSS JOIN json_each(metadata_words) WHERE value<?
                   UNION SELECT key FROM work CROSS JOIN json_each(strong_words) WHERE value`,
                  [STRONG_RANK_LIMIT],
                );
                const matched = new Set(strong.map(({ word }) => word));
                return words.map((_, index) => matched.has(index));
              });
              // A later batch can discover strong evidence that disables an earlier typo.
              // Re-rank only affected batches before their first results are published.
              const repairRuntime = Effect.gen(function* () {
                const strong = yield* corpusWords;
                const settled = yield* db.rows<{ id: number; input: string; strong_words: string }>(
                  "SELECT id,input,strong_words FROM work WHERE kind='runtime' AND done=1 AND strong_words IS NOT NULL",
                );
                const repair = settled.filter(({ strong_words }) => {
                  const known = JSON.parse(strong_words) as boolean[];
                  return strong.some((found, index) => {
                    const word = words[index]!;
                    return (
                      found &&
                      !known[index] &&
                      word.segments.length === 1 &&
                      Array.from(word.segments[0]!).length >= 4 &&
                      /\p{L}/u.test(word.segments[0]!)
                    );
                  });
                });
                if (!repair.length) return false;
                yield* db.transaction(
                  Effect.gen(function* () {
                    for (const work of repair) {
                      const { runtimeId, threadIds } = JSON.parse(work.input) as {
                        runtimeId: string;
                        threadIds: string[];
                      };
                      yield* db.execute(
                        `UPDATE sessions SET body=NULL,word=NULL,word_quality=NULL,quality=NULL,score=NULL,authored=NULL
                        WHERE published=0 AND json_extract(body,'$.kind')='runtime'
                          AND index_runtime=? AND index_thread IN (SELECT value FROM json_each(?))`,
                        [runtimeId, JSON.stringify(threadIds)],
                      );
                      // Keep the observed strong words until this batch has successfully rerun.
                      yield* db.execute(
                        "UPDATE work SET done=0,cursor=NULL,input=?,truncated=0 WHERE id=?",
                        [JSON.stringify({ runtimeId, threadIds }), work.id],
                      );
                    }
                  }),
                );
                return true;
              });
              const addWork = (kind: Work["kind"], source: string, data: unknown) =>
                db
                  .execute("INSERT INTO sources(source) VALUES(?) ON CONFLICT DO NOTHING", [source])
                  .pipe(
                    Effect.andThen(
                      db.execute("INSERT INTO work(kind,source,input) VALUES(?,?,?)", [
                        kind,
                        source,
                        JSON.stringify(data),
                      ]),
                    ),
                  );
              const refreshBodyRank = (session: SessionListingSummary) =>
                Effect.gen(function* () {
                  const row = (yield* db.rows<Row>("SELECT * FROM sessions WHERE id=?", [
                    session.sessionId,
                  ]))[0];
                  if (!row?.body) return;
                  const rank = rankSessionBody(
                    bodyFact(JSON.parse(row.body) as Body),
                    sessionBodyUsage(session),
                    input.query,
                    query.now,
                  );
                  yield* db.execute(
                    "UPDATE sessions SET word=?,word_quality=?,quality=?,score=?,authored=? WHERE id=?",
                    [
                      Number(rank.word),
                      rank.wordQuality,
                      rank.quality,
                      rank.score,
                      rank.authoredAt,
                      session.sessionId,
                    ],
                  );
                });
              const updateMetadata = (runtimeId: string, threadIds: readonly string[]) =>
                Effect.gen(function* () {
                  const details = yield* dependencies.sessionMetadata({ runtimeId, threadIds });
                  for (const metadata of details) {
                    const rows = yield* db.rows<Row>(
                      "SELECT * FROM sessions WHERE index_runtime=? AND index_thread=?",
                      [runtimeId, metadata.threadId],
                    );
                    for (const row of rows) {
                      const session = withSessionMetadata(
                        JSON.parse(row.summary) as SessionListingSummary,
                        metadata,
                      );
                      yield* writeSummary(session);
                      yield* refreshBodyRank(session);
                    }
                  }
                });
              const storeBody = (session: SessionListingSummary, body: Body) =>
                Effect.gen(function* () {
                  const old = (yield* db.rows<Row>("SELECT * FROM sessions WHERE id=?", [
                    session.sessionId,
                  ]))[0];
                  if (!old || old.published) return;
                  const existing = old.body === null ? null : (JSON.parse(old.body) as Body);
                  let selected = body;
                  if (existing) {
                    const left = bodyFact(existing),
                      right = bodyFact(body);
                    const leftStrength = left.wordQuality;
                    const rightStrength = right.wordQuality;
                    const compare = leftStrength - rightStrength || left.quality - right.quality;
                    const hits = (compare >= 0 ? left.hits : 0) + (compare <= 0 ? right.hits : 0);
                    const preferExisting =
                      compare > 0 ||
                      (compare === 0 &&
                        (Number(left.source === "user") > Number(right.source === "user") ||
                          (left.source === right.source && left.messageAt >= right.messageAt)));
                    selected = preferExisting ? existing : body;
                    selected = { ...selected, fact: { ...selected.fact, hits } } as Body;
                  }
                  const rank = rankSessionBody(
                    bodyFact(selected),
                    sessionBodyUsage(session),
                    input.query,
                    query.now,
                  );
                  yield* db.execute(
                    "UPDATE sessions SET body=?,word=?,word_quality=?,quality=?,score=?,authored=? WHERE id=?",
                    [
                      JSON.stringify(selected),
                      Number(rank.word),
                      rank.wordQuality,
                      rank.quality,
                      rank.score,
                      rank.authoredAt,
                      session.sessionId,
                    ],
                  );
                });
              const runWork = (work: Work) =>
                Effect.gen(function* () {
                  if (work.kind === "metadata") {
                    const target = JSON.parse(work.input) as {
                      runtimeId: string;
                      threadIds: string[];
                    };
                    yield* updateMetadata(target.runtimeId, target.threadIds);
                    return null;
                  }
                  const target = JSON.parse(work.input) as {
                    runtimeId: string;
                    threadIds: string[];
                    metadata?: Operations["sessions.search"]["input"]["metadata"];
                    strongWords?: readonly boolean[];
                  };
                  const strongWords = target.strongWords ?? (yield* corpusWords);
                  const metadata =
                    target.metadata ??
                    (!words.length
                      ? []
                      : (yield* db.rows<Row>(
                          "SELECT * FROM sessions WHERE index_runtime=? AND index_thread IN (SELECT value FROM json_each(?)) ORDER BY id",
                          [target.runtimeId, JSON.stringify(target.threadIds)],
                        )).flatMap((row) => {
                          const session = JSON.parse(row.summary) as SessionListingSummary;
                          if (!session.binding) return [];
                          const { withoutTypos, withTypos } = metadataFor(session);
                          return withTypos.some((rank) => rank !== null)
                            ? [
                                {
                                  threadId:
                                    session.binding.kind === "native"
                                      ? nativeSearchThreadId(
                                          session.binding.hostId,
                                          session.binding.threadId,
                                        )
                                      : session.binding.threadId,
                                  withoutTypos,
                                  withTypos,
                                },
                              ]
                            : [];
                        }));
                  if (target.metadata === undefined)
                    yield* db.execute("UPDATE work SET input=? WHERE id=?", [
                      JSON.stringify({ ...target, metadata, strongWords }),
                      work.id,
                    ]);
                  const page = yield* dependencies.sessionSearch({
                    query: input.query,
                    threadIds: target.threadIds,
                    strongWords,
                    ...(metadata.length ? { metadata } : {}),
                    limit: 100,
                    ...(work.cursor === null ? {} : { cursor: work.cursor }),
                  });
                  if (
                    page.runtimeId === null ||
                    (target.runtimeId !== "native" && page.runtimeId !== target.runtimeId)
                  )
                    return yield* Effect.fail(new Error("The bound Runtime source is unavailable"));
                  if (page.nextCursor !== null && page.nextCursor === work.cursor)
                    return yield* Effect.fail(new Error("Runtime search did not advance"));
                  for (const {
                    snippet: _snippet,
                    matchedText: _matchedText,
                    cursor: _cursor,
                    ...fact
                  } of page.items) {
                    if (!target.threadIds.includes(fact.threadId)) continue;
                    const rows = yield* db.rows<Row>(
                      "SELECT * FROM sessions WHERE index_runtime=? AND index_thread=?",
                      [target.runtimeId, fact.threadId],
                    );
                    for (const row of rows)
                      yield* storeBody(JSON.parse(row.summary) as SessionListingSummary, {
                        kind: "runtime",
                        fact,
                        runtimeId: page.runtimeId,
                      });
                  }
                  const observed = strongWords.map(
                    (known, index) => known || page.strongWords[index] === true,
                  );
                  yield* db.execute(
                    "UPDATE work SET strong_words=?,truncated=MAX(truncated,?) WHERE id=?",
                    [JSON.stringify(observed), Number(page.truncated), work.id],
                  );
                  return page.nextCursor;
                });
              const admitCorePage = (page: Effect.Success<ReturnType<typeof placement>>) =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    const next = page.next_cursor ?? null;
                    if (next !== null && next === query.coreCursor)
                      return yield* fail("cursor_stale", "Session placement did not advance");
                    yield* db.transaction(
                      Effect.gen(function* () {
                        const runtimes = new Map<string, string[]>();
                        for (const row of page.items) {
                          const session = summaryOf(row);
                          // Placement can move while enumeration progresses; each identity is admitted once.
                          if (
                            (yield* db.rows<{ id: string }>("SELECT id FROM sessions WHERE id=?", [
                              session.sessionId,
                            ])).length
                          )
                            continue;
                          yield* writeSummary(session);
                          if (session.binding?.kind === "runtime") {
                            const threads = runtimes.get(session.binding.runtimeId) ?? [];
                            threads.push(session.binding.threadId);
                            runtimes.set(session.binding.runtimeId, threads);
                          }
                          if (session.binding?.kind === "native") {
                            const threads = runtimes.get("native") ?? [];
                            threads.push(
                              nativeSearchThreadId(
                                session.binding.hostId,
                                session.binding.threadId,
                              ),
                            );
                            runtimes.set("native", threads);
                          }
                        }
                        for (const [runtimeId, threadIds] of runtimes) {
                          yield* addWork("runtime", "runtime:messages", { runtimeId, threadIds });
                          if (runtimeId !== "native")
                            yield* addWork("metadata", "runtime:metadata", {
                              runtimeId,
                              threadIds,
                            });
                        }
                      }),
                    );
                    query.coreError = null;
                    query.coreCursor = next;
                    query.coreDone = next === null;
                  }),
                );
              const unavailable = new Set<string>();
              // Give metadata the first turn when both Runtime sources have new work.
              // A metadata failure still leaves Core-owned fields and message search usable.
              const began = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              // Work quanta are internal. Normal queries finish in one call; exceptionally large sources
              // expose preparing explicitly rather than masquerading as an empty completed page.
              for (let quantum = 0; quantum < 2048; quantum++) {
                let advanced = false;
                if (!query.coreDone && !unavailable.has("core")) {
                  const page = yield* placement(undefined, query.coreCursor).pipe(Effect.result);
                  if (page._tag === "Failure") {
                    query.coreError = "Session placement is unavailable";
                    unavailable.add("core");
                  } else {
                    yield* admitCorePage(page.success);
                    advanced = true;
                  }
                }
                const blocked = JSON.stringify([...unavailable]);
                const source = (yield* db.rows<{ source: string }>(
                  "SELECT source FROM sources WHERE source NOT IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM work WHERE work.source=sources.source AND work.done=0) ORDER BY attempt,source='runtime:messages',source LIMIT 1",
                  [blocked],
                ))[0];
                const work = source
                  ? (yield* db.rows<Work>(
                      "SELECT * FROM work WHERE source=? AND done=0 ORDER BY attempt,id LIMIT 1",
                      [source.source],
                    ))[0]
                  : undefined;
                if (work) {
                  query.attempts++;
                  yield* db.execute("UPDATE sources SET attempt=? WHERE source=?", [
                    query.attempts,
                    work.source,
                  ]);
                  const result = yield* db
                    .transaction(
                      runWork(work).pipe(
                        Effect.flatMap((cursor) =>
                          db.execute(
                            "UPDATE work SET cursor=?,done=?,error=NULL,attempt=? WHERE id=?",
                            [cursor, Number(cursor === null), query.attempts, work.id],
                          ),
                        ),
                      ),
                    )
                    .pipe(Effect.result);
                  if (result._tag === "Failure") {
                    const stale = cursorFailure(result.failure);
                    if (stale) return yield* stale;
                    unavailable.add(work.source);
                    yield* db.execute("UPDATE work SET error=?,attempt=? WHERE id=?", [
                      "Search source is unavailable; retry this continuation",
                      query.attempts,
                      work.id,
                    ]);
                  } else {
                    advanced = true;
                  }
                }
                if (!advanced && !work && query.coreDone && !unavailable.has("runtime:messages"))
                  advanced = yield* repairRuntime;
                const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
                if ((!advanced && !work) || now - began >= 20_000) break;
              }
              const pending = (yield* db.rows<{ count: number }>(
                "SELECT COUNT(*) AS count FROM work WHERE done=0 AND source NOT IN (SELECT value FROM json_each(?))",
                [JSON.stringify([...unavailable])],
              ))[0]!.count;
              const preparing = (!query.coreDone && !unavailable.has("core")) || pending > 0;
              const reports = yield* db.rows<{ source: string; failures: number }>(
                "SELECT source,SUM(CASE WHEN error IS NULL THEN 0 ELSE 1 END) AS failures FROM work GROUP BY source",
              );
              const sources: SessionSearchResult["sources"][number][] = [
                {
                  source: "core",
                  availability: query.coreError ? "unavailable" : "available",
                  ...(query.coreError ? { reason: query.coreError } : {}),
                },
                ...reports.map((row) => ({
                  source: row.source,
                  availability: row.failures ? ("unavailable" as const) : ("available" as const),
                  ...(row.failures
                    ? { reason: "Search source is unavailable; continuation is retryable" }
                    : {}),
                })),
              ];
              const truncated =
                (yield* db.rows<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM work WHERE truncated=1",
                ))[0]!.count > 0;
              const partial =
                truncated || sources.some((source) => source.availability === "unavailable");
              const last = (yield* db.rows<{ seq: number }>(
                "SELECT COALESCE(MAX(seq),0) AS seq FROM output",
              ))[0]!.seq;
              if (position.after > last)
                return yield* fail(
                  "invalid_cursor",
                  "Search output position is outside this query",
                );
              if (!preparing && position.after === last) {
                const strongWords = yield* corpusWords;
                yield* db.transaction(
                  Effect.gen(function* () {
                    const candidates = yield* db.rows<Row>(
                      "SELECT * FROM sessions WHERE published=0",
                    );
                    for (const row of candidates) {
                      const rank = metadataFor(
                        JSON.parse(row.summary) as SessionListingSummary,
                      ).render(strongWords, query.now);
                      yield* db.execute("UPDATE sessions SET metadata_rank=? WHERE id=?", [
                        rank ? JSON.stringify({ ...rank, strongWords }) : null,
                        row.id,
                      ]);
                    }
                    const chosen = yield* db.rows<{ id: string; kind: "metadata" | "body" }>(
                      `WITH candidates AS (
                      SELECT id,'metadata' AS kind,json_extract(metadata_rank,'$.wordQuality') AS strength,
                        json_extract(metadata_rank,'$.quality') AS quality,json_extract(metadata_rank,'$.score') AS score,'' AS authored
                      FROM sessions WHERE published=0 AND metadata_rank IS NOT NULL
                      UNION ALL
                      SELECT id,'body',word_quality,quality,score,authored FROM sessions
                      WHERE published=0 AND body IS NOT NULL
                    ), ranked AS (
                      SELECT *,ROW_NUMBER() OVER (PARTITION BY id ORDER BY strength DESC,quality DESC,score DESC,authored DESC,kind DESC) AS selected
                      FROM candidates
                    )
                    SELECT id,kind FROM ranked WHERE selected=1 ORDER BY strength DESC,quality DESC,score DESC,authored DESC,id LIMIT ?`,
                      [input.limit],
                    );
                    for (const [index, { id, kind }] of chosen.entries()) {
                      yield* db.execute("INSERT INTO output(seq,id,kind) VALUES(?,?,?)", [
                        last + index + 1,
                        id,
                        kind,
                      ]);
                      yield* db.execute("UPDATE sessions SET published=1 WHERE id=?", [id]);
                    }
                  }),
                );
              }
              const emitted = yield* db.rows<Row & { seq: number; kind: string }>(
                "SELECT sessions.*,output.seq,output.kind FROM output JOIN sessions ON sessions.id=output.id WHERE output.seq>? ORDER BY output.seq LIMIT ?",
                [position.after, input.limit],
              );
              const matches: SessionSearchMatch[] = [],
                entryCursors: string[] = [];
              let after = position.after;
              const bound = emitted.length ? yield* placement(emitted.map((row) => row.id)) : null;
              const byId = new Map(bound?.items.map((row) => [row.task.session.id, row]) ?? []);
              for (const row of emitted) {
                const snapshot = JSON.parse(row.summary) as SessionListingSummary;
                const current = byId.get(row.id);
                if (
                  !current ||
                  JSON.stringify(summaryOf(current).binding) !== JSON.stringify(snapshot.binding)
                )
                  return yield* fail(
                    "cursor_stale",
                    "Selected Session binding or placement changed",
                  );
                const placement = summaryOf(current);
                let session = {
                  ...snapshot,
                  title: placement.title,
                  projectId: placement.projectId,
                  projectName: placement.projectName,
                  placement: placement.placement,
                  pinned: placement.pinned,
                  archived: placement.archived,
                  opens: placement.opens,
                };
                let match: SessionSearchMatch;
                if (row.kind !== "body") {
                  const rank = JSON.parse(row.metadata_rank!) as {
                    source: SessionSearchMatch["source"];
                    strongWords: boolean[];
                  };
                  const coreMatch = metadataFor(placement).render(rank.strongWords, query.now);
                  if (coreMatch?.source !== rank.source && session.binding?.kind === "runtime") {
                    const details = yield* dependencies
                      .sessionMetadata({
                        runtimeId: session.binding.runtimeId,
                        threadIds: [session.binding.threadId],
                      })
                      .pipe(Effect.result);
                    if (details._tag === "Failure") {
                      sources.push({
                        source: "runtime:metadata",
                        availability: "unavailable",
                        reason: "Selected metadata is unavailable; retry this continuation",
                      });
                      break;
                    }
                    const metadata = details.success.find(
                      (item) => item.threadId === session.binding!.threadId,
                    );
                    if (!metadata)
                      return yield* fail(
                        "cursor_stale",
                        "Selected execution metadata is no longer visible",
                      );
                    session = withSessionMetadata(session, metadata);
                  }
                  const currentMatch = metadataFor(session).render(rank.strongWords, query.now);
                  if (currentMatch?.source !== rank.source)
                    return yield* fail("cursor_stale", "Selected matching metadata changed");
                  match = { session, source: rank.source };
                } else {
                  const body = JSON.parse(row.body!) as Body;
                  const resolving: Effect.Effect<
                    {
                      readonly source: RuntimeFact["source"];
                      readonly snippet: string;
                      readonly matchedText: string;
                      readonly messageAt: string;
                    },
                    unknown
                  > = dependencies
                    .sessionSearchResolve({
                      query: input.query,
                      references: [
                        {
                          threadId: body.fact.threadId,
                          itemId: body.fact.itemId,
                          messageId: body.fact.messageId,
                          contentVersion: body.fact.contentVersion,
                          source: body.fact.source,
                          ...(body.fact.matchRank === undefined
                            ? {}
                            : { matchRank: body.fact.matchRank }),
                          ...(body.fact.matchedWord === undefined
                            ? {}
                            : { matchedWord: body.fact.matchedWord }),
                        },
                      ],
                    })
                    .pipe(
                      Effect.flatMap((page) => {
                        const fact = page.items[0];
                        return page.runtimeId === body.runtimeId &&
                          fact &&
                          fact.contentVersion === body.fact.contentVersion
                          ? Effect.succeed(fact)
                          : Effect.fail(
                              fail("cursor_stale", "Search message no longer matches its source"),
                            );
                      }),
                    );
                  const resolved = yield* resolving.pipe(Effect.result);
                  if (resolved._tag === "Failure") {
                    const stale = cursorFailure(resolved.failure);
                    if (stale) return yield* stale;
                    sources.push({
                      source: "runtime",
                      availability: "unavailable",
                      reason: "Selected message is unavailable; retry this continuation",
                    });
                    break;
                  }
                  const fact = resolved.success;
                  match = {
                    session: { ...session, preview: fact.snippet },
                    source: fact.source,
                    snippet: fact.snippet,
                    sessionId: session.sessionId,
                    matchedText: fact.matchedText,
                    itemId: itemIdOf(body),
                    sourceThreadId: session.binding?.threadId ?? body.fact.threadId,
                    runId: body.fact.runId,
                    messageAt: fact.messageAt,
                    quality: body.fact.quality,
                    hits: body.fact.hits,
                  };
                }
                matches.push(match);
                after = row.seq;
                entryCursors.push(encode({ ...position, after }));
              }
              const remaining = (yield* db.rows<{ count: number }>(
                `SELECT (SELECT COUNT(*) FROM sessions WHERE published=0 AND (metadata_rank IS NOT NULL OR body IS NOT NULL))+(SELECT COUNT(*) FROM output WHERE seq>?) AS count`,
                [after],
              ))[0]!.count;
              const unfinished =
                !query.coreDone ||
                (yield* db.rows<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM work WHERE done=0",
                ))[0]!.count > 0;
              return {
                matches,
                entryCursors,
                nextCursor: remaining || unfinished ? encode({ ...position, after }) : null,
                sources,
                coverage:
                  partial || sources.some((source) => source.availability === "unavailable")
                    ? "partial"
                    : "complete",
                state: preparing ? "preparing" : "ready",
              } satisfies SessionSearchResult;
            }),
          );
        }),
      );
    });
  });
