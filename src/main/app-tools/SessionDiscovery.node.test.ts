import { assert, it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import type { ProjectWorkspaceRead } from "../core-client/types";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make } from "./SessionDiscovery";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";

type Item =
  components["schemas"]["CollectionWindow_ProjectWorkspaceSessionListingItem"]["items"][number];
type RuntimeItem = AgentRuntimeOperations["sessions.catalog"]["output"]["items"][number];
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const native = (id: string, day: number, projectId: string | null = "project:a"): Item =>
  ({
    cursor: `core:${id}`,
    task: {
      session: {
        id,
        project_id: projectId,
        created_at: at(day),
        display_title: id,
        pinned: false,
        archived: false,
      },
      thread: {
        thread_id: `thread:${id}`,
        recency_at: Date.parse(at(day)),
        thread_preview: id,
        backend_binding: { kind: "codex" },
        status: { status_type: "idle", active_flags: [] },
      },
    },
    project_name: projectId,
    direct_section_id: null,
    project_section_id: null,
    project_pinned: false,
  }) as never;
const bound = (id: string, threadId: string, projectId = "project:a"): Item => ({
  ...native(id, 1, projectId),
  task: {
    session: {
      ...native(id, 1, projectId).task.session,
      execution_ref: { runtime_id: "runtime", thread_id: threadId },
    },
    thread: null,
  },
});
const runtime = (id: string, day: number): RuntimeItem => ({
  threadId: id,
  title: id,
  preview: `Prompt ${id}`,
  providerInstanceId: "arbitrary-custom-id",
  providerDriver: "claudeAgent",
  model: "model",
  recencyAt: at(day),
  createdAt: at(1),
  latestUserAuthoredMessageAt: null,
  updatedAt: at(1),
  activeRunId: null,
  worktreePath: null,
  titleRegeneration: null,
  status: "idle",
  activeFlags: [],
  cursor: `runtime:${id}`,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  runStatus: null,
  activityRunStatus: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: id,
  branch: null,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  pullRequests: [],
  itemCount: 0,
  itemCountCoverage: "complete",
});
const fixture = (options: {
  native?: readonly Item[];
  runtime?: readonly RuntimeItem[];
  bindings?: readonly Item[];
  runtimePageSize?: number;
  runtimeId?: string;
  unavailable?: "core" | "runtime";
}) => {
  const reads: unknown[] = [];
  const core = {
    workspace: {
      read: (request: ProjectWorkspaceRead) => {
        reads.push(request);
        if (request.kind !== "session_window")
          return Effect.die("Only catalog reads belong to discovery");
        if (request.native_only && options.unavailable === "core")
          return Effect.fail(new Error("Core unavailable"));
        const matching =
          request.execution_refs === undefined || request.execution_refs === null
            ? (options.native ?? [])
            : (options.bindings ?? []).filter((item) =>
                request.execution_refs!.some(
                  (ref) => ref.thread_id === item.task.session.execution_ref?.thread_id,
                ),
              );
        const scoped = matching.filter(
          (item) =>
            (!request.projectless_only || item.task.session.project_id === null) &&
            (request.project_id === undefined ||
              request.project_id === null ||
              item.task.session.project_id === request.project_id),
        );
        const offset = request.window.after
          ? scoped.findIndex((item) => item.cursor === request.window.after) + 1
          : 0;
        const items = scoped.slice(offset, offset + (request.window.first ?? 100));
        return Effect.succeed({
          value: {
            kind: "session_window",
            search_revision: 1,
            sessions: {
              items,
              next_cursor:
                offset + items.length < scoped.length ? (items.at(-1)?.cursor ?? null) : null,
              authority: { projection_revision: 5 },
            },
          },
        });
      },
    },
  } as never as CoreModules["Service"];
  const list = make({
    core,
    sessionCatalog: (input) => {
      if (options.unavailable === "runtime") return Effect.fail(new Error("Runtime unavailable"));
      const rows = (options.runtime ?? []).filter(
        (item) =>
          (input.includeSubagents || item.relationshipToParent !== "subagent") &&
          (!input.query ||
            `${item.title}\n${item.preview}`.toLowerCase().includes(input.query.toLowerCase())),
      );
      const start = input.cursor ? rows.findIndex((item) => item.cursor === input.cursor) + 1 : 0;
      const items = rows.slice(start, start + (options.runtimePageSize ?? input.limit ?? 100));
      return Effect.succeed({
        runtimeId: options.runtimeId ?? "runtime",
        items,
        nextCursor: start + items.length < rows.length ? (items.at(-1)?.cursor ?? null) : null,
      });
    },
  });
  return { list, reads };
};

