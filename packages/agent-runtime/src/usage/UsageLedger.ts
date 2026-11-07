import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";

import {
  localCalendar,
  usageSlotOf,
  usageSlotStartMs,
  type InsightsAgentDay,
  type InsightsHistoryAccess,
  type InsightsModelDay,
  type InsightsOrigin,
  type InsightsPricingStatus,
  type InsightsScanProgress,
  type InsightsUsageSnapshot,
  type InsightsUsageSource,
} from "../../../../src/shared/insights.ts";
import { claudeTranscriptFormat } from "./ClaudeTranscriptFormat.ts";
import { codexTranscriptFormat } from "./CodexTranscriptFormat.ts";
import {
  listTranscriptFiles,
  readTranscript,
  type TranscriptFile,
  type TranscriptPosition,
  type TranscriptReadResult,
} from "./TranscriptReader.ts";
import { parseRateTable, priceUsage, type RateTable } from "./UsagePricing.ts";
import type { TranscriptFormat, UsageProvider, UsageSpeed } from "./UsageRecord.ts";

const RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/** The API host stays reachable on networks that block the raw content host. */
const RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_RETRY_MS = 10 * 60 * 1000;
const RESCAN_AFTER_MS = 60 * 1000;
const BACKGROUND_SCAN_INTERVAL = "1 hour";
/** A turn this long was waiting on someone, and would inflate agent time and parallelism. */
const MAX_TURN_MS = 6 * 60 * 60 * 1000;
/** Scanning shares a process with live conversations, so it rests for a share of what it spends. */
const SCAN_REST_RATIO = 0.25;
const MAX_SCAN_REST_MS = 250;
const SEEN_KEY_CHUNK = 400;

const HISTORY_ACCESS_KEY = "history_access";
const SOURCES_KEY = "sources";

const formats: Readonly<Record<UsageProvider, TranscriptFormat<unknown>>> = {
  claude: claudeTranscriptFormat as TranscriptFormat<unknown>,
  codex: codexTranscriptFormat as TranscriptFormat<unknown>,
};

interface Candidate extends TranscriptFile {
  readonly key: string;
  readonly provider: UsageProvider;
  readonly origin: "nodex" | "external";
}

interface KnownFile {
  readonly file_key: string;
  readonly path: string;
  readonly size: number;
  readonly mtime_ms: number;
  readonly resume_offset: number;
  readonly guard_length: number;
  readonly guard_hash: number;
  readonly state_json: string;
}

const hashKey = (key: string) =>
  NodeCrypto.createHash("sha1").update(key).digest("base64url").slice(0, 16);

/** A rollout keeps its name when Codex compresses or archives it, so that move stays one transcript. */
export const transcriptKey = (provider: UsageProvider, path: string) =>
  provider === "codex"
    ? `codex:${NodePath.basename(path).replace(/\.zst$/, "")}`
    : `claude:${path.replace(/\.zst$/, "")}`;

const sourceRoots = (source: InsightsUsageSource) =>
  source.provider === "claude"
    ? [NodePath.join(source.home, "projects")]
    : [NodePath.join(source.home, "sessions"), NodePath.join(source.home, "archived_sessions")];

/** Two copies of a transcript read as one: prefer the newest, then the plain file. */
export function selectCandidates(candidates: readonly Candidate[]): readonly Candidate[] {
  const selected = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const held = selected.get(candidate.key);
    const replaces =
      held === undefined ||
      candidate.mtimeMs > held.mtimeMs ||
      (candidate.mtimeMs === held.mtimeMs && !candidate.path.endsWith(".zst"));
    if (replaces) selected.set(candidate.key, candidate);
  }
  return [...selected.values()];
}

