import { SUBAGENT_OVERVIEW_BATCH_LIMIT } from "@nodex/agent-runtime/contracts";
import type {
  AgentExecutionAgentSelection,
  AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { readAgentRuntimeEffort } from "../../shared/agent-runtime-provider";
import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";
import {
  AGENTS_MAP_RECENT_WINDOW_MS,
  type AgentsMapChat,
  type AgentsMapReadInput,
  type AgentsMapSnapshot,
} from "../../shared/agents-map";
import type { SessionSidebarPlacement } from "../../shared/sidebar-sections";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeSessionResolver } from "./AgentRuntimeSessionActivity";

const LIVE_LIMIT = 100;
const PLACEMENT_BATCH_SIZE = 500;

export class AgentsMap extends Context.Service<
  AgentsMap,
  {
    readonly read: (input: AgentsMapReadInput) => Effect.Effect<AgentsMapSnapshot, unknown>;
    readonly changes: Stream.Stream<number>;
  }
>()("nodex/main/agent-runtime/AgentsMap") {}

type MapRuntime = Pick<AgentRuntimeProcessConnection, "identity" | "request">;
type RecentPage = AgentRuntimeOperations["execution.recent-runs"]["output"];
type SubagentEntry = AgentRuntimeOperations["tasks.overviews"]["output"][number];

interface Sources {
  readonly activity: Effect.Effect<ReadonlyMap<string, AgentRuntimeSessionActivity>>;
  readonly connect: Effect.Effect<MapRuntime | null, unknown>;
  readonly resolveSessions: AgentRuntimeSessionResolver;
  readonly placements: (
    sessionIds: string[],
  ) => Effect.Effect<readonly SessionSidebarPlacement[], unknown>;
  readonly changes: readonly Stream.Stream<unknown>[];
}

function toAgent(selection: AgentExecutionAgentSelection | undefined) {
  if (!selection || !(selection.driver || selection.providerInstanceId || selection.model))
    return null;
  return {
    kind: selection.driver,
    providerInstanceId: selection.providerInstanceId,
    model: selection.model,
    effort: readAgentRuntimeEffort(selection.options),
  };
}

function shortLine(...values: readonly (string | null | undefined)[]) {
  for (const value of values) {
    const line = value?.trim().replace(/\s+/gu, " ");
    if (!line) continue;
    const chars = Array.from(line);
    return chars.length > 160 ? `${chars.slice(0, 159).join("")}…` : line;
  }
  return null;
}

function chatPlacement(placement: SessionSidebarPlacement) {
  return {
    sessionId: placement.sessionId,
    projectId: placement.projectId,
    unread: placement.unread,
    page: placement.activePage ?? null,
    managed: placement.managed ?? false,
  };
}

function subagentCount(subagents: SubagentEntry | undefined) {
  const live = subagents?.activeCount ?? 0;
  return { live, total: live + (subagents?.terminalCount ?? 0) };
}

function activeChat(
  activity: AgentRuntimeSessionActivity,
  placement: SessionSidebarPlacement,
  tasks: SubagentEntry | undefined,
): AgentsMapChat {
  const subagents = tasks?.overview ?? null;
  const state = activity.status === "running" ? "working" : activity.status;
  const attention =
    state !== "waiting"
      ? null
      : activity.activeFlags?.includes("waitingOnApproval")
        ? "approval"
        : "question";
  const background = activity.backgroundTasks.find((task) => task.description || task.threadTitle);
  return {
    ...chatPlacement(placement),
    rootThreadId: activity.threadId,
    agent: toAgent(activity.agentSelection),
    state,
    attention,
    line: shortLine(
      attention === "approval" ? activity.approvalPrompt : activity.questionPrompt,
      activity.readback?.text,
      background?.description,
      background?.threadTitle,
      state === "background" ? subagents?.active.items[0]?.title : null,
    ),
    queuePosition: state === "queued" ? (activity.queuePosition ?? null) : null,
    startedAt: activity.startedAt ?? activity.updatedAt,
    settledAt: null,
    outcome: null,
    subagentCount: subagentCount(tasks),
    subagents,
  };
}

const batches = <A>(items: readonly A[], limit: number) =>
  Array.from({ length: Math.ceil(items.length / limit) }, (_, index) =>
    items.slice(index * limit, (index + 1) * limit),
  );

