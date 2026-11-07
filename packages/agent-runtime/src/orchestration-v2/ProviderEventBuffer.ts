import type { ProviderThreadId, ThreadId } from "@nodex/runtime-contracts";
import type * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as BoundedQueue from "@nodex/runtime-shared/BoundedQueue";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export function providerEventThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "app_thread.created":
      return event.appThread.id;
    case "provider_thread.updated":
      return event.providerThread.appThreadId ?? undefined;
    case "provider_turn.updated":
    case "runtime_request.updated":
    case "message.delivery.updated":
      return event.threadId;
    case "node.updated":
      return event.node.threadId;
    case "subagent.updated":
      return event.subagent.threadId;
    case "message.updated":
      return event.message.threadId;
    case "turn_item.updated":
      return event.turnItem.threadId;
    case "plan.updated":
      return event.plan.threadId;
    default:
      return undefined;
  }
}

export function providerEventProviderThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ProviderThreadId | undefined {
  switch (event.type) {
    case "provider_thread.updated":
      return event.providerThread.id;
    case "provider_turn.updated":
      return event.providerTurn.providerThreadId;
    case "turn.terminal":
      return event.providerThreadId;
    case "turn_item.updated":
      return event.turnItem.providerThreadId ?? undefined;
    case "node.updated":
      return event.node.providerThreadId ?? undefined;
    case "subagent.updated":
      return event.subagent.providerThreadId ?? undefined;
    default:
      return undefined;
  }
}

/** FIFO delivery preserves cross-thread causality; admission budgets belong to individual threads. */
export const makeProviderEventBuffer = Effect.fnUntraced(function* (options: {
  readonly mapOverflow: (
    cause: BoundedQueue.BufferOverflow,
  ) => ProviderAdapter.ProviderAdapterEventStreamError;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}) {
  type Observation = ProviderAdapter.ProviderAdapterV2Observation;
  type Lane = {
    key: string;
    items: Array<{ observation: Observation; bytes: number }>;
    bytes: number;
    lost: boolean;
  };
  const ready = yield* Queue.unbounded<Lane, ProviderAdapter.ProviderAdapterV2Error>();
  const lanes = new Map<string, Lane>();
  const threadByProvider = new Map<string, ThreadId>();
  const providerByThread = new Map<ThreadId, string>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Queue.shutdownUnsafe(ready);
      lanes.clear();
      threadByProvider.clear();
      providerByThread.clear();
    }),
  );
  const maxItems = options.maxItems ?? BoundedQueue.DEFAULT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? BoundedQueue.DEFAULT_MAX_BYTES;
  const route = (event: ProviderAdapter.ProviderAdapterV2Event) => {
    if (event.type === "provider_thread.updated" && event.providerThread.appThreadId !== null) {
      threadByProvider.set(event.providerThread.id, event.providerThread.appThreadId);
      providerByThread.set(event.providerThread.appThreadId, event.providerThread.id);
    }
    const providerThreadId = providerEventProviderThreadId(event);
    const threadId =
      providerEventThreadId(event) ??
      (providerThreadId == null ? undefined : threadByProvider.get(providerThreadId));
    // App-thread-only artifacts join the already routed provider lane.
    const key =
      providerThreadId ??
      (threadId === undefined ? "session" : (providerByThread.get(threadId) ?? threadId));
    return { key, threadId };
  };
  const lose = (
    key: string,
    threadId: ThreadId | undefined,
    cause: ProviderAdapter.ProviderAdapterV2Error,
  ) => {
    const previous = lanes.get(key);
    if (previous?.lost) return;
    const lane = previous ?? { key, items: [], bytes: 0, lost: false };
    lane.items = [{ observation: { type: "observation_loss", threadId, cause }, bytes: 0 }];
    lane.bytes = 0;
    lane.lost = true;
    lanes.set(key, lane);
    if (previous === undefined) Queue.offerUnsafe(ready, lane);
  };
  const observations = Stream.fromEffectRepeat(
    Queue.take(ready).pipe(
      Effect.map((lane) => {
        const item = lane.items.shift();
        if (item === undefined) return undefined;
        lane.bytes -= item.bytes;
        if (lane.items.length === 0 && lanes.get(lane.key) === lane) lanes.delete(lane.key);
        return item.observation;
      }),
    ),
  ).pipe(Stream.filter((signal) => signal !== undefined));
  return {
    observations,
    events: observations.pipe(
      Stream.mapEffect((signal) =>
        signal.type === "event" ? Effect.succeed(signal.event) : Effect.fail(signal.cause),
      ),
    ),
    offer: (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.sync(() => {
        if (ready.state._tag !== "Open") return;
        const { key, threadId } = route(event);
        const lane = lanes.get(key);
        if (lane?.lost) return;
        let bytes: number;
        try {
          bytes = BoundedQueue.encodedBytes(event);
        } catch {
          bytes = Infinity;
        }
        if (
          !Number.isFinite(bytes) ||
          (lane?.items.length ?? 0) >= maxItems ||
          (lane?.bytes ?? 0) + bytes > maxBytes
        ) {
          lose(
            key,
            threadId,
            options.mapOverflow(
              new BoundedQueue.BufferOverflow({
                label: "Codex native thread events",
                maxItems,
                maxBytes,
              }),
            ),
          );
          return;
        }
        if (lane !== undefined) {
          lane.items.push({ observation: { type: "event", event }, bytes });
          lane.bytes += bytes;
          Queue.offerUnsafe(ready, lane);
          return;
        }
        const next = {
          key,
          items: [{ observation: { type: "event" as const, event }, bytes }],
          bytes,
          lost: false,
        };
        lanes.set(key, next);
        Queue.offerUnsafe(ready, next);
      }),
    lose: (threadId: ThreadId, cause: ProviderAdapter.ProviderAdapterV2Error) =>
      Effect.sync(() => lose(providerByThread.get(threadId) ?? threadId, threadId, cause)),
    fail: (cause: ProviderAdapter.ProviderAdapterV2Error) =>
      Queue.fail(ready, cause).pipe(Effect.asVoid),
  };
});
