import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import type { InsightsUsageSource } from "../../../../src/shared/insights.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { parseRateTable } from "./UsagePricing.ts";
import {
  make,
  mayRecompute,
  readAgentDays,
  selectCandidates,
  transcriptKey,
} from "./UsageLedger.ts";

const TestLayer = Layer.merge(SqlitePersistence.layerMemory, FetchHttpClient.layer);

const rates = parseRateTable({
  "claude-opus-5-5": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
  },
});

const claudeRequest = (id: string, timestamp: string, input = 1000, cached = 0) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: input, cache_read_input_tokens: cached, output_tokens: 10 },
    },
  });
const claudeMessage = (uuid: string, timestamp: string) =>
  JSON.stringify({ type: "user", timestamp, uuid, message: { content: "ship it" } });

const codexLines = (id: string, timestamp: string, input: number) => {
  const usage = {
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: 1,
    total_tokens: input + 1,
  };
  return [
    JSON.stringify({ type: "session_meta", timestamp, payload: { id } }),
    JSON.stringify({ type: "turn_context", timestamp, payload: { model: "gpt-6.1-sol" } }),
    JSON.stringify({ type: "event_msg", timestamp, payload: { type: "task_started" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    }),
  ];
};

const lines = (...values: readonly string[]) => `${values.join("\n")}\n`;

const withLedger = <A, E>(
  use: (input: {
    readonly home: string;
    readonly sources: readonly InsightsUsageSource[];
    readonly ledger: Effect.Success<ReturnType<typeof make>>;
    readonly read: () => Effect.Effect<
      Awaited<Effect.Success<ReturnType<Effect.Success<ReturnType<typeof make>>["read"]>>>,
      unknown
    >;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nodex-usage-ledger-")),
    );
    const scope = yield* Scope.make();
    const ledger = yield* make({ stateDir: home, scope, background: false, rates });
    yield* ledger.setAccess(true);
    const sources: readonly InsightsUsageSource[] = [
      { provider: "claude", home: NodePath.join(home, "claude"), origin: "external" },
      { provider: "codex", home: NodePath.join(home, "codex"), origin: "external" },
    ];
    yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
    const read = () =>
      ledger
        .read({ timeZone: "UTC", origin: "all", sources })
        .pipe(Effect.catchCause((cause) => Effect.die(cause)));
    return yield* use({ home, sources, ledger, read }).pipe(
      Effect.ensuring(Scope.close(scope, { _tag: "Success", value: undefined } as never)),
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }))),
    );
  }).pipe(Effect.provide(TestLayer));

const writeClaude = async (home: string, name: string, content: string) => {
  const directory = NodePath.join(home, "claude", "projects", "-repo");
  await NodeFSP.mkdir(directory, { recursive: true });
  const path = NodePath.join(directory, name);
  await NodeFSP.writeFile(path, content);
  return path;
};

