import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ChatAttachmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
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
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "queue-window" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "pages the complete queued roster without parsing bodies and keeps continuation bound to its Thread",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("queue-root");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:queue"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Queue",
        modelSelection: { instanceId, model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        createdBy: "user",
        creationSource: "web",
      });
      for (let index = 0; index < 31; index += 1)
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queue:${index}`),
          threadId,
          messageId: MessageId.make(`message:${index}`),
          text: `Queued ${index} ${"body".repeat(1000)}`,
          attachments:
            index === 6
              ? [
                  {
                    type: "image",
                    id: ChatAttachmentId.make("queue-image"),
                    name: "Queue.png",
                    mimeType: "image/png",
                    sizeBytes: 10,
                  },
                ]
              : [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      const parse = vi.spyOn(JSON, "parse");
      let first: ProjectionStore.ProjectionQueuedRunPage;
      try {
        first = yield* store.getQueuedRunPage(threadId);
        assert.equal(parse.mock.calls.length, 0);
      } finally {
        parse.mockRestore();
      }
      assert.equal(first.entries.length, 25);
      assert.isNotNull(first.nextCursor);
      assert.isNotNull(first.nextRunId);
      const firstRun = RunId.make(first.entries[0]!.runId);
      const previewParse = vi.spyOn(JSON, "parse");
      try {
        const preview = yield* store.getQueuedRunPreview(threadId, firstRun);
        assert.equal(previewParse.mock.calls.length, 0);
        assert.equal(preview?.text.length, 2048);
        assert.equal(preview?.messageId, first.entries[0]!.userMessageId);
        assert.isTrue(JSON.stringify(preview).length < 2300);
        assert.isNull(yield* store.getQueuedRunPreview(ThreadId.make("foreign"), firstRun));
        const imageRun = first.entries.find((entry) => entry.userMessageId === "message:6");
        assert.isDefined(imageRun);
        const withImage = yield* store.getQueuedRunPreview(threadId, RunId.make(imageRun!.runId));
        assert.deepEqual(withImage?.images, [
          {
            type: "image",
            id: "queue-image",
            name: "Queue.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
      } finally {
        previewParse.mockRestore();
      }

      assert.isTrue(
        (yield* store.getRunUserMessage(threadId, firstRun))!.text.startsWith(
          `Queued ${first.entries[0]!.userMessageId.slice("message:".length)} `,
        ),
      );
      assert.isNull(yield* store.getRunUserMessage(ThreadId.make("foreign"), firstRun));
      const second = yield* store.getQueuedRunPage(threadId, first.nextCursor!);
      assert.equal(second.entries.length, 5);
      assert.equal(second.entries[0]?.runId, first.nextRunId);
      assert.isNull(second.nextCursor);
      assert.equal(
        new Set([...first.entries, ...second.entries].map((entry) => entry.runId)).size,
        30,
      );
      assert.isTrue(JSON.stringify(first).length < 20_000);
      assert.equal(
        (yield* store
          .getQueuedRunPage(ThreadId.make("another"), first.nextCursor!)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT run_id FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY COALESCE(json_extract(payload_json, '$.queuePosition'),ordinal),ordinal,run_id LIMIT 26`;
      assert.isTrue(plan.some((row) => row.detail.includes("queued_run_window_idx")));
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        threadId,
        commandId: CommandId.make("edit:queued"),
        runId: firstRun,
        text: "Edited queued message",
      });
      assert.equal(
        (yield* store.getRunUserMessage(threadId, firstRun))?.text,
        "Edited queued message",
      );
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        threadId,
        commandId: CommandId.make("cancel:queued"),
        runId: firstRun,
      });
      const remaining = yield* store.getQueuedRunPage(threadId);
      assert.isFalse(remaining.entries.some((entry) => entry.runId === firstRun));
    }).pipe(Effect.provide(layer)),
);
