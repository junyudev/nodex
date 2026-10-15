import { expect, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { rollbackThread } from "./Rollback.ts";

const threadId = ThreadId.make("thread:rollback");
const firstRunId = RunId.make("run:first");
const lastRunId = RunId.make("run:last");
const scopeId = CheckpointScopeId.make("scope:root");
const baselineId = CheckpointId.make("checkpoint:baseline");
const previousId = CheckpointId.make("checkpoint:previous");
const readRunRecords = (runIds: ReadonlyArray<RunId>) =>
  Effect.succeed({
    runs: runIds.map((id) => ({ id, userMessageId: MessageId.make(`message:${id.slice(4)}`) })),
  } as never);
const context: ProjectionCheckpointContext = {
  runs: [
    {
      id: firstRunId,
      ordinal: 1,
      status: "completed",
    },
    {
      id: lastRunId,
      ordinal: 2,
      status: "completed",
    },
  ],
  checkpointScopes: [{ id: scopeId, runId: lastRunId, kind: "root_run", cwd: "/workspace" }],
  checkpoints: [
    {
      id: baselineId,
      scopeId,
      runId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: null,
      status: "missing",
      ref: CheckpointRef.make("refs/checkpoints/0"),
    },
    {
      id: previousId,
      scopeId,
      runId: firstRunId,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      status: "missing",
      ref: CheckpointRef.make("refs/checkpoints/1"),
    },
  ],
};

it.effect("replays an accepted rewind after its Run is discarded", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Native rewind is exercised by CheckpointRollbackService tests."),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSinkV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:rewind"),
      threadId,
      projectId: ProjectId.make("project:rewind"),
      title: "Rewind",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("dispatch:rewind"),
      threadId,
      messageId: MessageId.make("message:rewind"),
      text: "Original",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    const run = { ...projection.runs[0]!, status: "completed" as const, queuePosition: null };
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:rewind");
    const nodeId = NodeId.make("node:rewind");
    const eventFields = { threadId, providerInstanceId: instanceId, occurredAt: now };
    yield* events.write({
      events: [
        {
          ...eventFields,
          id: EventId.make("event:rewind:run"),
          type: "run.updated",
          payload: run,
        },
        {
          ...eventFields,
          id: EventId.make("event:rewind:thread"),
          type: "thread.metadata-updated",
          payload: { ...projection.thread, activeProviderThreadId: providerThreadId },
        },
        {
          ...eventFields,
          id: EventId.make("event:rewind:provider"),
          type: "provider-thread.updated",
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            providerSessionId: ProviderSessionId.make("session:rewind"),
            appThreadId: threadId,
            ownerNodeId: nodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          ...eventFields,
          id: EventId.make("event:rewind:scope"),
          type: "checkpoint-scope.created",
          payload: {
            id: scopeId,
            threadId,
            runId: run.id,
            nodeId,
            parentScopeId: null,
            providerThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/workspace",
            createdAt: now,
          },
        },
        {
          ...eventFields,
          id: EventId.make("event:rewind:checkpoint"),
          type: "checkpoint.captured",
          payload: {
            ...context.checkpoints[0]!,
            threadId,
            nodeId,
            parentCheckpointId: null,
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* Effect.gen(function* () {
      const request = { threadId, requestId: CommandId.make("rewind-once"), runId: run.id };
      const accepted = yield* rollbackThread(request);
      yield* events.write({
        events: [
          {
            ...eventFields,
            id: EventId.make("event:rewind:discarded"),
            type: "run.updated",
            payload: { ...run, status: "rolled_back" },
          },
        ],
      });
      expect(yield* rollbackThread(request)).toEqual(accepted);
      expect((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]?.status).toBe(
        "rolled_back",
      );
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService)({
          getReceipt: orchestrator.getReceipt,
          getCheckpointContext: orchestrator.getCheckpointContext,
          getThreadRecords: orchestrator.getThreadRecords,
          dispatch: orchestrator.dispatch,
        }),
      ),
    );
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "rewind-receipt" },
        ProviderAdapterRegistry.layerSingle(adapter),
        { runEffectWorker: false },
      ),
    ),
  );
});

