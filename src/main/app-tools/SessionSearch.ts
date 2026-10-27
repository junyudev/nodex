import { createHash, randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  rankSessionMetadata,
  sessionSearchSubject,
} from "@nodex/agent-runtime/orchestration/SessionSearchRanking";
import {
  rankSessionBody,
  sessionBodyUsage,
} from "@nodex/agent-runtime/orchestration/SessionBodyRanking";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { makeTemporarySqlite } from "../platform/node/TemporarySqlite";
import { AgentRuntimeApplicationError } from "../agent-runtime/AgentRuntimeApplication";
import { NativeSessionSearchStale } from "./NativeSessionSearch";
import { summaryOf, SessionDiscoveryError, type SessionListingSummary } from "./SessionDiscovery";
import type { NativeSessionSearch, NativeSearchFact } from "./NativeSessionSearch";

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
export interface SessionSearchMatch {
  readonly session: SessionListingSummary;
  readonly source:
    | "title"
    | "branch"
    | "pull_request"
    | "project"
    | "user"
    | "assistant"
    | "message"
    | "reference";
  readonly snippet?: string;
  readonly itemId?: string;
  readonly sourceThreadId?: string;
  readonly runId?: string | null;
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
  readonly native: NativeSessionSearch;
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
  if (Schema.is(NativeSessionSearchStale)(cause)) return fail("cursor_stale", cause);
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
const statusOf = (details: Metadata): "active" | "idle" | "systemError" => {
  const status = details.activityRunStatus ?? details.runStatus;
  if (status === "failed") return "systemError";
  return ["preparing", "starting", "running", "waiting"].includes(status ?? "") ? "active" : "idle";
};
const withMetadata = (
  session: SessionListingSummary,
  details: Metadata,
): SessionListingSummary => ({
  ...session,
  threadId: details.threadId,
  preview: details.preview,
  backend:
    details.providerDriver === "claudeAgent"
      ? "claude"
      : details.providerDriver === "codex" || details.providerDriver === "opencode"
        ? details.providerDriver
        : "acp",
  recencyAt: details.recencyAt === null ? null : Date.parse(details.recencyAt),
  status: { status_type: statusOf(details), active_flags: [] },
  createdBy: details.createdBy,
  creationSource: details.creationSource,
  createdAt: details.createdAt,
  latestUserAuthoredMessageAt: details.latestUserAuthoredMessageAt,
  updatedAt: details.updatedAt,
  activeRunId: details.activeRunId,
  worktreePath: details.worktreePath,
  titleRegeneration: details.titleRegeneration,
  latestRunId: details.latestRunId,
  runStatus: details.runStatus,
  activityRunStatus: details.activityRunStatus,
  runtimeMode: details.runtimeMode,
  interactionMode: details.interactionMode,
  parentThreadId: details.parentThreadId,
  relationshipToParent: details.relationshipToParent,
  branch: details.branch,
  settled: details.settled,
  settledAt: details.settledAt,
  snoozed: details.snoozed,
  snoozedUntil: details.snoozedUntil,
  pullRequests: details.pullRequests,
  itemCount: details.itemCount,
  itemCountCoverage: details.itemCountCoverage,
  agent:
    details.providerInstanceId === null || details.model === null
      ? null
      : { providerInstanceId: details.providerInstanceId, model: details.model },
  metadataCoverage: "complete",
});
type Body =
  | {
      readonly kind: "runtime";
      readonly fact: Omit<RuntimeFact, "snippet" | "cursor">;
      readonly runtimeId: string;
    }
  | {
      readonly kind: "native";
      readonly fact: Omit<NativeSearchFact, "snippet">;
      readonly target: { readonly hostId: string; readonly threadId: string };
    };
interface Row {
  readonly id: string;
  readonly summary: string;
  readonly exact_rank: string | null;
  readonly typo_rank: string | null;
  readonly body: string | null;
}
interface Work {
  readonly id: number;
  readonly kind: "runtime" | "native" | "metadata";
  readonly source: string;
  readonly input: string;
  readonly cursor: string | null;
}
const bodyFact = (body: Body) => body.fact;
const itemIdOf = (body: Body) =>
  body.kind === "native" ? body.fact.reference.itemId : body.fact.itemId;
const metadataOrder = (column: string) =>
  `CASE WHEN json_extract(${column},'$.quality')>=1.5 THEN 3 WHEN json_extract(${column},'$.quality')>=0.7 THEN 2 WHEN json_extract(${column},'$.quality')>=0.4 THEN 1 ELSE 0 END DESC,json_extract(${column},'$.score') DESC,id`;

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
            "CREATE TABLE sessions(id TEXT PRIMARY KEY,summary TEXT NOT NULL,exact_rank TEXT,typo_rank TEXT,body TEXT,word INTEGER,quality REAL,score REAL,authored TEXT,published INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute(
            "CREATE INDEX body_rank ON sessions(published,word DESC,quality DESC,score DESC,authored DESC,id) WHERE body IS NOT NULL",
          );
          yield* db.execute(
            "CREATE INDEX execution_binding ON sessions(json_extract(summary,'$.binding.runtimeId'),json_extract(summary,'$.binding.threadId'))",
          );
          for (const column of ["exact_rank", "typo_rank"])
            yield* db.execute(
              `CREATE INDEX ${column}_order ON sessions(published,${metadataOrder(column)}) WHERE ${column} IS NOT NULL`,
            );
          yield* db.execute(
            "CREATE TABLE work(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,input TEXT NOT NULL,cursor TEXT,done INTEGER NOT NULL DEFAULT 0,error TEXT,attempt INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute(
            "CREATE TABLE output(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL)",
          );
          yield* db.execute(
            "CREATE TABLE sources(source TEXT PRIMARY KEY,attempt INTEGER NOT NULL DEFAULT 0)",
          );
          yield* db.execute("CREATE INDEX work_schedule ON work(source,done,attempt,id)");
          yield* db.execute(
            "CREATE INDEX native_body_ready ON work(kind,done,json_extract(input,'$.sessionId'))",
          );
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
              const writeSummary = (session: SessionListingSummary) =>
                db.execute(
                  "INSERT INTO sessions(id,summary,exact_rank,typo_rank) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,exact_rank=excluded.exact_rank,typo_rank=excluded.typo_rank",
                  [
                    session.sessionId,
                    JSON.stringify(session),
                    JSON.stringify(
                      rankSessionMetadata(
                        sessionSearchSubject(session),
                        input.query,
                        query.now,
                        false,
                      ),
                    ),
                    JSON.stringify(
                      rankSessionMetadata(
                        sessionSearchSubject(session),
                        input.query,
                        query.now,
                        true,
                      ),
                    ),
                  ].map((value) => (value === "null" ? null : value)),
                );
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
                    "UPDATE sessions SET word=?,quality=?,score=?,authored=? WHERE id=?",
                    [
                      Number(rank.word),
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
                      "SELECT * FROM sessions WHERE json_extract(summary,'$.binding.runtimeId')=? AND json_extract(summary,'$.binding.threadId')=?",
                      [runtimeId, metadata.threadId],
                    );
                    for (const row of rows) {
                      const session = withMetadata(
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
                  if (!old) return;
                  const existing = old.body === null ? null : (JSON.parse(old.body) as Body);
                  let selected = body;
                  if (existing) {
                    const left = bodyFact(existing),
                      right = bodyFact(body);
                    const highest = Math.max(left.quality, right.quality);
                    const hits =
                      (left.quality === highest ? left.hits : 0) +
                      (right.quality === highest ? right.hits : 0);
                    const preferExisting =
                      left.quality > right.quality ||
                      (left.quality === right.quality &&
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
                    "UPDATE sessions SET body=?,word=?,quality=?,score=?,authored=? WHERE id=?",
                    [
                      JSON.stringify(selected),
                      Number(rank.word),
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
                  if (work.kind === "native") {
                    const target = JSON.parse(work.input) as {
                      sessionId: string;
                      hostId: string;
                      threadId: string;
                    };
                    const page = yield* dependencies.native.page({
                      ...target,
                      query: input.query,
                      cursor: work.cursor,
                    });
                    const row = (yield* db.rows<Row>("SELECT * FROM sessions WHERE id=?", [
                      target.sessionId,
                    ]))[0];
                    if (!row) return null;
                    const previous = JSON.parse(row.summary) as SessionListingSummary;
                    const newest = page.latestUserMessageAt;
                    const at =
                      newest !== null &&
                      (!previous.activityEvidence || newest > previous.activityEvidence.at)
                        ? newest
                        : previous.activityEvidence?.at;
                    const session: SessionListingSummary = {
                      ...previous,
                      ...(at ? { activityEvidence: { at, provenance: "user_role" } } : {}),
                    };
                    yield* writeSummary(session);
                    yield* refreshBodyRank(session);
                    for (const { snippet: _snippet, ...fact } of page.items)
                      yield* storeBody(session, { kind: "native", fact, target });
                    return page.nextCursor;
                  }
                  const target = JSON.parse(work.input) as {
                    runtimeId: string;
                    threadIds: string[];
                  };
                  const page = yield* dependencies.sessionSearch({
                    query: input.query,
                    threadIds: target.threadIds,
                    limit: 100,
                    ...(work.cursor === null ? {} : { cursor: work.cursor }),
                  });
                  if (page.runtimeId !== target.runtimeId)
                    return yield* Effect.fail(new Error("The bound Runtime source is unavailable"));
                  if (page.nextCursor !== null && page.nextCursor === work.cursor)
                    return yield* Effect.fail(new Error("Runtime search did not advance"));
                  for (const { snippet: _snippet, cursor: _cursor, ...fact } of page.items) {
                    if (!target.threadIds.includes(fact.threadId)) continue;
                    const rows = yield* db.rows<Row>(
                      "SELECT * FROM sessions WHERE json_extract(summary,'$.binding.runtimeId')=? AND json_extract(summary,'$.binding.threadId')=?",
                      [target.runtimeId, fact.threadId],
                    );
                    for (const row of rows)
                      yield* storeBody(JSON.parse(row.summary) as SessionListingSummary, {
                        kind: "runtime",
                        fact,
                        runtimeId: target.runtimeId,
                      });
                  }
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
                          if (session.binding?.kind === "native")
                            yield* addWork("native", `native:${session.binding.hostId}`, {
                              sessionId: session.sessionId,
                              ...session.binding,
                            });
                        }
                        for (const [runtimeId, threadIds] of runtimes) {
                          yield* addWork("runtime", "runtime:messages", { runtimeId, threadIds });
                          yield* addWork("metadata", "runtime:metadata", { runtimeId, threadIds });
                        }
                      }),
                    );
                    query.coreError = null;
                    query.coreCursor = next;
                    query.coreDone = next === null;
                  }),
                );
              const unavailable = new Set<string>();
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
                  "SELECT source FROM sources WHERE source NOT IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM work WHERE work.source=sources.source AND work.done=0) ORDER BY attempt,source LIMIT 1",
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
              const partial = sources.some((source) => source.availability === "unavailable");
              const last = (yield* db.rows<{ seq: number }>(
                "SELECT COALESCE(MAX(seq),0) AS seq FROM output",
              ))[0]!.seq;
              if (position.after > last)
                return yield* fail(
                  "invalid_cursor",
                  "Search output position is outside this query",
                );
              const strong = (yield* db.rows<{ count: number }>(
                "SELECT COUNT(*) AS count FROM sessions WHERE json_extract(exact_rank,'$.strong')=1",
              ))[0]!.count;
              const metadataPending =
                !query.coreDone ||
                (yield* db.rows<{ count: number }>(
                  "SELECT COUNT(*) AS count FROM work WHERE kind='metadata' AND done=0",
                ))[0]!.count > 0;
              const rank = strong || metadataPending ? "exact_rank" : "typo_rank";
              if (!preparing && position.after === last) {
                const metadata = yield* db.rows<Row>(
                  `SELECT * FROM sessions WHERE published=0 AND ${rank} IS NOT NULL ORDER BY ${metadataOrder(rank)} LIMIT ?`,
                  [input.limit],
                );
                const bodies = yield* db.rows<Row>(
                  "SELECT * FROM sessions WHERE published=0 AND body IS NOT NULL AND (json_extract(body,'$.kind')<>'native' OR EXISTS(SELECT 1 FROM work WHERE work.kind='native' AND work.done=1 AND json_extract(work.input,'$.sessionId')=sessions.id)) AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY word DESC,quality DESC,score DESC,authored DESC,id LIMIT ?",
                  [JSON.stringify(metadata.map((row) => row.id)), input.limit],
                );
                const reserved = bodies.length ? Math.max(1, Math.floor(input.limit / 5)) : 0;
                const chosen = [
                  ...metadata
                    .slice(0, input.limit - Math.min(reserved, bodies.length))
                    .map((row) => ({ row, kind: rank })),
                  ...bodies
                    .slice(0, Math.max(reserved, input.limit - metadata.length))
                    .map((row) => ({ row, kind: "body" })),
                ].slice(0, input.limit);
                yield* db.transaction(
                  Effect.gen(function* () {
                    for (const [index, { row, kind }] of chosen.entries()) {
                      yield* db.execute("INSERT INTO output(seq,id,kind) VALUES(?,?,?)", [
                        last + index + 1,
                        row.id,
                        kind,
                      ]);
                      yield* db.execute("UPDATE sessions SET published=1 WHERE id=?", [row.id]);
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
                  const rank = JSON.parse(
                    (row.kind === "exact_rank" ? row.exact_rank : row.typo_rank)!,
                  ) as { source: SessionSearchMatch["source"] };
                  const coreMatch = rankSessionMetadata(
                    sessionSearchSubject(placement),
                    input.query,
                    query.now,
                    row.kind === "typo_rank",
                  );
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
                    session = withMetadata(session, metadata);
                  }
                  const currentMatch = rankSessionMetadata(
                    sessionSearchSubject(session),
                    input.query,
                    query.now,
                    row.kind === "typo_rank",
                  );
                  if (currentMatch?.source !== rank.source)
                    return yield* fail("cursor_stale", "Selected matching metadata changed");
                  match = { session, source: rank.source };
                } else {
                  const body = JSON.parse(row.body!) as Body;
                  const resolving: Effect.Effect<
                    {
                      readonly source: "user" | "assistant";
                      readonly snippet: string;
                      readonly messageAt: string;
                      readonly quality: number;
                    },
                    unknown
                  > =
                    body.kind === "native"
                      ? dependencies.native.resolve({
                          ...body.target,
                          query: input.query,
                          reference: body.fact.reference,
                        })
                      : dependencies
                          .sessionSearchResolve({
                            query: input.query,
                            references: [
                              {
                                threadId: body.fact.threadId,
                                itemId: body.fact.itemId,
                                messageId: body.fact.messageId,
                                contentVersion: body.fact.contentVersion,
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
                                    fail(
                                      "cursor_stale",
                                      "Search message no longer matches its source",
                                    ),
                                  );
                            }),
                          );
                  const resolved = yield* resolving.pipe(Effect.result);
                  if (resolved._tag === "Failure") {
                    const stale = cursorFailure(resolved.failure);
                    if (stale) return yield* stale;
                    sources.push({
                      source: body.kind === "native" ? `native:${body.target.hostId}` : "runtime",
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
                    itemId: itemIdOf(body),
                    sourceThreadId:
                      body.kind === "native" ? body.target.threadId : body.fact.threadId,
                    runId: body.kind === "native" ? body.fact.reference.runId : body.fact.runId,
                    messageAt: fact.messageAt,
                    quality: fact.quality,
                    hits: body.fact.hits,
                  };
                }
                matches.push(match);
                after = row.seq;
                entryCursors.push(encode({ ...position, after }));
              }
              const remaining = (yield* db.rows<{ count: number }>(
                `SELECT (SELECT COUNT(*) FROM sessions WHERE published=0 AND (${rank} IS NOT NULL OR body IS NOT NULL))+(SELECT COUNT(*) FROM output WHERE seq>?) AS count`,
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
