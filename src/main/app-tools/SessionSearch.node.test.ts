import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { createHash } from "node:crypto";
import { AgentRuntimeApplicationError } from "../agent-runtime/AgentRuntimeApplication";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { SessionDiscoveryError } from "./SessionDiscovery";
import * as Schema from "effect/Schema";
import { makeSessionSearch, type SessionSearchInput } from "./SessionSearch";

const at = "2026-10-01T00:00:00.000Z";
type Fact = AgentRuntimeOperations["sessions.search"]["output"]["items"][number];
const item = (
  id: string,
  title = "Other subject",
  options: { project?: string; native?: string; unbound?: boolean; opens?: number } = {},
) => ({
  cursor: id,
  task: {
    session: {
      id,
      project_id: options.project ?? "project:a",
      created_at: at,
      display_title: title,
      pinned: false,
      archived: false,
      ...(options.native || options.unbound
        ? {}
        : { execution_ref: { runtime_id: "runtime", thread_id: id } }),
    },
    thread: options.native
      ? {
          thread_id: id,
          execution_host_id: options.native,
          backend_binding: { kind: "codex" },
          status: { status_type: "idle", active_flags: [] },
        }
      : null,
  },
  project_name: "Project A",
  direct_section_id: null,
  project_section_id: null,
  project_pinned: false,
  opens: options.opens === undefined ? null : { opened_at: Date.parse(at), score: options.opens },
});
type Item = ReturnType<typeof item>;
const fact = (id: string, changes: Partial<Fact> = {}): Fact => ({
  threadId: id,
  itemId: `item:${id}`,
  messageId: `message:${id}`,
  runId: `run:${id}`,
  source: "user",
  snippet: `needle ${id}`,
  messageAt: at,
  cursor: "private",
  quality: 1,
  hits: 1,
  contentVersion: createHash("sha256").update(id).digest("base64url"),
  ...changes,
});
const meta = (id: string) =>
  ({
    threadId: id,
    createdAt: at,
    preview: "Prompt",
    recencyAt: at,
    latestUserAuthoredMessageAt: at,
    updatedAt: at,
    activeRunId: null,
    worktreePath: null,
    titleRegeneration: null,
    createdBy: "agent",
    creationSource: "mcp",
    runtimeMode: "full-access",
    interactionMode: "default",
    latestRunId: "run",
    runStatus: "completed",
    activityRunStatus: null,
    providerInstanceId: "codex",
    providerDriver: "codex",
    model: "model",
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: id,
    branch: null,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    pullRequests: [],
    itemCount: 10,
    itemCountCoverage: "complete",
  }) as const;
