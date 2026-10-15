import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No native execution needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  database,
  ProjectStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "project-placement" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "moves an execution root and its queued child atomically without changing identity or workspace",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const oldProject = ProjectId.make("project:old");
      const target = ProjectId.make("project:new");
      const root = ThreadId.make("root");
      const child = ThreadId.make("child");
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("project:new"),
        aggregateKind: "project",
        aggregateId: target,
        occurredAt: "2026-10-14T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: target,
          title: "New",
          workspaceRoot: "/new",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: "2026-10-14T00:00:00.000Z",
          updatedAt: "2026-10-14T00:00:00.000Z",
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:root"),
        threadId: root,
        projectId: oldProject,
        title: "Root",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/old/cwd",
        createdBy: "user",
        creationSource: "web",
      });
      const source = yield* store.getThread(root);
      yield* store.apply({
        type: "thread.created",
        id: EventId.make("child:created"),
        threadId: child,
        occurredAt: now,
        payload: {
          ...source,
          id: child,
          lineage: { parentThreadId: root, relationshipToParent: "subagent", rootThreadId: root },
        },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue:child"),
        threadId: child,
        messageId: MessageId.make("message:child"),
        text: "Queued task",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* store.getProjectExecutionActivity(oldProject);
      assert.equal(before.run?.threadId, child);
      const command = {
        type: "thread.metadata.update" as const,
        commandId: CommandId.make("move:root"),
        threadId: root,
        projectId: target,
      };
      const accepted = yield* orchestrator.dispatch(command);
      assert.deepEqual(yield* orchestrator.dispatch(command), accepted);
      for (const id of [root, child]) {
        const moved = yield* store.getThread(id);
        assert.equal(moved.projectId, target);
        assert.equal(moved.id, id);
        assert.equal(moved.lineage.rootThreadId, root);
        assert.equal(moved.worktreePath, "/old/cwd");
      }
      assert.equal((yield* store.getProjectExecutionActivity(oldProject)).run, null);
      assert.equal((yield* store.getProjectExecutionActivity(target)).run?.threadId, child);
      assert.deepEqual((yield* store.getProjectRoots(target)).threadIds, [root]);
      assert.deepEqual((yield* store.getProjectRoots(oldProject)).threadIds, []);
      assert.equal(
        (yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("missing-project"),
            projectId: ProjectId.make("missing"),
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* orchestrator
          .dispatch({ ...command, commandId: CommandId.make("child-project"), threadId: child })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT thread_id FROM orchestration_v2_projection_threads WHERE json_extract(payload_json,'$.lineage.rootThreadId') = ${root}`;
      assert.isTrue(
        plan.some(
          (row) =>
            row.detail.startsWith("SEARCH orchestration_v2_projection_threads USING ") &&
            row.detail.includes("INDEX ") &&
            row.detail.includes("(<expr>=?)"),
        ),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => row.detail.startsWith("SCAN orchestration_v2_projection_threads")),
        JSON.stringify(plan),
      );
    }).pipe(Effect.provide(layer)),
);