/** The per-window Agents query and invalidation stream share a single Main owner. */
export const make = Effect.fn("AgentsMap.make")(function* (sources: Sources) {
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.sliding<number>(1);
  const dirty = yield* Queue.sliding<void>(1);
  // The oldest requested recent row (including the Show more sentinel) schedules one shared wake.
  const nextExpiry = yield* SubscriptionRef.make<number | null>(null);
  const expirations = SubscriptionRef.changes(nextExpiry).pipe(
    Stream.changes,
    Stream.switchMap((at) =>
      at === null
        ? Stream.empty
        : Stream.fromEffect(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Effect.sleep(Math.max(0, at - now))),
              Effect.as(at),
            ),
          ),
    ),
    Stream.filterEffect((at) =>
      SubscriptionRef.modify(nextExpiry, (current) =>
        current === at ? [true, null] : [false, current],
      ),
    ),
  );
  yield* Effect.addFinalizer(() =>
    PubSub.shutdown(changes).pipe(Effect.andThen(Queue.shutdown(dirty))),
  );
  for (const source of [...sources.changes, expirations])
    yield* source.pipe(
      Stream.runForEach(() => Queue.offer(dirty, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    );
  // Use a bounded coalescing window so continuous Agent progress still reaches observers.
  yield* Stream.fromQueue(dirty).pipe(
    Stream.groupedWithin(1_024, "250 millis"),
    Stream.runForEach(() =>
      Ref.updateAndGet(revision, (value) => value + 1).pipe(
        Effect.flatMap((value) => PubSub.publish(changes, value)),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const read = Effect.fn("AgentsMap.read")(function* ({ scope, recentLimit }: AgentsMapReadInput) {
    const observedRevision = yield* Ref.get(revision);
    const connection = yield* sources.connect;
    if (!connection)
      return {
        scope,
        revision: observedRevision,
        active: [],
        recent: [],
        complete: true,
        hasMoreRecent: false,
      } satisfies AgentsMapSnapshot;
    const live = yield* sources.activity;
    const placed = (sessionIds: readonly string[]) =>
      Effect.forEach(batches(sessionIds, PLACEMENT_BATCH_SIZE), sources.placements, {
        concurrency: 2,
      }).pipe(
        Effect.map(
          (results) =>
            new Map(
              results
                .flat()
                .flatMap((row) =>
                  row.hidden || (scope.projectId !== null && scope.projectId !== row.projectId)
                    ? []
                    : [[row.sessionId, row] as const],
                ),
            ),
        ),
      );

    const since = new Date(
      (yield* Clock.currentTimeMillis) - AGENTS_MAP_RECENT_WINDOW_MS,
    ).toISOString();
    const readRecent = Effect.gen(function* () {
      const settled: { run: RecentPage["items"][number]; placement: SessionSidebarPlacement }[] =
        [];
      let before: NonNullable<RecentPage["nextCursor"]> | undefined;
      do {
        const page: RecentPage = yield* connection.request("execution.recent-runs", {
          since,
          before,
        });
        const sessions = yield* sources.resolveSessions(
          connection.identity.runtimeId,
          page.items.map((item) => item.rootThreadId),
        );
        const rows = yield* placed([...sessions.values()].filter((id) => !live.has(id)));
        for (const run of page.items) {
          const sessionId = sessions.get(run.rootThreadId);
          const row = sessionId ? rows.get(sessionId) : undefined;
          if (row) settled.push({ run, placement: row });
          if (settled.length > recentLimit) return settled;
        }
        before = page.nextCursor ?? undefined;
      } while (before);
      return settled;
    });
    const [livePlacements, settled] = yield* Effect.all([placed([...live.keys()]), readRecent], {
      concurrency: 2,
    });
    const active = [...live.values()]
      .filter((item) => !item.sideChatSourceThreadId && livePlacements.has(item.sessionId))
      .sort(
        (left, right) =>
          (left.startedAt ?? left.updatedAt).localeCompare(right.startedAt ?? right.updatedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
    const visible = active.slice(0, LIVE_LIMIT);
    const recent = settled.slice(0, recentLimit);
    const earliest = settled.at(-1)?.run.completedAt;
    if (earliest) {
      const at = Date.parse(earliest) + AGENTS_MAP_RECENT_WINDOW_MS + 1;
      yield* SubscriptionRef.update(nextExpiry, (previous) => Math.min(at, previous ?? at));
    }
    const overviews = yield* Effect.forEach(
      [
        ...batches(visible, SUBAGENT_OVERVIEW_BATCH_LIMIT).map((items) => ({
          threadIds: items.map((item) => item.threadId),
        })),
        ...batches(recent, SUBAGENT_OVERVIEW_BATCH_LIMIT).map((items) => ({
          threadIds: [],
          countsOnlyThreadIds: items.map(({ run }) => run.rootThreadId),
        })),
      ],
      (input) => connection.request("tasks.overviews", input),
      { concurrency: 2 },
    );
    const tasks = new Map(overviews.flat().map((entry) => [entry.threadId, entry]));
    return {
      scope,
      revision: observedRevision,
      active: visible.map((item) =>
        activeChat(item, livePlacements.get(item.sessionId)!, tasks.get(item.threadId)),
      ),
      recent: recent.map(({ run, placement }): AgentsMapChat => ({
        ...chatPlacement(placement),
        rootThreadId: run.rootThreadId,
        agent: toAgent(run.agentSelection),
        state: "settled",
        attention: null,
        line: null,
        queuePosition: null,
        startedAt: null,
        settledAt: run.completedAt,
        outcome: run.status === "completed" || run.status === "failed" ? run.status : "stopped",
        subagentCount: { total: subagentCount(tasks.get(run.rootThreadId)).total, live: 0 },
        subagents: null,
      })),
      hasMoreRecent: settled.length > recentLimit,
      complete: active.length <= LIVE_LIMIT,
    } satisfies AgentsMapSnapshot;
  });
  return { read, changes: Stream.fromPubSub(changes) } satisfies AgentsMap["Service"];
});