const input: SessionSearchInput = { query: "needle", archived: false, limit: 5 };
const fixture = (initial: Item[], facts: Fact[] = []) =>
  Effect.gen(function* () {
    let rows = initial,
      body = facts,
      runtimeFailed = false,
      metadataFailed = false,
      failedHost: string | null = null;
    const nativeActivity = new Map<string, string>();
    let generation = 1;
    let sourceFailure: AgentRuntimeApplicationError | null = null;
    const scans: Array<{ threadIds?: readonly string[]; cursor?: string }> = [],
      nativeScans: string[] = [],
      resolutions: string[] = [];
    const coreReads: Array<Record<string, unknown>> = [];
    const search = yield* makeSessionSearch({
      core: {
        workspace: {
          read: (request: {
            session_ids?: string[];
            project_id?: string;
            projectless_only?: boolean;
            window: { after?: string; first: number };
          }) =>
            Effect.sync(() => {
              coreReads.push(request);
              const scoped = rows.filter(
                (row) =>
                  (request.project_id === undefined ||
                    row.task.session.project_id === request.project_id) &&
                  (!request.projectless_only || row.task.session.project_id == null),
              );
              const eligible = request.session_ids
                ? scoped.filter((row) => request.session_ids!.includes(row.task.session.id))
                : scoped;
              const offset = request.window.after
                ? eligible.findIndex((row) => row.cursor === request.window.after) + 1
                : 0;
              const selected = eligible.slice(offset, offset + request.window.first);
              return {
                value: {
                  kind: "session_window",
                  search_revision: generation,
                  sessions: {
                    items: selected,
                    next_cursor:
                      offset + selected.length < eligible.length ? selected.at(-1)!.cursor : null,
                  },
                },
              };
            }),
        },
      } as never,
      sessionMetadata: ({ threadIds }) =>
        metadataFailed
          ? Effect.fail(new Error("Metadata offline"))
          : Effect.succeed(threadIds.map(meta)),
      sessionSearch: (request) =>
        Effect.gen(function* () {
          scans.push(request);
          if (sourceFailure) return yield* sourceFailure;
          if (runtimeFailed) return yield* Effect.fail(new Error("Runtime offline"));
          return {
            runtimeId: "runtime",
            generation,
            startCursor: null,
            coverage: "indexed" as const,
            nextCursor: null,
            items: body.filter((row) => request.threadIds?.includes(row.threadId)),
          };
        }),
      sessionSearchResolve: ({ references }) =>
        Effect.gen(function* () {
          if (runtimeFailed) return yield* Effect.fail(new Error("Runtime offline"));
          const items = references.flatMap((ref) =>
            body.filter(
              (row) => row.itemId === ref.itemId && row.contentVersion === ref.contentVersion,
            ),
          );
          resolutions.push(...items.map((row) => row.itemId));
          return { runtimeId: "runtime", generation, items };
        }),
      native: {
        page: ({ hostId, threadId }) =>
          Effect.gen(function* () {
            nativeScans.push(`${hostId}:${threadId}`);
            if (hostId === failedHost) return yield* Effect.fail(new Error("Host offline"));
            return {
              nextCursor: null,
              latestUserMessageAt: nativeActivity.get(threadId) ?? null,
              items: [
                {
                  reference: {
                    itemId: `native:${threadId}`,
                    runId: "native-run",
                    contentVersion: "native-version",
                  },
                  source: "assistant" as const,
                  quality: 1,
                  hits: 1,
                  messageAt: at,
                  snippet: "native needle",
                },
              ],
            };
          }),
        resolve: ({ reference }) =>
          Effect.succeed({
            reference,
            source: "assistant" as const,
            quality: 1,
            hits: 1,
            messageAt: at,
            snippet: "canonical native needle",
          }),
      },
    });
    return {
      search,
      scans,
      nativeScans,
      resolutions,
      coreReads,
      rows: (next: Item[]) => {
        rows = next;
        generation++;
      },
      facts: (next: Fact[]) => {
        body = next;
        generation++;
      },
      runtimeFailed: (failed: boolean) => {
        runtimeFailed = failed;
      },
      metadataFailed: (failed: boolean) => {
        metadataFailed = failed;
      },
      failedHost: (host: string | null) => {
        failedHost = host;
      },
      churn: () => {
        generation++;
      },
      nativeActivity: (threadId: string, at: string) => {
        nativeActivity.set(threadId, at);
      },
      sourceFailure: (failure: AgentRuntimeApplicationError) => {
        sourceFailure = failure;
      },
    };
  });

it.effect(
  "returns canonical historical item coordinates and replays admitted output without rescanning",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture([item("old")], [fact("old", { source: "assistant" })]);
        const first = yield* f.search({ ...input, limit: 1 });
        assert.equal(first.state, "ready");
        assert.equal(first.matches[0]?.itemId, "item:old");
        assert.equal(first.matches[0]?.sourceThreadId, "old");
        assert.equal(first.matches[0]?.session.binding?.kind, "runtime");
        assert.equal(first.matches[0]?.source, "assistant");
        assert.equal(first.nextCursor, null);
        const replay = yield* f.search({ ...input, limit: 1, cursor: first.entryCursors[0] });
        assert.isEmpty(replay.matches);
        assert.equal(f.scans.length, 1);
      }),
    ),
);

it.effect(
  "surfaces permanent producer cursor failures instead of retaining an unrecoverable retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture([item("root")], [fact("root")]);
        f.sourceFailure(
          new AgentRuntimeApplicationError({
            operation: "session-search",
            message: "Pending source changed",
            cursorReason: "cursor_stale",
          }),
        );
        const result = yield* f.search(input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.isTrue(Schema.is(SessionDiscoveryError)(result.failure));
          if (Schema.is(SessionDiscoveryError)(result.failure))
            assert.equal(result.failure.reason, "cursor_stale");
        }
      }),
    ),
);

