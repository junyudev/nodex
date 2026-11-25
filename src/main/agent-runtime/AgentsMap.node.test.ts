import { assert, it } from "@effect/vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import { AGENTS_MAP_RECENT_WINDOW_MS } from "../../shared/agents-map";
import { AgentsMapReadInputSchema } from "../../shared/schemas/agents-map";
import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make } from "./AgentsMap";

const at = (hour: number) => new Date(hour * 3_600_000).toISOString();

const selection = {
  driver: "codex",
  providerInstanceId: "codex",
  model: "gpt",
  options: [{ id: "reasoningEffort", value: "high" }],
} as const;

const active = (
  id: string,
  status: AgentRuntimeSessionActivity["status"],
  patch: Partial<AgentRuntimeSessionActivity> = {},
): AgentRuntimeSessionActivity => ({
  sessionId: id,
  threadId: `thread:${id}`,
  status,
  activeRunId: null,
  pendingRequestCount: 0,
  backgroundTasks: [],
  providerInstanceId: "codex",
  model: "gpt",
  updatedAt: at(24),
  startedAt: at(22),
  agentSelection: selection,
  ...patch,
});

const placement = (
  sessionId: string,
  patch: Partial<SessionSidebarPlacement> = {},
): SessionSidebarPlacement => ({
  sessionId,
  projectId: "project",
  sectionId: null,
  unread: false,
  snoozedUntil: null,
  ...patch,
});

const recent = (id: string, hour: number, status: "completed" | "failed" | "interrupted") => ({
  rootThreadId: `thread:${id}`,
  runId: `run:${id}`,
  completedAt: at(hour),
  status,
  agentSelection: selection,
});

const fixture = ({
  activities = [],
  placements = [],
  runs = [],
}: {
  activities?: readonly AgentRuntimeSessionActivity[];
  placements?: readonly SessionSidebarPlacement[];
  runs?: readonly ReturnType<typeof recent>[];
} = {}) =>
  Effect.gen(function* () {
    const core = yield* PubSub.unbounded<void>();
    const runtime = yield* PubSub.unbounded<void>();
    const overviewReads: AgentRuntimeOperations["tasks.overviews"]["input"][] = [];
    const request = ((method: string, input: never) =>
      Effect.sync(() => {
        if (method === "execution.recent-runs") {
          const { since, before } =
            input as AgentRuntimeOperations["execution.recent-runs"]["input"];
          const items = runs.filter(
            (run) => run.completedAt >= since && (!before || run.completedAt < before.completedAt),
          );
          const [first, second] = items;
          return {
            items: first ? [first] : [],
            nextCursor:
              first && second ? { completedAt: first.completedAt, runId: first.runId } : null,
          };
        }
        assert.equal(method, "tasks.overviews");
        const read = input as AgentRuntimeOperations["tasks.overviews"]["input"];
        overviewReads.push(read);
        const page = (totalCount: number) => ({
          items: [],
          totalCount,
          hasMore: false,
          nextCursor: null,
        });
        return [
          ...read.threadIds.map((threadId) => ({
            threadId,
            activeCount: 2,
            terminalCount: 5,
            overview: { active: page(2), terminal: page(5) },
          })),
          ...(read.countsOnlyThreadIds ?? []).map((threadId) => ({
            threadId,
            activeCount: 0,
            terminalCount: 5,
            overview: null,
          })),
        ];
      })) as unknown as AgentRuntimeProcessConnection["request"];
    const map = yield* make({
      activity: Effect.succeed(new Map(activities.map((item) => [item.sessionId, item]))),
      connect: Effect.succeed({
        identity: {
          runtimeId: "runtime",
          runtimeGeneration: "generation",
          schemaVersion: 1,
          databasePath: "",
          mcpEndpoint: "",
          lastSequence: 0,
        },
        request,
      }),
      resolveSessions: (_runtimeId, roots) =>
        Effect.succeed(
          new Map(roots.map((threadId) => [threadId, threadId.slice("thread:".length)])),
        ),
      placements: (ids) => Effect.succeed(placements.filter((row) => ids.includes(row.sessionId))),
      changes: [Stream.fromPubSub(core), Stream.fromPubSub(runtime)],
    });
    return { map, core, runtime, overviewReads };
  });