it.effect.each([
  ["first message", firstRunId, baselineId],
  ["last message", lastRunId, previousId],
] as const)(
  "rewinds %s without requiring file checkpoints or reading transcript",
  ([, runId, checkpointId]) => {
    const dispatch = vi.fn((_command: OrchestrationV2ServerCommand) =>
      Effect.succeed({ sequence: 42, storedEvents: [] }),
    );
    return Effect.gen(function* () {
      const receipt = yield* rollbackThread({ threadId, requestId: CommandId.make("edit"), runId });
      expect(receipt).toEqual({
        commandId: "host:thread.rollback:edit",
        userMessageId: runId === firstRunId ? "message:first" : "message:last",
        sequence: 42,
      });
      expect(dispatch.mock.calls[0]).toEqual([
        {
          type: "checkpoint.rollback",
          commandId: "host:thread.rollback:edit",
          threadId,
          beforeRunId: runId,
          scopeId,
          checkpointId,
          restoreFiles: false,
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService)({
          getReceipt: () => Effect.succeed(Option.none()),
          getCheckpointContext: () => Effect.succeed(context),
          getThreadRecords: (_threadId, _fields, filter) => readRunRecords(filter?.runIds ?? []),
          getThreadProjection: () => Effect.die("Editing must not open transcript history."),
          dispatch,
        }),
      ),
    );
  },
);

it.effect("skips discarded Run checkpoints when editing after a previous rewind", () => {
  const nextRunId = RunId.make("run:next");
  const discardedId = CheckpointId.make("checkpoint:discarded");
  const dispatch = vi.fn((_command: OrchestrationV2ServerCommand) =>
    Effect.succeed({ sequence: 43, storedEvents: [] }),
  );
  return Effect.gen(function* () {
    yield* rollbackThread({ threadId, requestId: CommandId.make("next-edit"), runId: nextRunId });
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ checkpointId: previousId });
  }).pipe(
    Effect.provide(
      Layer.mock(ThreadManagementService)({
        getReceipt: () => Effect.succeed(Option.none()),
        getCheckpointContext: () =>
          Effect.succeed({
            ...context,
            runs: [
              context.runs[0]!,
              {
                id: lastRunId,
                ordinal: 2,
                status: "rolled_back",
              },
              {
                id: nextRunId,
                ordinal: 3,
                status: "completed",
              },
            ],
            checkpoints: [
              ...context.checkpoints,
              {
                ...context.checkpoints[1]!,
                id: discardedId,
                runId: lastRunId,
                appRunOrdinal: 2,
                ordinalWithinScope: 2,
              },
            ],
          }),
        getThreadRecords: (_threadId, _fields, filter) => readRunRecords(filter?.runIds ?? []),
        dispatch,
      }),
    ),
  );
});

it.effect.each(["foreign Run", "missing checkpoint", "stale checkpoint"] as const)(
  "refuses %s before dispatch",
  (failure) => {
    const dispatch = vi.fn((_command: OrchestrationV2ServerCommand) =>
      Effect.die("Invalid targets must never dispatch."),
    );
    return Effect.gen(function* () {
      const result = yield* rollbackThread({
        threadId,
        requestId: CommandId.make(failure),
        runId: failure === "foreign Run" ? RunId.make("run:foreign") : lastRunId,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(dispatch).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService)({
          getReceipt: () => Effect.succeed(Option.none()),
          getCheckpointContext: () =>
            Effect.succeed({
              ...context,
              checkpoints:
                failure === "missing checkpoint"
                  ? []
                  : failure === "stale checkpoint"
                    ? context.checkpoints.map((checkpoint) => ({
                        ...checkpoint,
                        status: "stale" as const,
                      }))
                    : context.checkpoints,
            }),
          getThreadRecords: (_threadId, _fields, filter) => readRunRecords(filter?.runIds ?? []),
          dispatch,
        }),
      ),
    );
  },
);