it.effect(
  "checks selected metadata and body versions without invalidating unrelated query facts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture([item("a", "needle"), item("b", "needle")]);
        const page = yield* f.search({ ...input, limit: 2 });
        f.rows([item("a", "needle"), item("b", "Changed subject")]);
        assert.equal(
          (yield* f.search({ ...input, cursor: page.entryCursors[0] }).pipe(Effect.result))._tag,
          "Failure",
        );
        const g = yield* fixture([item("a"), item("b")], [fact("a"), fact("b")]);
        const body = yield* g.search({ ...input, limit: 1 });
        g.facts([fact("a"), fact("b", { contentVersion: "changed" })]);
        assert.equal(
          (yield* g.search({ ...input, cursor: body.nextCursor! }).pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect("orders body quality before frequency and applies usage only within quality", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture(
        [item("weak"), item("frequent"), item("used", "Other", { opens: 100 }), item("plain")],
        [
          fact("weak", { quality: 0.8, hits: 1000 }),
          fact("frequent", { hits: 20 }),
          fact("used"),
          fact("plain"),
        ],
      );
      const page = yield* f.search(input);
      const ids = page.matches.map((match) => match.session.sessionId);
      assert.equal(ids.at(-1), "weak");
      assert.equal(ids[0], "frequent");
      assert.isBelow(ids.indexOf("used"), ids.indexOf("plain"));
    }),
  ),
);

it.effect(
  "retains every compact result once across many ranking pages and ignores unrelated activity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ids = Array.from(
          { length: 155 },
          (_, index) => `id:${String(index).padStart(3, "0")}`,
        );
        const f = yield* fixture(
          ids.map((id) => item(id)),
          ids.map((id) => fact(id)),
        );
        let page = yield* f.search({ ...input, limit: 13 });
        const found = page.matches.map((match) => match.session.sessionId);
        const scans = f.scans.length;
        while (page.nextCursor) {
          f.churn();
          page = yield* f.search({ ...input, limit: 13, cursor: page.nextCursor });
          found.push(...page.matches.map((match) => match.session.sessionId));
          assert.isBelow(found.length, 170);
        }
        assert.equal(new Set(found).size, 155);
        assert.equal(found.length, 155);
        assert.equal(scans, 2);
        assert.equal(f.scans.length, scans);
        assert.isTrue(f.scans.every((scan) => scan.threadIds!.length <= 100));
      }),
    ),
);

it.effect("reserves strong body admission beyond the selected metadata pool", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rows = Array.from({ length: 80 }, (_, index) => ({
        ...item(`meta:${index}`, "Other subject"),
        project_name: "Needle",
      }));
      rows.push({ ...item("zzz:old", "Other subject"), project_name: "Needle" });
      const f = yield* fixture(rows, [fact("zzz:old", { hits: 50 })]);
      const page = yield* f.search(input);
      assert.equal(page.matches.length, 5);
      assert.equal(page.matches[4]?.session.sessionId, "zzz:old");
      assert.equal(page.matches[4]?.source, "user");
    }),
  ),
);

it.effect("does not starve body results when callers request one result at a time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture([item("meta", "needle title"), item("body")], [fact("body")]);
      const first = yield* f.search({ ...input, limit: 1 });
      assert.equal(first.matches[0]?.session.sessionId, "body");
      const second = yield* f.search({ ...input, limit: 1, cursor: first.nextCursor! });
      assert.equal(second.matches[0]?.session.sessionId, "meta");
      assert.equal(second.nextCursor, null);
    }),
  ),
);

it.effect("pushes current placement scope into source message admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture(
        [item("here"), item("elsewhere", "needle", { project: "project:b" })],
        [fact("here"), fact("elsewhere")],
      );
      const page = yield* f.search({ ...input, projectId: "project:a" });
      assert.deepEqual(
        page.matches.map((match) => match.session.sessionId),
        ["here"],
      );
      assert.deepEqual(
        f.scans.map((scan) => scan.threadIds),
        [["here"]],
      );
      const changed = yield* f
        .search({ ...input, projectId: "project:b", cursor: page.entryCursors[0] })
        .pipe(Effect.result);
      assert.equal(changed._tag, "Failure");
    }),
  ),
);

