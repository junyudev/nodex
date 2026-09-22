import type { Thread, ThreadListParams, Turn } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Effect from "effect/Effect";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";

export interface CodexSubagentDiscoverySnapshot {
  readonly threads: readonly Thread[];
  readonly complete: boolean;
}

interface DiscoveryInput {
  readonly rootThreadId: string;
  readonly rootCreatedAtMs: number | null;
  readonly listSupported: boolean;
  readonly ancestorFilter: boolean;
  readonly observedSpawnedThreadIds: (parentThreadId: string) => readonly string[];
  readonly isResident: (threadId: string) => boolean;
  readonly list: (
    params: ThreadListParams,
  ) => Effect.Effect<ClientRequestResponsesByMethod["thread/list"], CodexRuntimeError>;
  readonly read: (threadId: string) => Effect.Effect<Thread, CodexRuntimeError>;
  readonly turns: (
    threadId: string,
    cursor: string | null,
  ) => Effect.Effect<ClientRequestResponsesByMethod["thread/turns/list"], CodexRuntimeError>;
}

const parentId = (thread: Thread): string | null =>
  extractCodexThreadSubagentMetadata(thread).parentThreadId;

const spawnedThreadIds = (turns: readonly Turn[]): readonly string[] => {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "subAgentActivity" && item.kind === "started") ids.add(item.agentThreadId);
      if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent") continue;
      for (const id of item.receiverThreadIds) ids.add(id);
    }
  }
  return [...ids];
};

/** Recover nested spawns only for a repaired, nonresident paginated child. */
const readTopology = Effect.fn("CodexSubagentDiscovery.readTopology")(function* (
  input: DiscoveryInput,
  thread: Thread,
) {
  const spawned = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let latest: Thread["turns"][number] | null = null;
  do {
    if (cursor !== null && cursors.has(cursor)) return null;
    if (cursor !== null) cursors.add(cursor);
    const response: ClientRequestResponsesByMethod["thread/turns/list"] = yield* input.turns(
      thread.id,
      cursor,
    );
    for (const turn of response.data) {
      latest = {
        ...turn,
        error: turn.error ?? null,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
        items: [],
        itemsView: "notLoaded",
      } as Turn;
    }
    for (const id of spawnedThreadIds(response.data as readonly Turn[])) spawned.add(id);
    cursor = response.nextCursor ?? null;
  } while (cursor !== null);
  return { thread: { ...thread, turns: latest ? [latest] : [] }, spawnedThreadIds: [...spawned] };
});

/** A discovery is one complete in-memory scan; transport pages are not UI windows. */
export const discoverCodexSubagentDescendants = Effect.fn("CodexSubagentDiscovery.discover")(
  function* (
    input: DiscoveryInput,
  ): Effect.fn.Return<CodexSubagentDiscoverySnapshot, CodexRuntimeError> {
    const threads: Thread[] = [];
    const parents = input.listSupported ? [input.rootThreadId] : [];
    const repairParents = [input.rootThreadId];
    const repairedSpawns = new Map<string, readonly string[]>();
    const seen = new Set([input.rootThreadId]);
    const oldestCreatedAt =
      input.rootCreatedAtMs === null ? null : Math.floor(input.rootCreatedAtMs / 1_000);
    for (const parentThreadId of parents) {
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (;;) {
        const params: ThreadListParams = {
          limit: 200,
          cursor,
          modelProviders: null,
          archived: false,
          ...(input.ancestorFilter ? { ancestorThreadId: input.rootThreadId } : { parentThreadId }),
          sourceKinds: ["subAgentThreadSpawn"],
          sortDirection: "desc",
          sortKey: "created_at",
          useStateDbOnly: true,
        };
        let response = yield* input.list(params);
        const listed = new Set(response.data.map((thread) => thread.id));
        const observedParents = input.ancestorFilter
          ? [parentThreadId, ...listed]
          : [parentThreadId];
        const missingObserved = observedParents.some((parent) =>
          input.observedSpawnedThreadIds(parent).some((id) => !listed.has(id)),
        );
        if (cursor === null && response.nextCursor == null && missingObserved) {
          response = yield* input.list({ ...params, useStateDbOnly: false });
        }
        for (const raw of response.data) {
          const thread = projectCodexGatewayThreadReadThread(raw);
          if (seen.has(thread.id)) continue;
          if (!input.ancestorFilter && parentId(thread) !== parentThreadId) continue;
          if (!input.ancestorFilter) parents.push(thread.id);
          threads.push(thread);
          seen.add(thread.id);
          repairParents.push(thread.id);
        }
        const nextCursor = response.nextCursor ?? null;
        if (
          nextCursor === null ||
          (oldestCreatedAt !== null &&
            response.data.some((thread) => thread.createdAt < oldestCreatedAt))
        )
          break;
        if (cursors.has(nextCursor)) return { threads, complete: false };
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
    }

    let complete = input.listSupported;
    for (const parentThreadId of repairParents) {
      const observed = new Set([
        ...input.observedSpawnedThreadIds(parentThreadId),
        ...(repairedSpawns.get(parentThreadId) ?? []),
      ]);
      const missing = [...observed].filter((id) => !seen.has(id));
      const repairs = yield* Effect.forEach(
        missing,
        (threadId) =>
          Effect.gen(function* () {
            const thread = yield* input.read(threadId);
            if (thread.id !== threadId || parentId(thread) !== parentThreadId) return null;
            if (thread.historyMode !== "paginated" || input.isResident(threadId)) {
              return { thread, spawnedThreadIds: [] as readonly string[], complete: true };
            }
            const topology = yield* readTopology(input, thread).pipe(
              Effect.orElseSucceed(() => null),
            );
            return topology
              ? { ...topology, complete: true }
              : { thread, spawnedThreadIds: [], complete: false };
          }).pipe(Effect.orElseSucceed(() => null)),
        { concurrency: 2 },
      );
      for (const repaired of repairs) {
        if (!repaired) {
          complete = false;
          continue;
        }
        if (!repaired.complete) complete = false;
        repairedSpawns.set(repaired.thread.id, repaired.spawnedThreadIds);
        threads.push(repaired.thread);
        seen.add(repaired.thread.id);
        repairParents.push(repaired.thread.id);
      }
    }
    return { threads, complete };
  },
);