describe("usage ledger", () => {
  it.effect("adds up requests by day and model at list price and counts messages", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeClaude(
            home,
            "a.jsonl",
            lines(
              claudeMessage("u1", "2026-10-31T10:00:00.000Z"),
              claudeRequest("1", "2026-10-31T10:00:01.000Z", 1000, 1000),
              claudeRequest("2", "2026-11-01T10:00:01.000Z", 2000),
            ),
          ),
        );
        yield* ledger.scanOnce;
        const snapshot = yield* read();
        assert.deepEqual(
          snapshot.models.map((row) => [row.day, row.model, row.uncachedInputTokens, row.priced]),
          [
            ["2026-10-31", "claude-opus-5-5", 1000, true],
            ["2026-11-01", "claude-opus-5-5", 2000, true],
          ],
        );
        assert.closeTo(snapshot.models[0]!.costUsd, 1000 * 4e-6 + 1000 * 2e-7 + 10 * 2e-5, 1e-9);
        assert.closeTo(snapshot.models[0]!.cacheSavingsUsd, 1000 * (4e-6 - 2e-7), 1e-9);
        assert.deepEqual(snapshot.messages, [["2026-10-31", 1]]);
        assert.deepEqual(snapshot.conversations, [["2026-10-31", 1]]);
        assert.deepEqual(snapshot.hours, [
          ["2026-10-31", 10, 2010],
          ["2026-11-01", 10, 2010],
        ]);
      }),
    ),
  );

  it.effect("shows new numbers once a scan has finished changing them", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeClaude(home, "a.jsonl", lines(claudeRequest("1", "2026-10-31T10:00:00.000Z"))),
        );
        yield* ledger.scanOnce;
        assert.equal((yield* read()).models[0]?.requests, 1);
        assert.equal((yield* read()).models[0]?.requests, 1);
        yield* Effect.promise(() =>
          writeClaude(home, "b.jsonl", lines(claudeRequest("2", "2026-10-31T10:00:01.000Z"))),
        );
        yield* ledger.scanOnce;
        assert.equal((yield* read()).models[0]?.requests, 2);
      }),
    ),
  );

  it.effect("keeps each reader's calendar and scope apart", () =>
    withLedger(({ home, ledger, sources }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeClaude(home, "a.jsonl", lines(claudeRequest("1", "2026-10-31T18:30:00.000Z"))),
        );
        yield* ledger.scanOnce;
        const utc = yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
        const shanghai = yield* ledger.read({ timeZone: "Asia/Shanghai", origin: "all", sources });
        assert.equal(utc.models[0]?.day, "2026-10-31");
        assert.equal(shanghai.models[0]?.day, "2026-11-01");
      }),
    ),
  );

  it.effect("buckets the same usage into the reader's own calendar", () =>
    withLedger(({ home, ledger, sources }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeClaude(home, "a.jsonl", lines(claudeRequest("1", "2026-10-31T18:30:00.000Z"))),
        );
        yield* ledger.scanOnce;
        const shanghai = yield* ledger.read({ timeZone: "Asia/Shanghai", origin: "all", sources });
        const kolkata = yield* ledger.read({ timeZone: "Asia/Kolkata", origin: "all", sources });
        assert.equal(shanghai.models[0]?.day, "2026-11-01");
        assert.equal(kolkata.models[0]?.day, "2026-11-01");
        assert.equal(kolkata.hours[0]?.[1], 0);
      }),
    ),
  );

  it.effect("counts a request once across a resumed transcript's copy", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        const shared = claudeRequest("shared", "2026-10-31T10:00:00.000Z");
        yield* Effect.promise(() => writeClaude(home, "first.jsonl", lines(shared)));
        yield* Effect.promise(() =>
          writeClaude(
            home,
            "resumed.jsonl",
            lines(shared, shared, claudeRequest("new", "2026-10-31T11:00:00.000Z")),
          ),
        );
        yield* ledger.scanOnce;
        const snapshot = yield* read();
        assert.equal(snapshot.models[0]?.requests, 2);
      }),
    ),
  );

  it.effect("keeps usage after its transcript is deleted", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        const path = yield* Effect.promise(() =>
          writeClaude(home, "old.jsonl", lines(claudeRequest("1", "2026-10-31T10:00:00.000Z"))),
        );
        yield* ledger.scanOnce;
        yield* Effect.promise(() => NodeFSP.rm(path));
        yield* ledger.scanOnce;
        assert.equal((yield* read()).models[0]?.requests, 1);
      }),
    ),
  );

  it.effect("adds only what a growing transcript appended", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        const first = claudeRequest("1", "2026-10-31T10:00:00.000Z");
        const path = yield* Effect.promise(() => writeClaude(home, "a.jsonl", lines(first)));
        yield* ledger.scanOnce;
        yield* Effect.promise(() =>
          NodeFSP.appendFile(path, lines(claudeRequest("2", "2026-10-31T10:00:01.000Z"))),
        );
        yield* ledger.scanOnce;
        assert.equal((yield* read()).models[0]?.requests, 2);
      }),
    ),
  );

  it.effect("replaces a rewritten transcript's numbers instead of adding to them", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeClaude(
            home,
            "a.jsonl",
            lines(
              claudeRequest("1", "2026-10-31T10:00:00.000Z"),
              claudeRequest("2", "2026-10-31T10:00:01.000Z"),
            ),
          ),
        );
        yield* ledger.scanOnce;
        yield* Effect.promise(() =>
          writeClaude(home, "a.jsonl", lines(claudeRequest("9", "2026-10-31T10:00:00.000Z"))),
        );
        yield* ledger.scanOnce;
        assert.equal((yield* read()).models[0]?.requests, 1);
      }),
    ),
  );

  it.effect("treats a rollout Codex compressed as the same transcript", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        const directory = NodePath.join(home, "codex", "sessions", "2026", "10");
        const name = "rollout-2026-10-31-abc.jsonl";
        const content = lines(...codexLines("abc", "2026-10-31T10:00:00.000Z", 500));
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, name), content);
        });
        yield* ledger.scanOnce;
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(directory, `${name}.zst`),
            NodeZlib.zstdCompressSync(Buffer.from(content)),
          );
          await NodeFSP.rm(NodePath.join(directory, name));
        });
        yield* ledger.scanOnce;
        const snapshot = yield* read();
        assert.equal(snapshot.models[0]?.requests, 1);
        assert.deepEqual(snapshot.messages, [["2026-10-31", 1]]);
      }),
    ),
  );

  it.effect("leaves a transcript it could not read to be read again, not counted as empty", () =>
    withLedger(({ home, ledger, read }) =>
      Effect.gen(function* () {
        const directory = NodePath.join(home, "codex", "sessions");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "rollout-bad.jsonl.zst"), "not zstd");
        });
        yield* ledger.scanOnce;
        const first = yield* read();
        assert.equal(first.scan.failedFiles, 1);
        yield* ledger.scanOnce;
        assert.equal((yield* read()).scan.failedFiles, 1);
      }),
    ),
  );

  it.effect("separates Nodex's own homes from other agent history", () =>
    withLedger(({ home, ledger }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await writeClaude(home, "a.jsonl", lines(claudeRequest("1", "2026-10-31T10:00:00.000Z")));
          const directory = NodePath.join(home, "nodex-codex", "sessions");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(directory, "rollout-mine.jsonl"),
            lines(...codexLines("mine", "2026-10-31T10:00:00.000Z", 5)),
          );
        });
        const sources: readonly InsightsUsageSource[] = [
          { provider: "claude", home: NodePath.join(home, "claude"), origin: "external" },
          { provider: "codex", home: NodePath.join(home, "nodex-codex"), origin: "nodex" },
        ];
        yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
        yield* ledger.scanOnce;
        const all = yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
        const nodex = yield* ledger.read({ timeZone: "UTC", origin: "nodex", sources });
        assert.deepEqual(all.models.map((row) => row.provider).sort(), ["claude", "codex"]);
        assert.deepEqual(
          nodex.models.map((row) => row.provider),
          ["codex"],
        );
      }),
    ),
  );

  it.effect("counts a session Nodex ran as its own, wherever the transcript lives", () =>
    withLedger(({ home, ledger, sources }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const payload = JSON.stringify({
          nativeThreadRef: { driver: "claudeAgent", nativeId: "ran-by-nodex" },
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads (
            provider_thread_id, provider, status, updated_at, payload_json
          ) VALUES ('provider-thread', 'claudeAgent', 'open', '2026-10-31T10:00:00.000Z', ${payload})
        `;
        yield* Effect.promise(async () => {
          const timestamp = "2026-10-31T10:00:00.000Z";
          await writeClaude(home, "ran-by-nodex.jsonl", lines(claudeRequest("1", timestamp)));
          await writeClaude(
            home,
            "typed-in-a-terminal.jsonl",
            lines(claudeRequest("2", timestamp)),
          );
          const subagents = NodePath.join(
            home,
            "claude",
            "projects",
            "-repo",
            "ran-by-nodex",
            "subagents",
          );
          await NodeFSP.mkdir(subagents, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(subagents, "agent-1.jsonl"),
            lines(claudeRequest("3", timestamp)),
          );
        });
        yield* ledger.scanOnce;
        const all = yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
        const nodex = yield* ledger.read({ timeZone: "UTC", origin: "nodex", sources });
        assert.equal(all.models[0]?.requests, 3);
        // The session and the subagent working for it, but not the terminal session.
        assert.equal(nodex.models[0]?.requests, 2);
      }),
    ),
  );

  it.effect(
    "shows nothing and reads nothing before access is granted, and forgets on withdrawal",
    () =>
      withLedger(({ home, ledger, read, sources }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeClaude(home, "a.jsonl", lines(claudeRequest("1", "2026-10-31T10:00:00.000Z"))),
          );
          yield* ledger.scanOnce;
          assert.equal((yield* read()).models.length, 1);

          yield* ledger.setAccess(false);
          const after = yield* ledger.read({ timeZone: "UTC", origin: "all", sources });
          assert.equal(after.access, "unset");
          assert.deepEqual(after.models, []);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM usage_ledger_files
        `;
          assert.equal(rows[0]?.n, 0);
        }),
      ),
  );
});