it.effect(
  "merges owner recency before pagination and supports lossless smaller response budgets",
  () =>
    Effect.gen(function* () {
      const f = fixture({
        native: [native("native:10", 10), native("native:8", 8), native("draft", 1, null)],
        runtime: [runtime("runtime:9", 9), runtime("runtime:7", 7)],
        bindings: [bound("session:9", "runtime:9"), bound("session:7", "runtime:7")],
      });
      const first = yield* f.list({ archived: false, limit: 3 });
      assert.deepEqual(
        first.sessions.map((item) => item.sessionId),
        ["native:10", "session:9", "native:8"],
      );
      const second = yield* f.list({ archived: false, limit: 3, cursor: first.nextCursor! });
      assert.deepEqual(
        second.sessions.map((item) => item.sessionId),
        ["session:7", "draft"],
      );
      assert.equal(second.nextCursor, null);
      const shortened = yield* f.list({
        archived: false,
        limit: 1,
        cursor: first.entryCursors[0]!,
      });
      assert.equal(shortened.sessions[0]?.sessionId, "session:9");
      assert.equal(shortened.sessions[0]?.preview, "Prompt runtime:9");
      assert.equal(shortened.sessions[0]?.backend, "claude");
      const otherProfile = yield* f
        .list({ archived: false, limit: 1, cursor: first.nextCursor! })
        .pipe(
          Effect.provideService(CoreApplicationAgent, { profile_id: "other-profile" } as never),
          Effect.result,
        );
      assert.equal(otherProfile._tag, "Failure");
      const changedRuntime = fixture({ runtimeId: "new-runtime" });
      const oldCursor = yield* changedRuntime
        .list({ archived: false, limit: 1, cursor: first.nextCursor! })
        .pipe(Effect.result);
      assert.equal(oldCursor._tag, "Failure");
    }),
);

