import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  derivePendingBackgroundWork,
  liveBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readRootActivity } from "./ExecutionActivity.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  explainExecutedSql,
  fullHistoryScans,
  historyWideReads,
  seedUndecodableHistory,
} from "./testkit/HistoryPressure.ts";

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const fixture = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  let event = 0;
  const apply = (input: Record<string, unknown>) =>
    store.apply({
      id: EventId.make(`event:activity:${(event += 1)}`),
      occurredAt: now,
      ...input,
    } as never);
  const thread = Effect.fnUntraced(function* (id: string, parent?: ThreadId) {
    const threadId = ThreadId.make(id);
    const root = parent === undefined ? threadId : ThreadId.make(`root:${parent.split(":")[1]}`);
    const payload: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:activity"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        parent === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
          : { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: root },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* apply({ type: "thread.created", threadId, payload });
    return threadId;
  });
  const run = Effect.fnUntraced(function* (
    threadId: ThreadId,
    status: OrchestrationV2Run["status"],
    overrides: Partial<OrchestrationV2Run> = {},
  ) {
    const ordinal = overrides.ordinal ?? 1;
    const runId = RunId.make(`run:${threadId}:${ordinal}`);
    const payload: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: NodeId.make(`node:${runId}`),
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "running" ? null : now,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    };
    yield* apply({ type: "run.updated", threadId, runId, payload });
    return payload;
  });
  const task = Effect.fnUntraced(function* (
    parent: OrchestrationV2Run,
    id: string,
    overrides: Partial<OrchestrationV2Subagent> = {},
  ) {
    const payload: OrchestrationV2Subagent = {
      id: NodeId.make(id),
      threadId: parent.threadId,
      runId: parent.id,
      parentNodeId: parent.rootNodeId!,
      origin: "app_owned",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Check the build.",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      ...overrides,
    };
    yield* apply({
      type: "subagent.updated",
      threadId: parent.threadId,
      runId: parent.id,
      nodeId: payload.id,
      payload,
    });
    return payload;
  });
  const request = (threadId: ThreadId, id: string, status: "pending" | "resolved") =>
    apply({
      type: "runtime-request.updated",
      threadId,
      payload: {
        id: RuntimeRequestId.make(id),
        nodeId: NodeId.make(`node:${id}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status,
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: status === "pending" ? null : now,
      },
    });
  const roster = (
    threadId: ThreadId,
    tasks: number | ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
    providerSuffix = "",
  ) =>
    apply({
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      payload: {
        id: ProviderThreadId.make(`provider-thread:${threadId}${providerSuffix}`),
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks:
          typeof tasks === "number"
            ? Array.from({ length: tasks }, (_, index) => ({
                taskId: `background-${index}`,
                description: "Still running",
                kind: "command" as const,
              }))
            : tasks,
      },
    });
  return { thread, run, task, request, roster, now };
});

const activity = (rootThreadIds?: ReadonlyArray<string>) =>
  readRootActivity(rootThreadIds === undefined ? {} : { rootThreadIds }).pipe(
    Effect.map((page) =>
      Object.fromEntries(
        page.items.map((item) => [
          item.rootThreadId,
          {
            status: item.status,
            activeRunId: item.activeRunId,
            pendingRequestCount: item.pendingRequestCount,
          },
        ]),
      ),
    ),
  );

it.effect("reports running, waiting and background roots and rolls descendants up", () =>
  Effect.gen(function* () {
    const { thread, run, task, request, roster } = yield* fixture;
    const running = yield* thread("root:running");
    const runningRun = yield* run(running, "running");
    const waiting = yield* thread("root:waiting");
    yield* run(waiting, "running");
    yield* request(waiting, "request:question", "pending");
    yield* request(waiting, "request:answered", "resolved");
    // The parent turn ended while its delegated child keeps working in its own Thread.
    const parent = yield* thread("root:background");
    const parentRun = yield* run(parent, "completed");
    const child = yield* thread("child:background", parent);
    yield* task(parentRun, "task:background", { childThreadId: child, completionWake: "always" });
    yield* run(child, "running");
    const nativeRoster = yield* thread("root:roster");
    yield* run(nativeRoster, "completed");
    yield* roster(nativeRoster, 2);
    const idle = yield* thread("root:idle");
    yield* run(idle, "completed");

    assert.deepEqual(yield* activity(), {
      "root:background": {
        // The child's active Run counts as running work in the root's tree.
        status: "running",
        activeRunId: null,
        pendingRequestCount: 0,
      },
      "root:roster": {
        status: "background",
        activeRunId: null,
        pendingRequestCount: 0,
      },
      "root:running": {
        status: "running",
        activeRunId: runningRun.id,
        pendingRequestCount: 0,
      },
      "root:waiting": {
        status: "waiting",
        activeRunId: RunId.make("run:root:waiting:1"),
        pendingRequestCount: 1,
      },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "lists only native background roster tasks across the root tree during foreground work",
  () =>
    Effect.gen(function* () {
      const { thread, run, roster } = yield* fixture;
      const root = yield* thread("root:tasks");
      yield* run(root, "running");
      const child = yield* thread("child:tasks", root);
      const earlier = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
      const later = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
      yield* roster(root, [
        {
          taskId: "shell",
          kind: "command",
          description: "Dev server",
          command: "vp run dev",
          startedAt: later,
        },
        { taskId: "native-agent", kind: "subagent" },
      ]);
      // A prior provider thread's roster stays live even after a different thread owns the Run.
      yield* roster(root, [{ taskId: "old-provider", kind: "background_task" }], ":earlier");
      yield* roster(child, [
        { taskId: "monitor", kind: "monitor", command: "watch deploy", startedAt: earlier },
      ]);
      const result = yield* readRootActivity({ rootThreadIds: [root] });
      assert.equal(result.items[0]?.status, "running");
      assert.deepEqual(result.items[0]?.backgroundTasks, [
        {
          threadId: root,
          threadTitle: null,
          taskId: "old-provider",
          kind: "background_task",
          description: null,
          command: null,
          startedAt: null,
        },
        {
          threadId: child,
          threadTitle: "child:tasks",
          taskId: "monitor",
          kind: "monitor",
          description: null,
          command: "watch deploy",
          startedAt: DateTime.formatIso(earlier),
        },
        {
          threadId: root,
          threadTitle: null,
          taskId: "shell",
          kind: "command",
          description: "Dev server",
          command: "vp run dev",
          startedAt: DateTime.formatIso(later),
        },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("bounds each root to its oldest 25 tasks with a stable native-id tie break", () =>
  Effect.gen(function* () {
    const { thread, roster } = yield* fixture;
    const root = yield* thread("root:bounded");
    const child = yield* thread("child:bounded", root);
    const startedAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
    const tasks = Array.from({ length: 30 }, (_, index) => ({
      taskId: `task:${String(index).padStart(2, "0")}`,
      kind: "command" as const,
      startedAt,
    }));
    yield* roster(root, tasks.slice(15).reverse());
    yield* roster(child, tasks.slice(0, 15).reverse());
    const other = yield* thread("root:other");
    yield* roster(other, 2);
    const page = yield* readRootActivity({});
    const point = yield* readRootActivity({ rootThreadIds: [root] });
    const listed = page.items.find((item) => item.rootThreadId === root)!.backgroundTasks;
    assert.deepEqual(
      listed.map((task) => task.taskId),
      tasks.slice(0, 25).map((task) => task.taskId),
    );
    assert.deepEqual(point.items[0]?.backgroundTasks, listed);
    assert.equal(page.items.find((item) => item.rootThreadId === other)?.backgroundTasks.length, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "deduplicates task ids within a thread before bounding a root, while retaining the same id in a child",
  () =>
    Effect.gen(function* () {
      const { thread, roster } = yield* fixture;
      const root = yield* thread("root:dedupe");
      const child = yield* thread("child:dedupe", root);
      const task = { taskId: "shared", kind: "command" as const, command: "sleep 60" };
      yield* roster(root, [task]);
      yield* roster(root, [task], ":duplicate");
      yield* roster(child, [task]);
      const page = yield* readRootActivity({ rootThreadIds: [root] });
      assert.deepEqual(
        page.items[0]!.backgroundTasks.map(({ threadId, taskId }) => ({ threadId, taskId })),
        [
          { threadId: child, taskId: "shared" },
          { threadId: root, taskId: "shared" },
        ],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps a finished parent in the background until its delegated result wakes it", () =>
  Effect.gen(function* () {
    const { thread, run, task } = yield* fixture;
    const parent = yield* thread("root:wake");
    const parentRun = yield* run(parent, "completed");
    const child = yield* thread("child:wake", parent);
    // A wait-mode child returns through its blocking call and never wakes the parent.
    const waited = yield* task(parentRun, "task:waited", {
      childThreadId: yield* thread("child:waited", parent),
      completionWake: "settled_only",
    });
    // The waited child is live work, so the root is in the background while it runs.
    assert.equal((yield* activity(["root:wake"]))["root:wake"]?.status, "background");
    yield* task(parentRun, "task:waited", { ...waited, status: "completed", result: "done" });

    const live = yield* task(parentRun, "task:wake", {
      childThreadId: child,
      completionWake: "always",
    });
    assert.deepEqual((yield* activity(["root:wake"]))["root:wake"], {
      status: "background",
      activeRunId: null,
      pendingRequestCount: 0,
    });

    // The finished child's result is claimed for an open delivery: the root still resumes.
    yield* task(parentRun, "task:wake", {
      ...live,
      status: "completed",
      completionDelivery: { state: "claimed", observedByRunId: null },
    });
    yield* run(parent, "completed", {
      ...parentRun,
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:wake"), taskIds: [live.id] },
      },
    });
    assert.equal((yield* activity(["root:wake"]))["root:wake"]?.status, "background");

    // Once delivered and the cohort settles, the root is idle and absent.
    yield* task(parentRun, "task:wake", {
      ...live,
      status: "completed",
      completionDelivery: { state: "delivered", observedByRunId: null },
    });
    yield* run(parent, "completed", {
      ...parentRun,
      delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
    });
    assert.deepEqual(yield* activity(["root:wake"]), {});
  }).pipe(Effect.provide(layer)),
);

it.effect("pages non-idle roots by cursor", () =>
  Effect.gen(function* () {
    const { thread, run } = yield* fixture;
    for (const name of ["a", "b", "c"]) yield* run(yield* thread(`root:${name}`), "running");
    const first = yield* readRootActivity({ limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.rootThreadId),
      ["root:a", "root:b"],
    );
    const second = yield* readRootActivity({ limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(
      second.items.map((item) => item.rootThreadId),
      ["root:c"],
    );
    assert.isNull(second.nextCursor);
  }).pipe(Effect.provide(layer)),
);

it.effect("reads activity from live-state indexes only at 10,000 historical Runs", () =>
  Effect.gen(function* () {
    const { thread, run, roster, now } = yield* fixture;
    const settled = yield* thread("root:history");
    yield* seedUndecodableHistory({ threadId: settled, at: DateTime.formatIso(now) });
    const live = yield* thread("root:live");
    yield* run(live, "running", { ordinal: 1 });
    yield* roster(live, 1);
    const page = yield* explainExecutedSql(readRootActivity({}));
    const point = yield* explainExecutedSql(readRootActivity({ rootThreadIds: ["root:live"] }));
    assert.deepEqual(
      page.result.items.map((item) => item.rootThreadId),
      ["root:live"],
    );
    assert.deepEqual(
      point.result.items.map((item) => item.rootThreadId),
      ["root:live"],
    );
    assert.equal(page.result.items[0]?.backgroundTasks[0]?.taskId, "background-0");
    for (const { plan } of [...page.plans, ...point.plans]) {
      // Window/aggregate subqueries consume only the indexed live facts above.
      const boundedSubqueries = plan.flatMap(({ detail }) =>
        /^SCAN \(subquery-\d+\)$/.test(detail) ? [detail.slice(5)] : [],
      );
      assert.deepEqual(
        fullHistoryScans(plan, [
          "facts",
          "rooted",
          "task",
          "activity",
          "roster_tasks",
          "ranked_tasks",
          ...boundedSubqueries,
        ]),
        [],
      );
    }
    assert.deepEqual(historyWideReads([...page.plans, ...point.plans]), []);
  }).pipe(Effect.provide(layer)),
);

it("deduplicates a terminal roster and active command by their projected item identity", () => {
  const threadId = ThreadId.make("thread:codex-dedupe");
  const turnItemId = TurnItemId.make("item:codex-terminal");
  const task = { taskId: "process-42", kind: "command" as const, turnItemId, command: "sleep 60" };
  const providerThreads = [
    {
      id: ProviderThreadId.make("provider:codex-one"),
      appThreadId: threadId,
      pendingBackgroundTasks: [task],
    },
    {
      id: ProviderThreadId.make("provider:codex-two"),
      appThreadId: threadId,
      pendingBackgroundTasks: [{ ...task, taskId: "duplicate" }],
    },
  ];
  assert.deepEqual(liveBackgroundWork({ thread: { id: threadId }, providerThreads }), [task]);
  assert.deepEqual(
    derivePendingBackgroundWork({
      latestRun: { id: RunId.make("run:codex-terminal"), ordinal: 1, status: "completed" },
      providerThreads,
      turnItems: [
        {
          id: turnItemId,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "native-command-item" },
        },
      ],
    }),
    [task],
  );
});

it.effect("lists a settled Codex terminal as Session background activity using its command", () =>
  Effect.gen(function* () {
    const { thread, run, roster } = yield* fixture;
    const root = yield* thread("root:codex-terminal");
    yield* run(root, "completed");
    const startedAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
    yield* roster(root, [
      {
        taskId: "native-command-item",
        kind: "command",
        command: "npm run dev",
        startedAt,
        turnItemId: TurnItemId.make("item:codex-terminal"),
      },
    ]);
    const result = yield* readRootActivity({ rootThreadIds: [root] });
    assert.equal(result.items[0]?.status, "background");
    assert.deepEqual(result.items[0]?.backgroundTasks, [
      {
        threadId: root,
        threadTitle: null,
        taskId: "native-command-item",
        kind: "command",
        description: null,
        command: "npm run dev",
        startedAt: DateTime.formatIso(startedAt),
      },
    ]);
  }).pipe(Effect.provide(layer)),
);