describe("recomputing during a scan", () => {
  it("waits at least a few seconds even when computing is cheap", () => {
    expect(mayRecompute(2_999, 10)).toBe(false);
    expect(mayRecompute(3_000, 10)).toBe(true);
  });

  it("waits longer the longer computing takes", () => {
    expect(mayRecompute(9_999, 500)).toBe(false);
    expect(mayRecompute(10_000, 500)).toBe(true);
  });
});

describe("agent days", () => {
  const at = (time: string) => Date.parse(`2026-10-31T${time}:00.000Z`);

  it("finds the most agents working at one moment", () => {
    const [day] = readAgentDays(
      [
        { startedMs: at("10:00"), completedMs: at("10:30") },
        { startedMs: at("10:10"), completedMs: at("10:20") },
        { startedMs: at("10:15"), completedMs: at("10:40") },
        { startedMs: at("11:00"), completedMs: at("11:30") },
      ],
      "UTC",
    );
    assert.equal(day?.peakAgents, 3);
    assert.equal(day?.turns, 4);
    assert.equal(day?.activeSeconds, (30 + 10 + 25 + 30) * 60);
  });

  it("does not count a turn starting as another ends as overlapping", () => {
    const [day] = readAgentDays(
      [
        { startedMs: at("10:00"), completedMs: at("10:30") },
        { startedMs: at("10:30"), completedMs: at("11:00") },
      ],
      "UTC",
    );
    assert.equal(day?.peakAgents, 1);
  });

  it("excludes a turn that sat waiting for hours", () => {
    assert.deepEqual(
      readAgentDays(
        [{ startedMs: at("00:00"), completedMs: at("00:00") + 7 * 60 * 60 * 1000 }],
        "UTC",
      ),
      [],
    );
  });
});

