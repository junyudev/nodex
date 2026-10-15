import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ProviderSessionId,
  RunAttemptId,
  ContextHandoffId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerDatabase = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["sqlite", "memory"] as const)(
  "loads startup state without obsolete transcript payloads in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:completion-reads");
      const runId = RunId.make("run:completion-reads");
      const messageId = MessageId.make("message:completion-reads");
      const instanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:completion-reads"),
        title: "Completion controls",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: NodeId.make("startup:root"),
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const putThread = (value: OrchestrationV2AppThread) =>
        store.apply({
          id: EventId.make(`event:thread:${value.id}`),
          type: "thread.created",
          threadId: value.id,
          occurredAt: now,
          payload: value,
        });
      const putRun = (value: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:run:${value.id}:${value.status}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      yield* putThread(thread);
      yield* putRun(run);
      const scopeId = CheckpointScopeId.make("startup:shared-scope");
      yield* store.apply({
        id: EventId.make("startup:root-event"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: run.rootNodeId!,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: run.rootNodeId!,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("startup:scope-event"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:old"),
          nodeId: NodeId.make("startup:earlier-root"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      const message = {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Continue",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "server" as const,
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      };
      yield* store.apply({
        id: EventId.make("event:input"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      });
      const oldRunId = RunId.make("run:old");
      yield* putRun({ ...run, id: oldRunId, ordinal: 1, status: "completed" });
      const item = {
        id: TurnItemId.make("item:history"),
        threadId,
        runId: oldRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "old command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo history",
        output: "historical result",
      };
      yield* store.apply({
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: item,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0,
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            type, status, ordinal, updated_at, payload_json)
          VALUES ('obsolete-tool', ${threadId}, ${oldRunId}, NULL, NULL, NULL,
            'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const selected = yield* store.getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageIds: [messageId],
      });
      assert.deepEqual(Object.keys(selected).sort(), ["messages", "runs", "thread"]);
      assert.deepEqual(
        selected.runs.map((r) => r.id),
        [runId],
      );
      assert.deepEqual(
        selected.messages.map((m) => m.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: oldRunId,
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: runId,
        })).turnItems,
        [],
      );
      assert.equal(yield* store.getNextTurnItemOrdinal(threadId), storage === "sqlite" ? 3 : 2);
      assert.equal(yield* store.getMessageCount(threadId), storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], {
          messageRunIds: [runId],
        })).messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageRunIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunIds: [oldRunId],
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], { turnItemRunIds: [] })).turnItems,
        [],
      );
      assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), []);
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_object('text', ${"x".repeat(512_000)}, 'attachments', json_array(json_object('id', 'attachment:old'))) WHERE message_id = 'obsolete-history'`;
        assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), ["attachment:old"]);
      }
      const page = yield* store.getTimelinePage(threadId, { view: "activity", limit: 1 });
      assert.deepEqual(
        page.items.map((row) => row.item),
        [item],
      );
      assert.equal(page.hasMore, storage === "sqlite");
      assert.equal(page.totalItems, storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getTimelinePage(threadId, { view: "messages", limit: 1 })).items,
        [],
      );
      const context = yield* store.getTurnStartContext(threadId, runId);
      assert.equal(context.thread.id, threadId);
      assert.deepEqual(
        context.checkpointScopes.map((scope) => scope.id),
        [scopeId],
      );
      assert.equal(context.messages.find((m) => m.id === messageId)?.text, "Continue");
      assert.isTrue(context.hasConversation);
      assert.deepEqual(context.turnItems, []);
      const history = yield* store.getHandoffHistory({
        threadId,
        budget: 16000,
        runIds: [oldRunId],
      });
      assert.deepEqual(
        history.history.messages.map((m) => m.itemId),
        [item.id],
      );
      assert.equal(
        (yield* store.getHandoffHistory({ threadId, budget: 16000, runIds: [runId] }))
          .sourceItemCount,
        0,
      );
      assert.equal(
        (yield* store.getHandoffHistory({ threadId, budget: 16000, runIds: [] })).sourceItemCount,
        0,
      );
      // Pairing depends on IDs, not payload decoding or item status.
      const resultId = TurnItemId.make("interrupt-result");
      assert.isTrue(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, resultId, item.id));
      assert.isFalse(
        yield* store.hasUnpairedRunInterruptRequest(
          ThreadId.make("other-thread"),
          item.id,
          resultId,
        ),
      );
      yield* store.apply({
        id: EventId.make("interrupt-result-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: { ...item, id: resultId },
      });
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        const original = yield* sql<{ payload_json: string }>`SELECT payload_json
          FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = 'invalid JSON' WHERE turn_item_id = ${item.id}`;
        assert.isTrue(
          yield* store.hasUnpairedRunInterruptRequest(
            threadId,
            item.id,
            TurnItemId.make("absent-result"),
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${original[0]!.payload_json} WHERE turn_item_id = ${item.id}`;
      }
      for (const text of ["/compact", " \t/COMPACT\n", "\u00a0/compact\u3000"]) {
        yield* store.apply({
          id: EventId.make("compact-input"),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...message, text },
        });
        assert.isFalse((yield* store.getTurnStartContext(threadId, runId)).hasConversation);
      }
      const marker = {
        ...message,
        id: MessageId.make("old-compact"),
        runId: oldRunId,
        text: "\t/COMPACT\n",
      };
      yield* store.apply({
        id: EventId.make("old-compact-input"),
        type: "message.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: marker,
      });
      assert.isFalse((yield* store.getTurnStartContext(threadId, runId)).hasConversation);
      const other = ThreadId.make("other");
      yield* putThread({ ...thread, id: other });
      assert.deepEqual((yield* store.getTurnStartContext(other, runId)).messages, []);
      assert.equal(
        (yield* store.getHandoffHistory({ threadId: other, budget: 16000, runIds: [oldRunId] }))
          .sourceItemCount,
        0,
      );
      assert.isFalse((yield* store.getTurnStartContext(other, runId)).hasConversation);
      assert.instanceOf(
        yield* store.getTurnStartContext(ThreadId.make("missing"), runId).pipe(Effect.flip),
        ProjectionStore.ProjectionStoreThreadNotFoundError,
      );

      // Same-native acceptance, restart delivery and missing-input proofs survive
      // sparse startup cohorts; previous attempts remain authoritative after steer.
      yield* store.apply({
        id: EventId.make("native-proof:input"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: message,
      });
      const providerId = ProviderThreadId.make("startup:provider");
      const sourceAttemptId = RunAttemptId.make("startup:accepted");
      const missingAttemptId = RunAttemptId.make("startup:unaccepted");
      const work = Array.from({ length: 25 }, (_, index) => ({
        kind: "shell" as const,
        label: `sleep ${index}`,
      }));
      const source = {
        ...run,
        id: oldRunId,
        ordinal: 1,
        providerThreadId: providerId,
        status: "completed" as const,
        activeAttemptId: sourceAttemptId,
        completedAt: now,
        restartCancelledBackgroundWork: work,
      };
      const current = { ...run, providerThreadId: providerId, status: "starting" as const };
      yield* putRun(source);
      yield* putRun(current);
      const note = (yield* store.getTurnStartContext(threadId, runId)).restartNoteState;
      assert.equal(note.totalWork, 25);
      assert.deepEqual(note.work, work.slice(0, 10));
      yield* putRun({ ...current, restartContinuationOfRunId: source.id });
      assert.isTrue(
        (yield* store.getTurnStartContext(threadId, runId)).restartNoteState.continuation,
      );
      yield* putRun(current);
      const sourceAttempt = {
        id: sourceAttemptId,
        runId: oldRunId,
        attemptOrdinal: 1,
        rootNodeId: run.rootNodeId!,
        providerInstanceId: instanceId,
        providerThreadId: providerId,
        providerTurnId: null,
        reason: "initial" as const,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      yield* store.apply({
        id: EventId.make("native-proof:attempt"),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: sourceAttempt,
      });
      yield* store.apply({
        id: EventId.make("native-proof:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("startup:turn"),
          providerThreadId: providerId,
          nodeId: run.rootNodeId!,
          runAttemptId: sourceAttemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      const nativeProof = {
        threadId,
        providerThreadId: providerId,
        nativeThreadId: "native:old",
        sameNativeThread: true,
      };
      assert.isTrue(yield* store.hasNativeTurns(nativeProof));
      assert.isFalse(yield* store.hasNativeTurns({ ...nativeProof, sameNativeThread: false }));
      yield* store.apply({
        id: EventId.make("native-proof:identified"),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: { ...sourceAttempt, nativeThreadId: "native:old" },
      });
      assert.isTrue(yield* store.hasNativeTurns({ ...nativeProof, sameNativeThread: false }));
      assert.isFalse(yield* store.hasNativeTurns({ ...nativeProof, nativeThreadId: "native:new" }));
      const nativeItem = { ...item, providerThreadId: providerId };
      yield* store.apply({
        id: EventId.make("native-proof:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: nativeItem,
      });
      const estimateInput = {
        threadId,
        runId,
        providerThreadId: providerId,
        nativeThreadId: "native:old",
      };
      const textBytes = Buffer.byteLength(
        "Command: echo history\nExit code: unknown\nhistorical result",
      );
      assert.equal(yield* store.getNativeContextEstimate(estimateInput), textBytes);
      yield* putRun({ ...source, status: "failed", activeAttemptId: missingAttemptId });
      assert.equal(yield* store.getNativeContextEstimate(estimateInput), 0);
      const retryInput = {
        threadId,
        budget: 16000,
        runStatuses: ["failed"] as const,
        missingFromProviderThreadId: providerId,
      };
      assert.deepEqual(
        (yield* store.getHandoffHistory(retryInput)).history.messages
          .map((m) => m.itemId)
          .toSorted(),
        [item.id, resultId].toSorted(),
      );
      const handoff = {
        id: ContextHandoffId.make("startup:delivered"),
        threadId,
        targetRunId: oldRunId,
        fromProviderThreadIds: [providerId],
        toProviderThreadId: providerId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary" as const,
        status: "ready" as const,
        summaryMessageId: null,
        summaryText: "Delivered context",
        createdByProviderInstanceId: instanceId,
        createdAt: now,
        updatedAt: now,
        delivery: { nativeThreadId: "native:old", status: "inline" as const, itemIds: [item.id] },
      };
      yield* store.apply({
        id: EventId.make("native-proof:handoff"),
        type: "context-handoff.updated",
        threadId,
        occurredAt: now,
        payload: handoff,
      });
      assert.equal(yield* store.getNativeContextEstimate(estimateInput), textBytes);
      assert.deepEqual(
        yield* store.getDeliveredHandoffItemIds({
          ...nativeProof,
          itemIds: [item.id, TurnItemId.make("foreign")],
        }),
        [item.id],
      );
      assert.deepEqual(
        (yield* store.getHandoffHistory({
          ...retryInput,
          excludeDelivered: { providerThreadId: providerId, nativeThreadId: "native:old" },
        })).history.messages.map((m) => m.itemId),
        [resultId],
      );
      const nativeChild = {
        id: NodeId.make("startup:child-task"),
        threadId,
        runId: oldRunId,
        parentNodeId: run.rootNodeId!,
        origin: "provider_native" as const,
        createdBy: "agent" as const,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("startup:child"),
        nativeTaskRef: null,
        prompt: "Earlier native work",
        title: null,
        model: null,
        status: "completed" as const,
        result: "Done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("native-proof:child"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: nativeChild,
      });
      const childRoute = {
        ...nativeProof,
        providerSessionId: ProviderSessionId.make("startup:session"),
        address: { threadId: nativeChild.childThreadId },
      };
      assert.deepEqual(yield* store.getRelatedNativeThread(childRoute), {
        subagentId: nativeChild.id,
        threadId: nativeChild.childThreadId,
        providerThreadId: null,
        sourceRunId: oldRunId,
      });
      assert.isNull(
        yield* store.getRelatedNativeThread({ ...childRoute, nativeThreadId: "native:new" }),
      );
      yield* store.apply({
        id: EventId.make("native-proof:resume-child"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: { ...nativeChild, status: "running", completedAt: null },
      });
      assert.isNull(yield* store.getRelatedNativeThread(childRoute));
      assert.deepEqual(
        yield* store.getRelatedNativeThread({
          ...childRoute,
          address: { subagentId: nativeChild.id },
        }),
        {
          subagentId: nativeChild.id,
          threadId: nativeChild.childThreadId,
          providerThreadId: null,
          sourceRunId: oldRunId,
        },
      );
      assert.isNull(
        yield* store.getRelatedNativeThread({
          ...childRoute,
          nativeThreadId: "native:new",
          address: { subagentId: nativeChild.id },
        }),
      );
      yield* store.apply({
        id: EventId.make("native-proof:app-child"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: { ...nativeChild, origin: "app_owned" },
      });
      assert.isNull(yield* store.getRelatedNativeThread(childRoute));
      assert.isNull(
        yield* store.getRelatedNativeThread({
          ...childRoute,
          address: { subagentId: nativeChild.id },
        }),
      );
      if (storage === "sqlite") {
        // Explicit storage pressure accompanies the public worker integration case.
        const sql = yield* SqlClient.SqlClient;
        const coldText = "cold-handoff:" + "x".repeat(32768);
        yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
          INSERT INTO orchestration_v2_projection_context_handoffs
          (context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json)
          SELECT 'cold-handoff:'||value,${threadId},${oldRunId},${providerId},'full_thread_summary','ready',${DateTime.formatIso(now)},
            json_remove(json_set(payload_json,'$.id','cold-handoff:'||value,'$.summaryText',${coldText}),'$.delivery')
            FROM n,orchestration_v2_projection_context_handoffs WHERE context_handoff_id=${handoff.id}`;
        yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
          INSERT INTO orchestration_v2_projection_subagents
          (subagent_id,thread_id,run_id,parent_node_id,provider,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
          SELECT 'cold-child:'||value,${threadId},${oldRunId},${run.rootNodeId},'codex',NULL,'cold-child-thread:'||value,'app_owned','completed',NULL,NULL,${DateTime.formatIso(now)},
            json_set(payload_json,'$.id','cold-child:'||value,'$.prompt',${"x".repeat(65536)},'$.result',${"x".repeat(65536)})
            FROM n,orchestration_v2_projection_subagents WHERE subagent_id=${nativeChild.id}`;
        let coldBodies = 0;
        let coldBytes = 0;
        let conversationBodies = 0;
        let conversationBytes = 0;
        const originalParse = JSON.parse;
        const parse = vi.spyOn(JSON, "parse").mockImplementation((text, ...rest) => {
          if (typeof text === "string" && text.includes('"summaryText":"cold-handoff:')) {
            coldBodies++;
            coldBytes += Buffer.byteLength(text);
          }
          if (typeof text === "string" && text.startsWith('{"label":"Assistant","body":')) {
            conversationBodies++;
            conversationBytes += Buffer.byteLength(text);
          }
          return originalParse(text, ...rest);
        });
        try {
          const startup = yield* store.getTurnStartContext(threadId, runId);
          assert.deepEqual(startup.subagents, []);
          assert.isAtMost(coldBodies, 8);
          assert.isAtMost(coldBytes, 262144);
          assert.equal(startup.omittedHandoffCount, 1001 - startup.contextHandoffs.length);
          assert.isAtMost(startup.runs.length, 10);
          yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
            INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,historical_text_bytes,native_attachment_allowance,payload_json)
            SELECT 'cold-summary:'||value,${threadId},NULL,NULL,NULL,NULL,NULL,10000+value,'assistant_message','completed',${DateTime.formatIso(now)},65568,0,
              json_set(payload_json,'$.id','cold-summary:'||value,'$.runId',NULL,'$.text',${"EARLIEST_SUMMARY_MARKER " + "x".repeat(65536)}||' LATEST_SUMMARY_MARKER:'||value)
              FROM n,orchestration_v2_projection_turn_items WHERE turn_item_id=${item.id}`;
          const summary = yield* store.getHandoffHistory({
            threadId,
            runIds: [],
            includeImported: true,
            includeConversationSummary: true,
            budget: 16000,
          });
          assert.lengthOf(summary.conversationSummary?.sections ?? [], 1);
          assert.include(
            summary.conversationSummary!.sections[0]!.body,
            "LATEST_SUMMARY_MARKER:1000",
          );
          assert.notInclude(
            summary.conversationSummary!.sections[0]!.body,
            "EARLIEST_SUMMARY_MARKER",
          );
          assert.equal(summary.conversationSummary?.omittedItems, 999);
          assert.equal(summary.conversationSummary?.truncatedItems, 1);
          assert.lengthOf(summary.history.messages, 0);
          assert.equal(summary.history.omittedItems, 1000);
          assert.include(summary.history.coverage, "cold-summary:1 through cold-summary:1000");
          assert.equal(conversationBodies, 1);
          assert.isAtMost(conversationBytes, 262144);
        } finally {
          parse.mockRestore();
        }
      }
      yield* putRun(source);
      const sourceProvider: OrchestrationV2ProviderThread = {
        id: providerId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make("startup:session"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native:old",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const putProvider = (payload: OrchestrationV2ProviderThread) =>
        store.apply({
          id: EventId.make("fork-proof:provider"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload,
        });
      yield* putProvider(sourceProvider);
      const sourceTurn: OrchestrationV2ProviderTurn = {
        id: ProviderTurnId.make("startup:turn"),
        providerThreadId: providerId,
        nodeId: run.rootNodeId!,
        runAttemptId: sourceAttemptId,
        nativeTurnRef: {
          driver: sourceProvider.driver,
          nativeId: "msg_source",
          strength: "strong",
        },
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
      };
      const putTurn = (payload: OrchestrationV2ProviderTurn) =>
        store.apply({
          id: EventId.make(`fork-proof:${payload.id}`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload,
        });
      yield* putTurn(sourceTurn);
      for (const [ordinal, nativeId] of [
        [2, "msg_rejected"],
        [3, "native:old:wake:continuation"],
        [4, "msg_present"],
      ] as const) {
        yield* putTurn({
          ...sourceTurn,
          id: ProviderTurnId.make(`fork:later:${ordinal}`),
          runAttemptId: null,
          ordinal,
          nativeTurnRef: { ...sourceTurn.nativeTurnRef!, nativeId },
        });
      }
      const selector = {
        nativeTurnIds: ["msg_source", "msg_present"],
        promptPrefix: "msg_",
        continuationMarker: ":wake:",
      };
      assert.deepEqual(
        (yield* store.getNativeForkBoundary(
          threadId,
          oldRunId,
          selector,
        )).followingProviderTurns.map((t) => t.id),
        ["fork:later:4"],
      );
      yield* putTurn({
        ...sourceTurn,
        id: ProviderTurnId.make("fork:legacy"),
        runAttemptId: null,
        ordinal: 5,
        nativeTurnRef: { ...sourceTurn.nativeTurnRef!, nativeId: "native:legacy:attempt" },
      });
      assert.deepEqual(
        (yield* store.getNativeForkBoundary(
          threadId,
          oldRunId,
          selector,
        )).followingProviderTurns.map((t) => t.id),
        ["fork:later:4", "fork:legacy"],
      );
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
          INSERT INTO orchestration_v2_projection_provider_turns
          (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json)
          SELECT 'fork:cold:'||value,${threadId},${providerId},${run.rootNodeId},NULL,100+value,'completed',
            json_set(payload_json,'$.id','fork:cold:'||value,'$.runAttemptId',NULL,'$.ordinal',100+value,'$.nativeTurnRef.nativeId','msg_cold:'||value)
          FROM n,orchestration_v2_projection_provider_turns WHERE provider_turn_id=${sourceTurn.id}`;
        let decodedTurns = 0;
        const originalParse = JSON.parse;
        const parse = vi.spyOn(JSON, "parse").mockImplementation((text, ...rest) => {
          if (typeof text === "string" && text.includes('"nativeTurnRef"')) {
            decodedTurns++;
            assert.notInclude(text, "fork:cold:");
          }
          return originalParse(text, ...rest);
        });
        try {
          const boundary = yield* store.getNativeForkBoundary(threadId, oldRunId, selector);
          assert.lengthOf(boundary.followingProviderTurns, 2);
          assert.isAtMost(decodedTurns, 3);
          assert.equal(boundary.rollbackTurnCount, 1004);
        } finally {
          parse.mockRestore();
        }
      }
      yield* putProvider({
        ...sourceProvider,
        nativeThreadRef: { ...sourceProvider.nativeThreadRef!, nativeId: "native:new" },
      });
      const reboundBoundary = yield* store.getNativeForkBoundary(threadId, oldRunId, selector);
      assert.isFalse(reboundBoundary.nativeIncarnationMatches);
      assert.isNull(reboundBoundary.providerThread);
      assert.deepEqual(reboundBoundary.followingProviderTurns, []);
    }).pipe(
      Effect.provide(
        storage === "sqlite"
          ? layerDatabase
          : Layer.merge(SqlitePersistence.layerMemory, ProjectionStore.layerMemory),
      ),
    ),
);
