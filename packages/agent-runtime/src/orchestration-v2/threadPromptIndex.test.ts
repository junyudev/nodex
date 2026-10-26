import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  THREAD_PROMPT_INDEX_MAX_PROMPTS,
  THREAD_PROMPT_INDEX_PROMPT_CHARACTERS,
  selectThreadPromptIndexSlots,
} from "./threadPromptIndex.ts";

const threadId = ThreadId.make("thread:prompt-index");
const providerInstanceId = ProviderInstanceId.make("claude");
const modelSelection = { instanceId: providerInstanceId, model: "claude-opus" };

const storageCases = (["sqlite", "memory"] as const).map((storage) => ({
  storage,
  storeLayer:
    storage === "sqlite"
      ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
      : ProjectionStore.layerMemory,
}));

function events(now: DateTime.Utc): ReadonlyArray<OrchestrationV2DomainEvent> {
  const common = { threadId, occurredAt: now };
  const run = (
    id: string,
    ordinal: number,
    status: OrchestrationV2Run["status"],
  ): OrchestrationV2DomainEvent => ({
    ...common,
    id: EventId.make(`run:${id}`),
    type: "run.created",
    payload: {
      id: RunId.make(id),
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  const base = (id: string, runId: string, ordinal: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const prompt = (
    runId: string,
    ordinal: number,
    text: string,
    options: {
      readonly inputIntent?: "turn_start" | "steer";
      readonly scheduled?: boolean;
      readonly id?: string;
    } = {},
  ): OrchestrationV2TurnItem => ({
    ...base(options.id ?? `user:${runId}`, runId, ordinal),
    type: "user_message",
    messageId: MessageId.make(options.id ?? `message:${runId}`),
    inputIntent: options.inputIntent ?? "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    ...(options.scheduled ? { scheduledTaskId: ScheduledTaskId.make("task:daily") } : {}),
  });
  const reply = (id: string, runId: string, ordinal: number, text: string) =>
    ({
      ...base(id, runId, ordinal),
      type: "assistant_message",
      messageId: MessageId.make(`message:${id}`),
      text,
      streaming: false,
    }) satisfies OrchestrationV2TurnItem;
  const item = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    ...common,
    id: EventId.make(`item:${payload.id}`),
    type: "turn-item.updated",
    payload,
  });
  return [
    {
      ...common,
      id: EventId.make("thread"),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:prompt-index"),
        title: "Prompt index",
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    run("run-1", 1, "completed"),
    run("run-2", 2, "completed"),
    run("run-3", 3, "rolled_back"),
    item(prompt("run-1", 1, "Scheduled check", { scheduled: true })),
    item(reply("reply-1a", "run-1", 2, "Looking")),
    item(reply("reply-1b", "run-1", 3, "Everything passed")),
    item(prompt("run-2", 4, "x".repeat(THREAD_PROMPT_INDEX_PROMPT_CHARACTERS + 500))),
    item(prompt("run-2", 5, "Also check docs", { inputIntent: "steer", id: "steer-2" })),
    item(prompt("run-3", 6, "Rewound prompt")),
    item(reply("reply-3", "run-3", 7, "Rewound reply")),
  ];
}

describe("thread prompt index", () => {
  it.effect.each(storageCases)(
    "$storage: lists each visible Run's opening prompt and latest reply without its history",
    ({ storeLayer }) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        yield* Effect.forEach(events(now), (event) => store.apply(event), { discard: true });

        const index = yield* store.getThreadPromptIndex(threadId);

        assert.isTrue(index.complete);
        assert.deepEqual(
          index.prompts.map(({ prompt, ...entry }) => ({ ...entry, length: prompt.length })),
          [
            {
              runId: "run-1",
              messageId: "message:run-1",
              response: "Everything passed",
              scheduled: true,
              length: "Scheduled check".length,
            },
            {
              runId: "run-2",
              messageId: "message:run-2",
              response: "",
              scheduled: false,
              length: THREAD_PROMPT_INDEX_PROMPT_CHARACTERS,
            },
          ],
        );
      }).pipe(Effect.provide(storeLayer)),
  );

  it("indexes only the thread's own Runs and keeps the newest prompts within its bound", () => {
    const row = (
      sourceItemId: string,
      item: { type: OrchestrationV2TurnItem["type"]; runId: string | null; inputIntent?: string },
      visibility: "local" | "inherited" = "local",
    ) => ({
      sourceItemId,
      visibility,
      item: {
        ...item,
        runId: item.runId === null ? null : RunId.make(item.runId),
        messageId: `message:${sourceItemId}`,
      },
    });
    const own = Array.from({ length: THREAD_PROMPT_INDEX_MAX_PROMPTS + 1 }, (_, index) =>
      row(`prompt-${index}`, {
        type: "user_message",
        runId: `run-${index}`,
        inputIntent: "turn_start",
      }),
    );
    const { slots, complete } = selectThreadPromptIndexSlots([
      row(
        "inherited",
        { type: "user_message", runId: "source-run", inputIntent: "turn_start" },
        "inherited",
      ),
      row("imported", { type: "user_message", runId: null, inputIntent: "turn_start" }),
      ...own,
    ]);

    assert.isFalse(complete);
    assert.lengthOf(slots, THREAD_PROMPT_INDEX_MAX_PROMPTS);
    assert.strictEqual(slots[0]?.runId, "run-1");
    assert.strictEqual(slots.at(-1)?.promptItemId, `prompt-${THREAD_PROMPT_INDEX_MAX_PROMPTS}`);
  });
});