it.effect("joins scope and visible placement before selecting and reading work trees", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(26 * 3_600_000);
    const { map, overviewReads } = yield* fixture({
      activities: [
        active("waiting", "waiting", { questionPrompt: "  Where\n   should I ship?  " }),
        active("approval", "waiting", {
          approvalPrompt: "Allow this command?",
          activeFlags: ["waitingOnApproval"],
        }),
        active("queued", "queued", { startedAt: at(20), queuePosition: 3 }),
        active("side", "waiting", { sideChatSourceThreadId: "thread:waiting" }),
        active("coordinator", "running"),
        active("projectless", "background"),
        active("archived", "running"),
      ],
      placements: [
        placement("waiting", {
          unread: true,
          managed: true,
          activePage: { id: "page", key: "DOC-1" },
        }),
        placement("approval"),
        placement("queued"),
        placement("side"),
        placement("coordinator", { hidden: true }),
        placement("projectless", { projectId: null }),
        placement("failed"),
        placement("stopped"),
        placement("completed"),
        placement("expired"),
      ],
      runs: [
        recent("waiting", 26, "completed"),
        recent("unplaced", 25.5, "completed"),
        recent("failed", 25, "failed"),
        recent("stopped", 24, "interrupted"),
        recent("completed", 23, "completed"),
        recent("expired", 1, "completed"),
      ],
    });
    const scoped = yield* map.read({ scope: { projectId: "project" }, recentLimit: 2 });
    assert.deepEqual(
      scoped.active.map(({ sessionId, state, startedAt }) => [sessionId, state, startedAt]),
      [
        ["queued", "queued", at(20)],
        ["approval", "waiting", at(22)],
        ["waiting", "waiting", at(22)],
      ],
    );
    assert.equal(scoped.active[0]?.queuePosition, 3);
    assert.include(scoped.active[1], { attention: "approval", line: "Allow this command?" });
    assert.include(scoped.active[2], {
      attention: "question",
      line: "Where should I ship?",
      unread: true,
      managed: true,
    });
    assert.deepEqual(scoped.active[2]?.page, { id: "page", key: "DOC-1" });
    assert.deepEqual(scoped.active[2]?.agent, {
      kind: "codex",
      providerInstanceId: "codex",
      model: "gpt",
      effort: "high",
    });
    assert.deepEqual(scoped.active[2]?.subagentCount, { total: 7, live: 2 });
    assert.isNotNull(scoped.active[2]?.subagents);
    assert.deepEqual(
      scoped.recent.map(({ sessionId, settledAt, outcome, subagents, subagentCount }) => [
        sessionId,
        settledAt,
        outcome,
        subagents,
        subagentCount.total,
      ]),
      [
        ["failed", at(25), "failed", null, 5],
        ["stopped", at(24), "stopped", null, 5],
      ],
    );
    assert.isTrue(scoped.recent.every(({ subagentCount }) => subagentCount.live === 0));
    assert.isTrue(scoped.hasMoreRecent);
    assert.deepEqual(overviewReads, [
      { threadIds: ["thread:queued", "thread:approval", "thread:waiting"] },
      { threadIds: [], countsOnlyThreadIds: ["thread:failed", "thread:stopped"] },
    ]);
    const all = yield* map.read({ scope: { projectId: null }, recentLimit: 10 });
    assert.isTrue(all.active.some(({ sessionId }) => sessionId === "projectless"));
    assert.deepEqual(
      all.recent.map(({ outcome }) => outcome),
      ["failed", "stopped", "completed"],
    );
    assert.isFalse(all.hasMoreRecent);
    yield* TestClock.adjust(AGENTS_MAP_RECENT_WINDOW_MS);
    assert.isEmpty((yield* map.read({ scope: { projectId: null }, recentLimit: 10 })).recent);
  }).pipe(Effect.scoped),
);

it.effect("bounds the live overview request and reports incomplete coverage", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 101 }, (_, index) => String(index).padStart(3, "0"));
    const { map, overviewReads } = yield* fixture({
      activities: ids.map((id) => active(id, "running")),
      placements: ids.map((id) => placement(id)),
    });
    const snapshot = yield* map.read({ scope: { projectId: null }, recentLimit: 0 });
    assert.isFalse(snapshot.complete);
    assert.deepEqual(
      snapshot.active.map(({ sessionId }) => sessionId),
      ids.slice(0, 100),
    );
    assert.equal(overviewReads.length, 1);
    assert.equal(overviewReads[0]?.threadIds.length, 100);
  }).pipe(Effect.scoped),
);

it.effect("coalesces Core and Runtime changes into one revision per burst", () =>
  Effect.gen(function* () {
    const { map, core, runtime } = yield* fixture();
    const pushes: number[] = [];
    const read = map.read({ scope: { projectId: null }, recentLimit: 0 });
    yield* map.changes.pipe(
      Stream.runForEach((revision) => Effect.sync(() => pushes.push(revision))),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* PubSub.publish(core, undefined);
    yield* PubSub.publish(runtime, undefined);
    yield* TestClock.adjust("249 millis");
    assert.deepEqual(pushes, []);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(pushes, [1]);
    assert.equal((yield* read).revision, 1);
    yield* PubSub.publish(runtime, undefined);
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(pushes, [1, 2]);
  }).pipe(Effect.scoped),
);

it.effect("invalidates when the last recent result ages out without work changing", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(AGENTS_MAP_RECENT_WINDOW_MS);
    const { map } = yield* fixture({
      runs: [recent("last", 0, "completed")],
      placements: [placement("last")],
    });
    const read = map.read({ scope: { projectId: null }, recentLimit: 1 });
    const before = yield* read;
    assert.equal(before.recent.length, 1);
    yield* TestClock.adjust("251 millis");
    const after = yield* read;
    assert.isEmpty(after.recent);
    assert.isAbove(after.revision, before.revision);
  }).pipe(Effect.scoped),
);

it("accepts only a bounded recent limit and an exact Project scope", () => {
  assert.isTrue(
    AgentsMapReadInputSchema.safeParse({ scope: { projectId: null }, recentLimit: 0 }).success,
  );
  assert.isTrue(
    AgentsMapReadInputSchema.safeParse({ scope: { projectId: "project:active" }, recentLimit: 500 })
      .success,
  );
  for (const input of [
    { scope: {}, recentLimit: 10 },
    { scope: { projectId: "" }, recentLimit: 10 },
    { scope: { projectId: " padded " }, recentLimit: 10 },
    { scope: { projectId: null, all: true }, recentLimit: 10 },
    { scope: { projectId: null }, recentLimit: 501 },
    { scope: { projectId: null }, recentLimit: -1 },
    { scope: { projectId: null }, recentLimit: 1.5 },
  ])
    assert.isFalse(AgentsMapReadInputSchema.safeParse(input).success);
});
