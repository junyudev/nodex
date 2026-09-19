import type { ThreadStatus, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  ThreadPollCache,
  isNewerPollTurn,
  pollWake,
  statusPollWake,
  unchangedTerminalPoll,
  type ThreadPoll,
  type ThreadPollTarget,
  type ThreadPollWake,
} from "./codex-thread-poll";
export interface ThreadWaitManager {
  readonly hostId: string;
  read(threadId: string): Promise<{ status: ThreadStatus; latestTurn: Turn | null }>;
  subscribe(
    threadId: string,
    listener: (
      event:
        | { readonly type: "completed"; readonly turn: Turn }
        | { readonly type: "status"; readonly status: ThreadStatus },
    ) => void,
  ): () => void;
}
export interface ThreadWaitClient {
  readonly cache: ThreadPollCache;
  resolve(threadId: string, preferredHostId?: string): Promise<ThreadWaitManager>;
  watchManager(hostId: string, callback: (manager: ThreadWaitManager) => void): () => void;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly interval: (callback: () => void, delayMs: number) => () => void;
}
export interface SingleThreadWait {
  readonly timedOut: boolean;
  readonly wake: ThreadPollWake | null;
  readonly poll: ThreadPoll;
}
export interface ThreadsWaitResult {
  readonly timedOut: boolean;
  readonly wake: (ThreadPollWake & { readonly threadId: string; readonly hostId: string }) | null;
  readonly polls: readonly ThreadPoll[];
  readonly errors?: readonly {
    readonly threadId: string;
    readonly hostId: string;
    readonly message: string;
  }[];
}
async function readPoll(
  client: ThreadWaitClient,
  manager: ThreadWaitManager,
  target: ThreadPollTarget,
  completed: Turn | null = null,
): Promise<ThreadPoll> {
  const ordinal = client.cache.beginRead();
  const native = await manager.read(target.threadId);
  let latest = native.latestTurn;
  let observed = completed;
  if (
    observed &&
    latest?.id === observed.id &&
    latest.itemsView === "full" &&
    observed.itemsView !== "full"
  )
    observed = { ...observed, items: latest.items, itemsView: "full" };
  if (
    observed &&
    (!latest ||
      (observed.id === latest.id && latest.status === "inProgress") ||
      isNewerPollTurn(observed, latest))
  )
    latest = observed;
  return client.cache.commit(
    { ...target, hostId: manager.hostId },
    native.status,
    latest,
    ordinal,
    observed !== null && observed.itemsView !== "full" && latest?.id === observed.id,
  );
}