it.effect(
  "advances sparse Project filters without emitting older rows ahead of an unread source",
  () =>
    Effect.gen(function* () {
      const f = fixture({
        native: [native("native:4", 4)],
        runtimePageSize: 1,
        runtime: [runtime("other-project", 9), runtime("matching", 8)],
        bindings: [bound("other", "other-project", "project:other"), bound("matching", "matching")],
      });
      const first = yield* f.list({ archived: false, projectId: "project:a", limit: 10 });
      assert.deepEqual(first.sessions, []);
      assert.isString(first.nextCursor);
      const second = yield* f.list({
        archived: false,
        projectId: "project:a",
        limit: 10,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(
        second.sessions.map((item) => item.sessionId),
        ["matching", "native:4"],
      );
      assert.equal(second.nextCursor, null);
      const wrongScope = yield* f
        .list({ archived: false, projectId: "project:other", limit: 10, cursor: first.nextCursor! })
        .pipe(Effect.result);
      assert.equal(wrongScope._tag, "Failure");
      if (wrongScope._tag === "Failure") assert.equal(wrongScope.failure.reason, "invalid_cursor");
    }),
);

it.effect("keeps available source results and explicitly reports the failed source", () =>
  Effect.gen(function* () {
    const nativeOnly = fixture({ native: [native("native", 5)], unavailable: "runtime" });
    const result = yield* nativeOnly.list({ archived: false, limit: 10 });
    assert.equal(result.sessions[0]?.sessionId, "native");
    assert.deepEqual(
      result.sources.map((source) => [source.source, source.availability]),
      [
        ["core", "available"],
        ["runtime", "unavailable"],
      ],
    );
    const runtimeOnly = fixture({
      unavailable: "core",
      runtime: [runtime("runtime", 6)],
      bindings: [bound("bound", "runtime")],
    });
    const available = yield* runtimeOnly.list({ archived: false, limit: 10 });
    assert.equal(available.sessions[0]?.sessionId, "bound");
    assert.equal(available.sources[0]?.availability, "unavailable");
  }),
);

it.effect(
  "enumerates mixed sources exactly once across sparse pages and equal recency coordinates",
  () =>
    Effect.gen(function* () {
      const natives = Array.from({ length: 20 }, (_, index) =>
        native(`native:${String(index).padStart(2, "0")}`, (index % 7) + 1),
      ).sort(
        (left, right) =>
          right.task.thread!.recency_at - left.task.thread!.recency_at ||
          left.task.session.id.localeCompare(right.task.session.id),
      );
      const runtimes = Array.from({ length: 80 }, (_, index) =>
        runtime(`runtime:${String(index).padStart(2, "0")}`, (index % 7) + 1),
      ).sort(
        (left, right) =>
          right.recencyAt!.localeCompare(left.recencyAt!) ||
          left.threadId.localeCompare(right.threadId),
      );
      const bindings = runtimes
        .filter((_, index) => index % 4 === 0)
        .map((item) => bound(item.threadId, item.threadId));
      const expected = [
        ...natives.map((item) => ({
          id: item.task.session.id,
          at: item.task.thread!.recency_at,
          source: "core",
        })),
        ...runtimes
          .filter((item) => bindings.some((binding) => binding.task.session.id === item.threadId))
          .map((item) => ({
            id: item.threadId,
            at: Date.parse(item.recencyAt!),
            source: "runtime",
          })),
      ].sort(
        (left, right) =>
          right.at - left.at ||
          left.source.localeCompare(right.source) ||
          left.id.localeCompare(right.id),
      );
      for (const limit of [1, 9, 50]) {
        const f = fixture({ native: natives, runtime: runtimes, bindings, runtimePageSize: 7 });
        const found: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 150; page++) {
          const result = yield* f.list({
            archived: false,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          found.push(...result.sessions.map((item) => item.sessionId));
          if (result.nextCursor === null) break;
          assert.notEqual(result.nextCursor, cursor);
          cursor = result.nextCursor;
        }
        assert.deepEqual(
          found,
          expected.map((item) => item.id),
        );
      }
    }),
);

it.effect("keeps continuations readable with maximum Unicode filter scopes", () =>
  Effect.gen(function* () {
    const query = "😀".repeat(100);
    const projectId = "漢".repeat(512);
    const recent = {
      ...runtime("root:recent", 9),
      preview: query,
      cursor: JSON.stringify({ version: 1, query, at: at(9), threadId: "root:recent" }),
    };
    const f = fixture({
      native: [
        {
          ...native("older", 2, projectId),
          task: {
            ...native("older", 2, projectId).task,
            thread: { ...native("older", 2, projectId).task.thread!, thread_preview: query },
          },
        },
      ],
      runtime: [recent],
      bindings: [bound("recent", recent.threadId, projectId)],
    });
    const scope = { archived: false, query, projectId, limit: 1 };
    const page = yield* f.list(scope);
    assert.isNotNull(page.nextCursor);
    assert.isTrue(
      sessionObservationSchemas.list_sessions.safeParse({
        query,
        projectId,
        limit: 1,
        cursor: page.nextCursor,
      }).success,
    );
    const next = yield* f.list({ ...scope, cursor: page.nextCursor! });
    assert.equal(next.sessions[0]?.sessionId, "older");
    assert.equal(next.nextCursor, null);
  }),
);

it.effect("discovers renamed Runtime Sessions by Core title and canonical prompt preview", () =>
  Effect.gen(function* () {
    const binding = bound("session:renamed", "root");
    const renamed = {
      ...binding,
      task: {
        ...binding.task,
        session: { ...binding.task.session, display_title: "Renamed illustration work" },
      },
    };
    const f = fixture({
      runtime: [
        { ...runtime("root", 9), title: "Old title", preview: "Original prompt about characters" },
      ],
      bindings: [renamed],
    });
    const byTitle = yield* f.list({ archived: false, query: "ILLUSTRATION", limit: 1 });
    assert.equal(byTitle.sessions[0]?.title, renamed.task.session.display_title);
    const byPreview = yield* f.list({ archived: false, query: "characters", limit: 1 });
    assert.equal(byPreview.sessions[0]?.sessionId, "session:renamed");
    const old = yield* f.list({ archived: false, query: "Old title", limit: 1 });
    assert.deepEqual(old.sessions, []);
    assert.equal(old.nextCursor, null);
  }),
);

it.effect(
  "filters exact execution state while preserving Core metadata and sparse continuation",
  () =>
    Effect.gen(function* () {
      const active = {
        ...runtime("active", 9),
        status: "active" as const,
        runStatus: "waiting" as const,
        settled: false,
        snoozed: false,
      };
      const settled = {
        ...runtime("settled", 8),
        runStatus: "completed" as const,
        settled: true,
        settledAt: at(8),
        snoozed: true,
        snoozedUntil: at(30),
        branch: "feature/search",
      };
      const f = fixture({
        runtime: [active, settled],
        bindings: [bound("session:active", "active"), bound("session:settled", "settled")],
        runtimePageSize: 1,
      });
      const first = yield* f.list({
        archived: false,
        limit: 10,
        statuses: ["completed"],
        settled: true,
        snoozed: true,
      });
      assert.equal(first.sessions.length, 0);
      assert.isNotNull(first.nextCursor);
      const second = yield* f.list({
        archived: false,
        limit: 10,
        statuses: ["completed"],
        settled: true,
        snoozed: true,
        cursor: first.nextCursor!,
      });
      assert.equal(second.sessions[0]?.sessionId, "session:settled");
      assert.equal(second.sessions[0]?.branch, "feature/search");
      assert.equal(second.sessions[0]?.itemCountCoverage, "complete");
      assert.equal(
        (yield* f
          .list({ archived: false, limit: 10, statuses: ["running"], cursor: first.nextCursor! })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }),
);

it.effect("filters canonical running activity even when the presented latest Run is queued", () =>
  Effect.gen(function* () {
    const f = fixture({
      runtime: [
        {
          ...runtime("root", 9),
          status: "active",
          runStatus: "queued",
          activityRunStatus: "running",
          activeRunId: "running",
        },
      ],
      bindings: [bound("session:running", "root")],
    });
    const page = yield* f.list({ archived: false, limit: 20, statuses: ["running"] });
    assert.equal(page.sessions[0]?.sessionId, "session:running");
    assert.equal(page.sessions[0]?.runStatus, "queued");
    assert.equal(page.sessions[0]?.activityRunStatus, "running");
    assert.equal(page.sessions[0]?.status.status_type, "active");
  }),
);

it.effect(
  "discovers child executions through their bound product Session and fences includeSubagents cursors",
  () =>
    Effect.gen(function* () {
      const root = runtime("root", 8);
      const child = {
        ...runtime("child", 10),
        rootThreadId: "root",
        parentThreadId: "root",
        relationshipToParent: "subagent" as const,
      };
      const f = fixture({ runtime: [child, root], bindings: [bound("session:root", "root")] });
      const first = yield* f.list({ archived: false, includeSubagents: true, limit: 1 });
      assert.equal(first.sessions[0]?.sessionId, "session:root");
      assert.deepEqual(first.sessions[0]?.execution, { threadId: "child" });
      assert.equal(first.sessions[0]?.threadId, "child");
      const byChildTitle = yield* f.list({
        archived: false,
        includeSubagents: true,
        limit: 20,
        query: "child",
      });
      assert.deepEqual(
        byChildTitle.sessions.map((session) => [session.sessionId, session.executionTitle]),
        [["session:root", "child"]],
      );
      assert.equal(byChildTitle.sessions[0]?.title, "session:root");
      const second = yield* f.list({
        archived: false,
        includeSubagents: true,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(second.sessions[0]?.execution, { threadId: "root" });
      const roots = yield* f.list({ archived: false, includeSubagents: false, limit: 20 });
      assert.deepEqual(
        roots.sessions.map((session) => session.threadId),
        ["root"],
      );
      const changed = yield* f
        .list({ archived: false, includeSubagents: false, limit: 20, cursor: first.nextCursor! })
        .pipe(Effect.result);
      assert.equal(changed._tag, "Failure");
    }).pipe(Effect.provideService(CoreApplicationAgent, null)),
);

it.effect("a projectless discovery scope excludes Project Sessions before pagination", () =>
  Effect.gen(function* () {
    const f = fixture({ native: [native("project", 10), native("projectless", 1, null)] });
    const page = yield* f.list({ archived: false, scope: "project", limit: 1 });
    assert.deepEqual(
      page.sessions.map((session) => session.sessionId),
      ["projectless"],
    );
    assert.equal(page.nextCursor, null);
    assert.equal(
      f.reads.some(
        (request) =>
          (request as ProjectWorkspaceRead).kind === "session_window" &&
          "projectless_only" in (request as object),
      ),
      true,
    );
  }).pipe(Effect.provideService(CoreApplicationAgent, null)),
);