export function readAgentDays(
  turns: readonly { readonly startedMs: number; readonly completedMs: number }[],
  timeZone: string,
): readonly InsightsAgentDay[] {
  const calendar = localCalendar(timeZone);
  const days = new Map<string, { turns: number; activeSeconds: number; peakAgents: number }>();
  const dayEntry = (day: string) => {
    let entry = days.get(day);
    if (entry === undefined) {
      entry = { turns: 0, activeSeconds: 0, peakAgents: 0 };
      days.set(day, entry);
    }
    return entry;
  };
  const edges: (readonly [timeMs: number, delta: 1 | -1])[] = [];
  for (const { startedMs, completedMs } of turns) {
    const duration = completedMs - startedMs;
    if (!(duration >= 0 && duration <= MAX_TURN_MS)) continue;
    const entry = dayEntry(calendar.dayOf(startedMs));
    entry.turns += 1;
    entry.activeSeconds += duration / 1000;
    edges.push([startedMs, 1], [completedMs, -1]);
  }
  // A turn that starts as another ends overlapped it for no time at all.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  for (const [timeMs, delta] of edges) {
    running += delta;
    if (delta === 1) {
      const entry = dayEntry(calendar.dayOf(timeMs));
      if (running > entry.peakAgents) entry.peakAgents = running;
    }
  }
  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, entry]) => ({ day, ...entry, activeSeconds: Math.round(entry.activeSeconds) }));
}

const MIN_RECOMPUTE_INTERVAL_MS = 3_000;
const RECOMPUTE_INTERVAL_MULTIPLE = 20;

/** Keeps recomputing during a scan under about one twentieth of the Runtime's time. */
export const mayRecompute = (sinceComputedMs: number, computeMs: number) =>
  sinceComputedMs >= Math.max(MIN_RECOMPUTE_INTERVAL_MS, computeMs * RECOMPUTE_INTERVAL_MULTIPLE);

export interface UsageLedgerOptions {
  readonly stateDir: string;
  readonly scope: Scope.Scope;
  /** Tests stop the hourly pass and supply their own prices. */
  readonly background?: boolean;
  readonly rates?: RateTable;
}