export async function waitForThread(
  client: ThreadWaitClient,
  target: ThreadPollTarget,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SingleThreadWait> {
  signal.throwIfAborted();
  const deadline = client.now() + timeoutMs;
  let manager = await client.resolve(target.threadId, target.hostId);
  signal.throwIfAborted();
  if (timeoutMs === 0) {
    let poll: ThreadPoll;
    try {
      poll = await readPoll(client, manager, target);
    } catch {
      manager = await client.resolve(target.threadId);
      poll = await readPoll(client, manager, target);
    }
    signal.throwIfAborted();
    const wake = statusPollWake(poll.thread.status) ?? pollWake(poll);
    const unchanged = unchangedTerminalPoll(poll);
    return {
      timedOut: wake === null && !unchanged,
      wake,
      poll: wake === null && !unchanged ? client.cache.withProgress(poll) : poll,
    };
  }
  let settled = false;
  let completed: Turn | null = null;
  let observedStatus: ThreadStatus | null = null;
  let readPending: Promise<void> | null = null;
  let resolveWake!: (value: ThreadPollWake | null) => void;
  let result = new Promise<ThreadPollWake | null>((resolve) => {
    resolveWake = resolve;
  });
  const finish = (wake: ThreadPollWake | null) => {
    if (!settled) {
      settled = true;
      resolveWake(wake);
    }
  };
  const refresh = () => {
    if (settled || readPending) return;
    const captured = manager;
    readPending = readPoll(client, captured, target)
      .then((poll) => {
        if (captured !== manager) return;
        const wake = pollWake(poll);
        if (wake) finish(wake);
      })
      .catch(() => {})
      .finally(() => {
        if (captured === manager) readPending = null;
      });
  };
  const subscribe = () =>
    manager.subscribe(target.threadId, (event) => {
      if (settled) return;
      if (event.type === "completed") {
        completed = event.turn;
        finish({ reason: "turnCompleted", turnId: event.turn.id });
        return;
      }
      const previous =
        observedStatus ?? client.cache.unchangedStatus({ ...target, hostId: manager.hostId });
      observedStatus = event.status;
      const wake = statusPollWake(event.status);
      if (
        wake?.reason === "actionableStatus" &&
        JSON.stringify(previous) === JSON.stringify(event.status)
      )
        return;
      if (wake) {
        finish(wake);
        return;
      }
      if (event.status.type === "idle") refresh();
    });
  let unsubscribe = subscribe();
  const unwatch = client.watchManager(manager.hostId, (next) => {
    if (settled || next === manager) return;
    unsubscribe();
    manager = next;
    readPending = null;
    unsubscribe = subscribe();
    refresh();
  });
  const abort = () => finish(null);
  signal.addEventListener("abort", abort, { once: true });
  let cancelTimeout: (() => void) | undefined;
  let cancelInterval: (() => void) | undefined;
  try {
    let initial: ThreadPoll;
    try {
      initial = await readPoll(client, manager, target);
    } catch (error) {
      unsubscribe();
      try {
        const previousHost = manager.hostId;
        manager = await client.resolve(target.threadId);
        signal.throwIfAborted();
        if (previousHost !== manager.hostId) {
          settled = false;
          readPending = null;
          completed = null;
          observedStatus = null;
          result = new Promise((resolve) => {
            resolveWake = resolve;
          });
        }
        unsubscribe = subscribe();
        initial = await readPoll(client, manager, target);
      } catch {
        const fallback = client.cache.fallback(
          { ...target, hostId: manager.hostId },
          completed,
          observedStatus,
        );
        if (!settled || !fallback) throw error;
        const wake = await result;
        if (!wake) throw error;
        return {
          timedOut: false,
          wake,
          poll: wake.reason === "turnCompleted" ? fallback : client.cache.withProgress(fallback),
        };
      }
    }
    signal.throwIfAborted();
    const immediate = pollWake(initial);
    if (immediate && !settled) return { timedOut: false, wake: immediate, poll: initial };
    if (!settled && unchangedTerminalPoll(initial))
      return { timedOut: false, wake: null, poll: initial };
    const remaining = Math.max(0, deadline - client.now());
    if (!remaining && !settled)
      return { timedOut: true, wake: null, poll: client.cache.withProgress(initial) };
    cancelTimeout = client.schedule(() => finish(null), remaining);
    cancelInterval = client.interval(refresh, 5000);
    const wake = await result;
    signal.throwIfAborted();
    let poll: ThreadPoll;
    try {
      poll = await readPoll(client, manager, target, completed);
    } catch {
      poll =
        client.cache.fallback({ ...target, hostId: manager.hostId }, completed, observedStatus) ??
        initial;
    }
    return {
      timedOut: wake === null,
      wake,
      poll: wake?.reason === "turnCompleted" ? poll : client.cache.withProgress(poll),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    unwatch();
    unsubscribe();
    cancelTimeout?.();
    cancelInterval?.();
  }
}

/** One completion wakes the group; failed targets do not prevent the remaining targets from completing. */
export async function waitForThreads(
  client: ThreadWaitClient,
  targets: readonly ThreadPollTarget[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ThreadsWaitResult> {
  signal.throwIfAborted();
  if (!targets.length) return { timedOut: true, wake: null, polls: [] };
  const deadline = client.now() + timeoutMs;
  const controller = new AbortController();
  let resolve!: () => void;
  const done = new Promise<void>((ready) => {
    resolve = ready;
  });
  const abort = () => {
    controller.abort(signal.reason);
    resolve();
  };
  signal.addEventListener("abort", abort, { once: true });
  const results: Array<{ result: SingleThreadWait } | { error: string } | undefined> = Array.from({
    length: targets.length,
  });
  let pending = targets.length;
  targets.forEach((target, index) => {
    void waitForThread(
      client,
      target,
      Math.max(0, deadline - client.now()),
      controller.signal,
    ).then(
      (result) => {
        results[index] = { result };
        pending -= 1;
        if (result.wake || !pending) resolve();
      },
      (error: unknown) => {
        results[index] = {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        };
        pending -= 1;
        if (!pending) resolve();
      },
    );
  });
  try {
    await done;
    await Promise.resolve();
    signal.throwIfAborted();
    const winner = results.find((entry) => entry && "result" in entry && entry.result.wake);
    const polls = results.flatMap((entry) =>
      entry && "result" in entry ? [entry.result.poll] : [],
    );
    const errors = targets.flatMap((target, index) => {
      const entry = results[index];
      return entry && "error" in entry
        ? [{ threadId: target.threadId, hostId: target.hostId, message: entry.error }]
        : [];
    });
    return {
      timedOut: winner
        ? false
        : results.some((entry) => entry && "result" in entry && entry.result.timedOut),
      wake:
        winner && "result" in winner && winner.result.wake
          ? {
              ...winner.result.wake,
              threadId: winner.result.poll.thread.id,
              hostId: winner.result.poll.thread.hostId,
            }
          : null,
      polls,
      ...(errors.length ? { errors } : {}),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