it.effect(
  "keeps healthy metadata and Native sources usable during Runtime search failure and recovers the same query",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(
          [
            item("meta", "needle"),
            item("runtime"),
            item("native", "Other subject", { native: "remote" }),
          ],
          [fact("runtime")],
        );
        f.runtimeFailed(true);
        const first = yield* f.search(input);
        assert.equal(first.coverage, "partial");
        assert.deepEqual(
          new Set(first.matches.map((match) => match.session.sessionId)),
          new Set(["meta", "native"]),
        );
        assert.isNotNull(first.nextCursor);
        f.runtimeFailed(false);
        const next = yield* f.search({ ...input, cursor: first.nextCursor! });
        assert.equal(next.coverage, "complete");
        assert.deepEqual(
          next.matches.map((match) => match.session.sessionId),
          ["runtime"],
        );
        assert.equal(f.nativeScans.length, 1);
        assert.equal(next.nextCursor, null);
      }),
    ),
);

it.effect("does not let missing execution metadata block message sources", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture([item("runtime"), item("meta", "needle")], [fact("runtime")]);
      f.metadataFailed(true);
      const first = yield* f.search(input);
      assert.equal(first.coverage, "partial");
      assert.isTrue(first.matches.some((match) => match.itemId === "item:runtime"));
      f.metadataFailed(false);
      const next = yield* f.search({ ...input, cursor: first.nextCursor! });
      assert.equal(next.coverage, "complete");
      assert.equal(f.scans.length, 1);
    }),
  ),
);

it.effect("retains a failed Native host continuation while admitting later hosts fairly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture([
        item("a", "Other", { native: "host:a" }),
        item("b", "Other", { native: "host:b" }),
      ]);
      f.failedHost("host:a");
      const first = yield* f.search(input);
      assert.equal(first.coverage, "partial");
      assert.deepEqual(
        first.matches.map((match) => match.session.sessionId),
        ["b"],
      );
      const retry = yield* f.search({ ...input, cursor: first.nextCursor! });
      assert.equal(retry.coverage, "partial");
      assert.isNotNull(retry.nextCursor);
      f.failedHost(null);
      const recovered = yield* f.search({ ...input, cursor: retry.nextCursor! });
      assert.equal(recovered.coverage, "complete");
      assert.deepEqual(
        recovered.matches.map((match) => match.session.sessionId),
        ["a"],
      );
      assert.equal(f.nativeScans.filter((scan) => scan.startsWith("host:b")).length, 1);
    }),
  ),
);

it.effect(
  "revalidates a selected binding while keeping immutable output positions for envelope retries",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture([item("a", "needle"), item("b", "needle"), item("c", "needle")]);
        const first = yield* f.search({ ...input, limit: 2 });
        const replay = yield* f.search({ ...input, limit: 2, cursor: first.entryCursors[0] });
        assert.equal(replay.matches[0]?.session.sessionId, first.matches[1]?.session.sessionId);
        f.rows([
          item("a", "needle"),
          {
            ...item("b", "needle"),
            task: {
              session: {
                ...item("b").task.session,
                execution_ref: { runtime_id: "runtime", thread_id: "rebound" },
              },
              thread: null,
            },
          },
          item("c", "needle"),
        ]);
        assert.equal(
          (yield* f.search({ ...input, cursor: first.entryCursors[0] }).pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect(
  "expires inactive query resources instead of reconstructing scans from a stale cursor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture([item("a", "needle"), item("b", "needle")]);
        const page = yield* f.search({ ...input, limit: 1 });
        yield* TestClock.adjust("6 minutes");
        const expired = yield* f.search({ ...input, cursor: page.nextCursor! }).pipe(Effect.result);
        assert.equal(expired._tag, "Failure");
        assert.equal(f.scans.length, 1);
      }),
    ),
);

it.effect("uses Native user activity while keeping assistant-only activity unknown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture([
        item("a-assistant", "Other", { native: "host" }),
        item("z-user", "Other", { native: "host" }),
      ]);
      f.nativeActivity("z-user", at);
      const page = yield* f.search(input);
      assert.deepEqual(
        page.matches.map((match) => match.session.sessionId),
        ["z-user", "a-assistant"],
      );
      assert.deepEqual(page.matches[0]?.session.activityEvidence, { at, provenance: "user_role" });
      assert.equal(page.matches[0]?.session.latestUserAuthoredMessageAt, null);
      assert.equal(page.matches[1]?.session.latestUserAuthoredMessageAt, null);
    }),
  ),
);