describe("transcript identity", () => {
  const candidate = (path: string, mtimeMs: number) => ({
    path,
    mtimeMs,
    size: 1,
    provider: "codex" as const,
    origin: "external" as const,
    key: transcriptKey("codex", path),
  });

  it("is one transcript whether plain, compressed or archived", () => {
    const key = transcriptKey("codex", "/h/sessions/2026/rollout-a.jsonl");
    assert.equal(transcriptKey("codex", "/h/sessions/2026/rollout-a.jsonl.zst"), key);
    assert.equal(transcriptKey("codex", "/h/archived_sessions/rollout-a.jsonl"), key);
  });

  it("keeps Claude sessions in different homes apart", () => {
    assert.notEqual(
      transcriptKey("claude", "/a/projects/x/s.jsonl"),
      transcriptKey("claude", "/b/projects/x/s.jsonl"),
    );
  });

  it("reads the newest copy, then the plain file", () => {
    const newest = selectCandidates([
      candidate("/h/sessions/rollout-a.jsonl.zst", 1),
      candidate("/h/archived_sessions/rollout-a.jsonl.zst", 2),
    ]);
    assert.deepEqual(
      newest.map((file) => file.path),
      ["/h/archived_sessions/rollout-a.jsonl.zst"],
    );
    const plain = selectCandidates([
      candidate("/h/sessions/rollout-a.jsonl.zst", 1),
      candidate("/h/sessions/rollout-a.jsonl", 1),
    ]);
    assert.deepEqual(
      plain.map((file) => file.path),
      ["/h/sessions/rollout-a.jsonl"],
    );
  });
});
