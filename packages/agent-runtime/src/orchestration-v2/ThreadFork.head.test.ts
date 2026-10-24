import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "@t3tools/provider-opencode/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CLAUDE_DEFAULT_INSTANCE_ID, CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  ClaudeOrchestratorReplayHarness,
  type ClaudeOrchestratorReplayHarnessError,
} from "./Adapters/ClaudeAdapterV2.testkit.ts";
import {
  OpenCodeOrchestratorReplayHarness,
  type OpenCodeOrchestratorReplayHarnessError,
} from "./Adapters/OpenCodeAdapterV2.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const providers = [
  {
    driver: CLAUDE_PROVIDER,
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    registry: ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer({
      provider: CLAUDE_PROVIDER,
      protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
      version: "1",
      scenario: "head-fork",
      entries: [],
    }),
  },
  {
    driver: OPENCODE_PROVIDER,
    instanceId: OPENCODE_DEFAULT_INSTANCE_ID,
    registry: OpenCodeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer({
      provider: OPENCODE_PROVIDER,
      protocol: OPENCODE_SDK_PROTOCOL,
      version: "1",
      scenario: "head-fork",
      entries: [],
    }),
  },
].map(({ registry, ...provider }) => ({
  ...provider,
  layer: ProviderReplayHarness.layerWithRegistry<
    ClaudeOrchestratorReplayHarnessError | OpenCodeOrchestratorReplayHarnessError
  >({ name: "head-fork" }, registry, {
    runEffectWorker: false,
  }),
}));

const cases = providers.flatMap((provider) =>
  (["completed", "waiting", "failed", "interrupted", "cancelled"] as const).map((status) => ({
    ...provider,
    status,
  })),
);

it.effect.each(cases)(
  "forks the latest $status $driver conversation without a checkpoint or native identity",
  ({ instanceId, status, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("head-source");
      const targetThreadId = ThreadId.make("head-fork");
      const modelSelection = { instanceId, model: "test-model" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("head-project"),
        title: "Plain chat",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.isNull(yield* orchestrator.getThreadForkSource(sourceThreadId));

      const sourceRunId = RunId.make("head-source-run");
      // Completed plain chats have never had a checkpoint. The other cases
      // also prove an older checkpoint cannot displace the newest settled Run.
      const runs: ReadonlyArray<{
        id: RunId;
        status: OrchestrationV2Run["status"];
        checkpointId?: CheckpointId;
      }> = [
        ...(status === "completed"
          ? []
          : [
              {
                id: RunId.make("old-checkpoint-run"),
                status: "completed" as const,
                checkpointId: CheckpointId.make("old-checkpoint"),
              },
            ]),
        { id: sourceRunId, status },
        ...(["queued", "preparing", "starting", "running", "rolled_back"] as const).map(
          (status) => ({ id: RunId.make(`later-${status}`), status }),
        ),
      ];
      for (const [index, run] of runs.entries()) {
        const ordinal = index + 1;
        const messageId = MessageId.make(`message-${run.id}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${run.id}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: run.id,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: run.status,
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: run.checkpointId ?? null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${run.id}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${run.id}`),
                threadId: sourceThreadId,
                runId: run.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: run.id === sourceRunId ? "INCLUDED_HEAD_MARKER" : `MESSAGE_${run.id}`,
                attachments: [],
              },
            },
          ],
        });
      }

      assert.equal(yield* orchestrator.getThreadForkSource(sourceThreadId), sourceRunId);
      assert.equal(
        yield* orchestrator.getThreadForkSource(sourceThreadId, sourceRunId),
        sourceRunId,
      );
      assert.isNull(yield* orchestrator.getThreadForkSource(sourceThreadId, RunId.make("missing")));
      assert.isNull(
        yield* orchestrator.getThreadForkSource(sourceThreadId, RunId.make("later-running")),
      );

      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-head"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        rootPolicy: "independent_root",
        createdBy: "user",
        creationSource: "web",
      });
      const fork = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.deepEqual(fork.thread.forkedFrom, {
        type: "run",
        sourceHistoryRevision: 0,
        threadId: sourceThreadId,
        runId: sourceRunId,
      });
      assert.isNull(fork.thread.worktreePath);
      assert.lengthOf(fork.runs, 0);
      assert.isNull(yield* orchestrator.getThreadForkSource(targetThreadId, sourceRunId));

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-head-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-head-fork"),
        text: "Continue the chat",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const continued = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(continued.contextTransfers[0]?.resolution?.strategy, "portable_context");
      const handoff = continued.contextHandoffs[0]!;
      const context = `${handoff.summaryText}\n${handoff.history?.messages.map((message) => message.text).join("\n")}`;
      assert.include(context, "INCLUDED_HEAD_MARKER");
      assert.notInclude(context, "MESSAGE_later-");
      assert.isNull(continued.providerThreads[0]?.forkedFrom);
      if (status === "completed") {
        // Merge-back latest_stable keeps its checkpoint boundary. Chat forks
        // must not silently broaden the shared resolver for workspace merges.
        const forkRun = continued.runs[0]!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("complete-fork-without-checkpoint"),
              type: "run.updated",
              threadId: targetThreadId,
              occurredAt: now,
              payload: { ...forkRun, status: "completed", completedAt: now, checkpointId: null },
            },
          ],
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            commandId: CommandId.make("merge-without-checkpoint"),
            sourceThreadId: targetThreadId,
            targetThreadId: sourceThreadId,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          error.cause,
          "No stable source run was found for merge-back source latest_stable.",
        );
      }
    }).pipe(Effect.provide(layer)),
);
