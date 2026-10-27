import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { readSessionCatalog } from "./SessionCatalog.ts";

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const fixture = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.fromDateUnsafe(new Date("2026-10-01T00:00:00.000Z"));
  let sequence = 0;
  const apply = (type: string, threadId: ThreadId, payload: unknown) =>
    store.apply({
      id: EventId.make(`catalog:${sequence++}`),
      occurredAt: at,
      type,
      threadId,
      payload,
    } as never);
  const thread = (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) => {
    const threadId = ThreadId.make(id);
    const payload: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project:catalog"),
      title: id,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...overrides,
    };
    return apply("thread.created", threadId, payload).pipe(Effect.as(payload));
  };
  const message = (
    threadId: ThreadId,
    id: string,
    text: string,
    timestamp: string,
    role: "user" | "assistant" = "user",
    createdBy: "user" | "agent" = "user",
  ) => {
    const date = DateTime.fromDateUnsafe(new Date(timestamp));
    const payload: OrchestrationV2ConversationMessage = {
      id: MessageId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      role,
      text,
      createdBy,
      creationSource: "web",
      attachments: [],
      streaming: false,
      createdAt: date,
      updatedAt: date,
    };
    return apply("message.updated", threadId, payload);
  };
  return { at, thread, message, apply };
});

it.effect(
  "orders by conversation activity, searches bounded prompts, and resumes tied pages without history hydration",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const older = yield* f.thread("thread:older");
      const newer = yield* f.thread("thread:newer");
      yield* f.thread("thread:draft");
      yield* f.thread("thread:child", {
        lineage: {
          rootThreadId: older.id,
          parentThreadId: older.id,
          relationshipToParent: "subagent",
        },
      });
      yield* f.message(
        older.id,
        "message:first",
        `二次元 ${"文".repeat(800)}`,
        "2026-10-02T00:00:00.000Z",
      );
      yield* f.message(
        newer.id,
        "message:newer",
        "Fix edit file display",
        "2026-10-03T00:00:00.000Z",
        "user",
        "agent",
      );
      yield* f.message(
        older.id,
        "message:reply",
        "Latest activity",
        "2026-10-04T00:00:00.000Z",
        "assistant",
      );
      yield* f.apply("thread.renamed", newer.id, {
        ...newer,
        title: "Renamed",
        updatedAt: DateTime.fromDateUnsafe(new Date("2026-10-20T00:00:00.000Z")),
      });
      const first = yield* readSessionCatalog({ limit: 1 });
      assert.equal(first.items[0]?.threadId, older.id);
      assert.equal(first.items[0]?.preview.length, 512);
      assert.equal(first.items[0]?.recencyAt, "2026-10-04T00:00:00.000Z");
      const second = yield* readSessionCatalog({ cursor: first.nextCursor!, limit: 1 });
      assert.equal(second.items[0]?.threadId, newer.id);
      assert.equal(second.items[0]?.preview, "Fix edit file display");
      const third = yield* readSessionCatalog({ cursor: second.nextCursor!, limit: 1 });
      assert.equal(third.items[0]?.threadId, "thread:draft");
      assert.equal(third.items[0]?.recencyAt, null);
      assert.equal(third.nextCursor, null);
      const query = yield* readSessionCatalog({ query: "二次元" });
      assert.deepEqual(
        query.items.map((item) => item.threadId),
        [older.id],
      );
      assert.equal(
        (yield* readSessionCatalog({ cursor: first.nextCursor!, query: "different" }).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      const withChildren = yield* readSessionCatalog({ includeSubagents: true });
      const child = withChildren.items.find((item) => item.threadId === "thread:child");
      assert.equal(child?.rootThreadId, older.id);
      assert.equal(child?.parentThreadId, older.id);
      assert.equal(child?.relationshipToParent, "subagent");
      const childScopeCursor = (yield* readSessionCatalog({ includeSubagents: true, limit: 1 }))
        .nextCursor!;
      assert.equal(
        (yield* readSessionCatalog({ cursor: childScopeCursor, includeSubagents: false }).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      // A retained malformed body cannot make the metadata catalog decode a transcript.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = 'invalid'`;
      assert.equal((yield* readSessionCatalog({})).items.length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("uses canonical execution presentation when a running Run has a newer held queue", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const thread = yield* f.thread("thread:held");
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
 VALUES('running',${thread.id},1,'codex','running','2026-10-01T00:00:00Z','{}'),
 ('held',${thread.id},2,'codex','queued','2026-10-02T00:00:00Z','{"queueHeld":true}')`;
    const page = yield* readSessionCatalog(
      {},
      { shell: (threadId) => store.getThreadShell(ThreadId.make(threadId)) },
    );
    assert.equal(page.items[0]?.latestRunId, "running");
    assert.equal(page.items[0]?.runStatus, "running");
    assert.equal(page.items[0]?.activityRunStatus, "running");
    assert.equal(page.items[0]?.status, "active");
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json='{}' WHERE run_id='held'`;
    const unheld = yield* readSessionCatalog(
      {},
      { shell: (threadId) => store.getThreadShell(ThreadId.make(threadId)) },
    );
    assert.equal(unheld.items[0]?.latestRunId, "held");
    assert.equal(unheld.items[0]?.runStatus, "queued");
    assert.equal(unheld.items[0]?.activityRunStatus, "running");
    assert.equal(unheld.items[0]?.status, "active");
  }).pipe(Effect.provide(layer)),
);