export const make = Effect.fn("UsageLedger.make")(function* (options: UsageLedgerOptions) {
  const sql = yield* SqlClient.SqlClient;
  const http = yield* HttpClient.HttpClient;
  const ratesPath = NodePath.join(options.stateDir, "usage-model-rates.json");

  const idle: InsightsScanProgress = {
    state: "idle",
    filesDone: 0,
    filesTotal: 0,
    failedFiles: 0,
    finishedAtMs: null,
  };
  const progress = yield* Ref.make(idle);
  const revision = yield* Ref.make(0);
  const bump = Ref.update(revision, (value) => value + 1);
  const rates = yield* Ref.make<{
    readonly table: RateTable;
    readonly status: InsightsPricingStatus;
    readonly fetchedAtMs: number;
    readonly attemptedAtMs: number;
  }>({
    table: options.rates ?? new Map(),
    status: options.rates === undefined ? "unavailable" : "fresh",
    fetchedAtMs: options.rates === undefined ? 0 : Number.POSITIVE_INFINITY,
    attemptedAtMs: 0,
  });

  const readMeta = (key: string) =>
    sql<{ readonly value: string }>`SELECT value FROM usage_ledger_meta WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
    );
  const writeMeta = (key: string, value: string) =>
    sql`INSERT INTO usage_ledger_meta (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

  const readAccess = readMeta(HISTORY_ACCESS_KEY).pipe(
    Effect.map((value): InsightsHistoryAccess => (value === "granted" ? "granted" : "unset")),
  );
  const readSources = readMeta(SOURCES_KEY).pipe(
    Effect.map((value): readonly InsightsUsageSource[] =>
      value === null ? [] : (JSON.parse(value) as readonly InsightsUsageSource[]),
    ),
  );

  const loadRates = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(rates);
    if (now - current.fetchedAtMs < RATES_TTL_MS) return;
    if (now - current.attemptedAtMs < RATES_RETRY_MS) return;
    yield* Ref.update(rates, (value) => ({ ...value, attemptedAtMs: now }));

    if (current.table.size === 0) {
      const saved = yield* Effect.tryPromise(() => NodeFSP.readFile(ratesPath, "utf8")).pipe(
        Effect.map(
          (text) => JSON.parse(text) as { readonly fetchedAtMs: number; readonly rates: unknown },
        ),
        Effect.option,
      );
      if (saved._tag === "Some") {
        const table = parseRateTable(saved.value.rates);
        if (table.size > 0) {
          yield* Ref.update(rates, (value) => ({
            ...value,
            table,
            status: "cached" as const,
            fetchedAtMs: saved.value.fetchedAtMs,
          }));
          yield* bump;
          if (now - saved.value.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetchRates = (url: string, accept: string) =>
      http.get(url, { headers: { accept } }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.option,
      );
    let document = yield* fetchRates(RATES_URL, "application/json");
    if (document._tag === "None") {
      document = yield* fetchRates(RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (document._tag === "None") return;
    const table = parseRateTable(document.value);
    if (table.size === 0) return;
    yield* Ref.update(rates, (value) => ({
      ...value,
      table,
      status: "fresh" as const,
      fetchedAtMs: now,
    }));
    yield* bump;
    yield* Effect.tryPromise(() =>
      NodeFSP.writeFile(ratesPath, JSON.stringify({ fetchedAtMs: now, rates: document.value })),
    ).pipe(Effect.ignore);
  });

  const listCandidates = Effect.fn("UsageLedger.listCandidates")(function* (
    sources: readonly InsightsUsageSource[],
  ) {
    const candidates: Candidate[] = [];
    let failed = 0;
    for (const source of sources) {
      for (const root of sourceRoots(source)) {
        const listed = yield* Effect.promise(() => listTranscriptFiles(root));
        failed += listed.failedPaths;
        for (const file of listed.files) {
          candidates.push({
            ...file,
            provider: source.provider,
            origin: source.origin,
            key: transcriptKey(source.provider, file.path),
          });
        }
      }
    }
    return { candidates: selectCandidates(candidates), failed };
  });

  const nodexSessionIds = sql<{ readonly id: string | null }>`
    SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS id
    FROM orchestration_v2_projection_provider_threads
  `.pipe(Effect.map((rows) => new Set(rows.flatMap((row) => (row.id === null ? [] : [row.id])))));

  /** One transcript's new usage commits whole, so a stopped scan resumes without double counting. */
  const ingest = Effect.fn("UsageLedger.ingest")(function* (
    candidate: Candidate,
    result: TranscriptReadResult,
    origin: "nodex" | "external",
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const key = candidate.key;
        if (!result.resumed) {
          yield* sql`DELETE FROM usage_ledger_requests WHERE file_key = ${key}`;
          yield* sql`DELETE FROM usage_ledger_messages WHERE file_key = ${key}`;
          yield* sql`DELETE FROM usage_ledger_seen WHERE file_key = ${key}`;
        }

        const dedupeKeys = new Set<string>();
        const hashed = new Map<string, string>();
        for (const record of result.records) {
          if (record.dedupeKey === null) continue;
          const hash = hashKey(`${record.kind}:${record.dedupeKey}`);
          hashed.set(`${record.kind}:${record.dedupeKey}`, hash);
          dedupeKeys.add(hash);
        }
        const seen = new Set<string>();
        const allKeys = [...dedupeKeys];
        for (let index = 0; index < allKeys.length; index += SEEN_KEY_CHUNK) {
          const rows = yield* sql<{ readonly key: string }>`
            SELECT key FROM usage_ledger_seen
            WHERE key IN ${sql.in(allKeys.slice(index, index + SEEN_KEY_CHUNK))}
          `;
          for (const row of rows) seen.add(row.key);
        }

        const requests = new Map<
          string,
          {
            slot: number;
            model: string;
            speed: UsageSpeed;
            uncached: number;
            cached: number;
            creation: number;
            output: number;
            reasoning: number;
            count: number;
          }
        >();
        const messages = new Map<number, number>();
        const fresh = new Set<string>();
        let firstActivityMs: number | null = null;
        for (const record of result.records) {
          if (record.dedupeKey !== null) {
            const hash = hashed.get(`${record.kind}:${record.dedupeKey}`)!;
            if (seen.has(hash) || fresh.has(hash)) continue;
            fresh.add(hash);
          }
          if (firstActivityMs === null || record.timestampMs < firstActivityMs) {
            firstActivityMs = record.timestampMs;
          }
          const slot = usageSlotOf(record.timestampMs);
          if (record.kind === "message") {
            messages.set(slot, (messages.get(slot) ?? 0) + 1);
            continue;
          }
          const bucketKey = `${slot}\u0000${record.model}\u0000${record.speed}`;
          let bucket = requests.get(bucketKey);
          if (bucket === undefined) {
            bucket = {
              slot,
              model: record.model,
              speed: record.speed,
              uncached: 0,
              cached: 0,
              creation: 0,
              output: 0,
              reasoning: 0,
              count: 0,
            };
            requests.set(bucketKey, bucket);
          }
          bucket.uncached += record.totals.uncachedInputTokens;
          bucket.cached += record.totals.cachedInputTokens;
          bucket.creation += record.totals.cacheCreationTokens;
          bucket.output += record.totals.outputTokens;
          bucket.reasoning += record.totals.reasoningTokens;
          bucket.count += 1;
        }

        const position = result.position;
        yield* sql`
          INSERT INTO usage_ledger_files (
            file_key, provider, path, size, mtime_ms, resume_offset, guard_length, guard_hash,
            state_json, origin, subagent, first_activity_ms
          ) VALUES (
            ${key}, ${candidate.provider}, ${candidate.path}, ${candidate.size}, ${candidate.mtimeMs},
            ${position.resumeOffset}, ${position.guardLength}, ${position.guardHash},
            ${JSON.stringify(position.state)}, ${origin}, ${result.session.subagent ? 1 : 0},
            ${firstActivityMs}
          )
          ON CONFLICT (file_key) DO UPDATE SET
            provider = excluded.provider,
            path = excluded.path,
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            resume_offset = excluded.resume_offset,
            guard_length = excluded.guard_length,
            guard_hash = excluded.guard_hash,
            state_json = excluded.state_json,
            origin = excluded.origin,
            subagent = excluded.subagent,
            first_activity_ms = CASE
              WHEN ${result.resumed ? 1 : 0} = 1 THEN
                COALESCE(MIN(usage_ledger_files.first_activity_ms, excluded.first_activity_ms),
                         usage_ledger_files.first_activity_ms, excluded.first_activity_ms)
              ELSE excluded.first_activity_ms
            END
        `;
        for (const hash of fresh) {
          yield* sql`INSERT OR IGNORE INTO usage_ledger_seen (key, file_key) VALUES (${hash}, ${key})`;
        }
        for (const bucket of requests.values()) {
          yield* sql`
            INSERT INTO usage_ledger_requests (
              file_key, slot, model, speed, uncached_input_tokens, cached_input_tokens,
              cache_creation_tokens, output_tokens, reasoning_tokens, requests
            ) VALUES (
              ${key}, ${bucket.slot}, ${bucket.model}, ${bucket.speed}, ${bucket.uncached},
              ${bucket.cached}, ${bucket.creation}, ${bucket.output}, ${bucket.reasoning}, ${bucket.count}
            )
            ON CONFLICT (file_key, slot, model, speed) DO UPDATE SET
              uncached_input_tokens = uncached_input_tokens + excluded.uncached_input_tokens,
              cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
              cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
              requests = requests + excluded.requests
          `;
        }
        for (const [slot, count] of messages) {
          yield* sql`
            INSERT INTO usage_ledger_messages (file_key, slot, messages)
            VALUES (${key}, ${slot}, ${count})
            ON CONFLICT (file_key, slot) DO UPDATE SET messages = messages + excluded.messages
          `;
        }
      }),
    );
  });

  /** Keeps its own copy of finished turns, so deleting a conversation never lowers a record. */
  const mirrorTurns = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly id: string;
      readonly started: string | null;
      readonly completed: string | null;
    }>`
      SELECT t.provider_turn_id AS id,
        json_extract(t.payload_json, '$.startedAt') AS started,
        json_extract(t.payload_json, '$.completedAt') AS completed
      FROM orchestration_v2_projection_provider_turns t
      LEFT JOIN usage_ledger_turns known ON known.provider_turn_id = t.provider_turn_id
      WHERE known.provider_turn_id IS NULL
        AND json_extract(t.payload_json, '$.completedAt') IS NOT NULL
    `;
    if (rows.length === 0) return;
    yield* sql.withTransaction(
      Effect.forEach(
        rows,
        (row) => {
          const startedMs = row.started === null ? Number.NaN : Date.parse(row.started);
          const completedMs = row.completed === null ? Number.NaN : Date.parse(row.completed);
          if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return Effect.void;
          return sql`
            INSERT OR IGNORE INTO usage_ledger_turns (provider_turn_id, started_ms, completed_ms)
            VALUES (${row.id}, ${startedMs}, ${completedMs})
          `;
        },
        { discard: true },
      ),
    );
    yield* bump;
  });

  const scanOnce = Effect.gen(function* () {
    const sources = yield* readSources;
    const { candidates, failed } = yield* listCandidates(sources);
    const known = new Map(
      (yield* sql<KnownFile>`
        SELECT file_key, path, size, mtime_ms, resume_offset, guard_length, guard_hash, state_json
        FROM usage_ledger_files
      `).map((row) => [row.file_key, row] as const),
    );
    const changed = candidates
      .filter((candidate) => {
        const row = known.get(candidate.key);
        return (
          row === undefined ||
          row.path !== candidate.path ||
          row.size !== candidate.size ||
          row.mtime_ms !== candidate.mtimeMs
        );
      })
      // Newest first: recent numbers appear at once and history fills in behind them.
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    yield* Ref.update(progress, (value) => ({
      ...value,
      state: "scanning" as const,
      filesDone: 0,
      filesTotal: changed.length,
      failedFiles: failed,
    }));
    const nodexIds = changed.length === 0 ? new Set<string>() : yield* nodexSessionIds;

    for (const candidate of changed) {
      const startedMs = yield* Clock.currentTimeMillis;
      const row = known.get(candidate.key);
      const resumeFrom: TranscriptPosition | undefined =
        row !== undefined && row.path === candidate.path && candidate.size > row.size
          ? {
              resumeOffset: row.resume_offset,
              guardLength: row.guard_length,
              guardHash: row.guard_hash,
              state: JSON.parse(row.state_json) as unknown,
            }
          : undefined;
      const result = yield* Effect.promise(() =>
        readTranscript(candidate.path, formats[candidate.provider], resumeFrom),
      );
      if (result === null) {
        yield* Ref.update(progress, (value) => ({
          ...value,
          filesDone: value.filesDone + 1,
          failedFiles: value.failedFiles + 1,
        }));
        continue;
      }
      const origin =
        candidate.origin === "nodex" || nodexIds.has(result.session.sessionId)
          ? "nodex"
          : "external";
      yield* ingest(candidate, result, origin);
      yield* Ref.update(progress, (value) => ({ ...value, filesDone: value.filesDone + 1 }));
      yield* bump;
      const spentMs = (yield* Clock.currentTimeMillis) - startedMs;
      yield* Effect.sleep(Math.min(spentMs * SCAN_REST_RATIO, MAX_SCAN_REST_MS));
    }
    yield* mirrorTurns;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    yield* Ref.update(progress, (value) => ({ ...value, state: "idle" as const, finishedAtMs }));
    yield* bump;
  }).pipe(
    Effect.onError(() => Ref.update(progress, (value) => ({ ...value, state: "idle" as const }))),
  );

  const ensureScan = Effect.gen(function* () {
    if ((yield* readAccess) !== "granted") return;
    const now = yield* Clock.currentTimeMillis;
    const start = yield* Ref.modify(progress, (value): readonly [boolean, InsightsScanProgress] => {
      const stale = value.finishedAtMs === null || now - value.finishedAtMs >= RESCAN_AFTER_MS;
      return value.state === "idle" && stale
        ? [true, { ...value, state: "scanning" }]
        : [false, value];
    });
    if (!start) return;
    yield* scanOnce.pipe(Effect.ignoreCause, Effect.forkIn(options.scope));
  });

  const readUsage = Effect.fn("UsageLedger.readUsage")(function* (
    timeZone: string,
    origin: InsightsOrigin,
  ) {
    const calendar = localCalendar(timeZone);
    const nodexOnly = origin === "nodex" ? 1 : 0;
    const requestRows = yield* sql<{
      readonly provider: UsageProvider;
      readonly slot: number;
      readonly model: string;
      readonly speed: UsageSpeed;
      readonly uncached: number;
      readonly cached: number;
      readonly creation: number;
      readonly output: number;
      readonly reasoning: number;
      readonly requests: number;
    }>`
      SELECT file.provider AS provider, row.slot AS slot, row.model AS model, row.speed AS speed,
        SUM(row.uncached_input_tokens) AS uncached, SUM(row.cached_input_tokens) AS cached,
        SUM(row.cache_creation_tokens) AS creation, SUM(row.output_tokens) AS output,
        SUM(row.reasoning_tokens) AS reasoning, SUM(row.requests) AS requests
      FROM usage_ledger_requests row
      JOIN usage_ledger_files file ON file.file_key = row.file_key
      WHERE ${nodexOnly} = 0 OR file.origin = 'nodex'
      GROUP BY file.provider, row.slot, row.model, row.speed
    `;
    const { table, status } = yield* Ref.get(rates);
    const models = new Map<
      string,
      { -readonly [K in keyof InsightsModelDay]: InsightsModelDay[K] }
    >();
    const hours = new Map<string, number>();
    for (const row of requestRows) {
      const startMs = usageSlotStartMs(row.slot);
      const day = calendar.dayOf(startMs);
      const totals = {
        uncachedInputTokens: row.uncached,
        cachedInputTokens: row.cached,
        cacheCreationTokens: row.creation,
        outputTokens: row.output,
        reasoningTokens: row.reasoning,
      };
      const priced = priceUsage(table, row.model, row.speed, totals);
      const key = `${day}\u0000${row.provider}\u0000${row.model}`;
      let entry = models.get(key);
      if (entry === undefined) {
        entry = {
          day,
          provider: row.provider,
          model: row.model,
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          requests: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
          priced: priced.priced,
        };
        models.set(key, entry);
      }
      entry.uncachedInputTokens += row.uncached;
      entry.cachedInputTokens += row.cached;
      entry.cacheCreationTokens += row.creation;
      entry.outputTokens += row.output;
      entry.requests += row.requests;
      entry.costUsd += priced.costUsd;
      entry.cacheSavingsUsd += priced.cacheSavingsUsd;
      const tokens = row.uncached + row.cached + row.creation + row.output;
      const hourKey = `${day}\u0000${calendar.hourOf(startMs)}`;
      hours.set(hourKey, (hours.get(hourKey) ?? 0) + tokens);
    }

    const messageRows = yield* sql<{ readonly slot: number; readonly messages: number }>`
      SELECT row.slot AS slot, SUM(row.messages) AS messages
      FROM usage_ledger_messages row
      JOIN usage_ledger_files file ON file.file_key = row.file_key
      WHERE ${nodexOnly} = 0 OR file.origin = 'nodex'
      GROUP BY row.slot
    `;
    const messages = new Map<string, number>();
    for (const row of messageRows) {
      const day = calendar.dayOf(usageSlotStartMs(row.slot));
      messages.set(day, (messages.get(day) ?? 0) + row.messages);
    }

    const conversationRows = yield* sql<{ readonly first_activity_ms: number }>`
      SELECT first_activity_ms FROM usage_ledger_files
      WHERE subagent = 0 AND first_activity_ms IS NOT NULL
        AND (${nodexOnly} = 0 OR origin = 'nodex')
    `;
    const conversations = new Map<string, number>();
    for (const row of conversationRows) {
      const day = calendar.dayOf(row.first_activity_ms);
      conversations.set(day, (conversations.get(day) ?? 0) + 1);
    }

    const turnRows = yield* sql<{ readonly started_ms: number; readonly completed_ms: number }>`
      SELECT started_ms, completed_ms FROM usage_ledger_turns
    `;
    const ordered = <Value>(entries: Iterable<readonly [string, Value]>) =>
      [...entries].sort(([a], [b]) => a.localeCompare(b));
    return {
      pricing: status,
      models: ordered([...models].map(([key, value]) => [key, value] as const)).map(
        ([, value]) => value,
      ),
      messages: ordered(messages),
      conversations: ordered(conversations),
      hours: ordered(hours).map(([key, tokens]) => {
        const [day, hour] = key.split("\u0000");
        return [day!, Number(hour), tokens] as const;
      }),
      agents: readAgentDays(
        turnRows.map((row) => ({ startedMs: row.started_ms, completedMs: row.completed_ms })),
        timeZone,
      ),
    } satisfies Omit<InsightsUsageSnapshot, "access" | "revision" | "scan">;
  });

  const empty: Omit<InsightsUsageSnapshot, "access" | "revision" | "scan" | "pricing"> = {
    models: [],
    messages: [],
    conversations: [],
    hours: [],
    agents: [],
  };

  type UsageRead = Effect.Success<ReturnType<typeof readUsage>>;
  const usageCache = new Map<
    string,
    {
      readonly usage: UsageRead;
      readonly revision: number;
      readonly computedAtMs: number;
      readonly computeMs: number;
    }
  >();

  /**
   * A read aggregates the whole ledger on the connection live conversations also use. Unchanged
   * numbers are never computed twice, and while a scan keeps changing them the work stays a small
   * share of the Runtime's time however large the ledger has grown.
   */
  const cachedUsage = Effect.fn("UsageLedger.cachedUsage")(function* (
    timeZone: string,
    origin: InsightsOrigin,
  ) {
    const key = `${timeZone}\u0000${origin}`;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(revision);
    const held = usageCache.get(key);
    if (held !== undefined) {
      const unchanged = held.revision === current;
      const scanning = (yield* Ref.get(progress)).state === "scanning";
      if (unchanged) return held.usage;
      if (scanning && !mayRecompute(now - held.computedAtMs, held.computeMs)) return held.usage;
    }
    const usage = yield* readUsage(timeZone, origin);
    const finishedMs = yield* Clock.currentTimeMillis;
    usageCache.set(key, {
      usage,
      revision: current,
      computedAtMs: finishedMs,
      computeMs: finishedMs - now,
    });
    return usage;
  });

  /** Reading is what keeps the ledger fresh while someone is looking at it. */
  const read = Effect.fn("UsageLedger.read")(function* (input: {
    readonly timeZone: string;
    readonly origin: InsightsOrigin;
    readonly sources: readonly InsightsUsageSource[];
  }) {
    const access = yield* readAccess;
    if (access === "granted") {
      yield* writeMeta(SOURCES_KEY, JSON.stringify(input.sources));
      yield* ensureScan;
      yield* loadRates.pipe(Effect.ignoreCause, Effect.forkIn(options.scope));
    }
    const usage =
      access === "granted"
        ? yield* cachedUsage(input.timeZone, input.origin)
        : { ...empty, pricing: (yield* Ref.get(rates)).status };
    return {
      ...usage,
      access,
      revision: yield* Ref.get(revision),
      scan: yield* Ref.get(progress),
    } satisfies InsightsUsageSnapshot;
  });

  /** Withdrawing access forgets everything read through it. */
  const setAccess = Effect.fn("UsageLedger.setAccess")(function* (granted: boolean) {
    if (granted) {
      yield* writeMeta(HISTORY_ACCESS_KEY, "granted");
    } else {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM usage_ledger_seen`;
          yield* sql`DELETE FROM usage_ledger_messages`;
          yield* sql`DELETE FROM usage_ledger_requests`;
          yield* sql`DELETE FROM usage_ledger_files`;
          yield* sql`DELETE FROM usage_ledger_turns`;
          yield* sql`DELETE FROM usage_ledger_meta`;
        }),
      );
      yield* Ref.set(progress, idle);
      usageCache.clear();
    }
    yield* bump;
    return { access: granted ? ("granted" as const) : ("unset" as const) };
  });

  if (options.background !== false) {
    yield* ensureScan.pipe(
      Effect.ignoreCause,
      Effect.repeat(Schedule.spaced(BACKGROUND_SCAN_INTERVAL)),
      Effect.delay("1 minute"),
      Effect.forkIn(options.scope),
    );
  }

  return { read, setAccess, scanOnce };
});

export type UsageLedger = Effect.Success<ReturnType<typeof make>>;
