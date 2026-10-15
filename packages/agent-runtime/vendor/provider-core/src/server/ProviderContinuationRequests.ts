import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { encodedBytes } from "@t3tools/shared/BoundedQueue";

export const MAX_PENDING_CONTINUATIONS = 512;
export const MAX_PENDING_CONTINUATION_BYTES = 8 * 1024 * 1024;

export class ProviderContinuationQueueFull extends Schema.TaggedError<ProviderContinuationQueueFull>()(
  "ProviderContinuationQueueFull",
  { maxItems: Schema.Number, maxBytes: Schema.Number },
) {}

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  /**
   * Durable ownership for an app-owned delegated-task completion delivery.
   * The continuation worker re-reads the cohort before dispatching so a later
   * task can join a queued wake and a stopped or acknowledged cohort is dropped.
   */
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /**
   * How the continuation turn gets its content.
   *
   * `adapter_buffered` (default) is the provider-native wake: the adapter has
   * already buffered the CLI's wake output, and the dispatched message only
   * triggers ingestion. `ClaudeAdapterV2` deliberately discards the message
   * text on that path.
   *
   * `message_text` is for app-owned work with no buffered provider output, such
   * as a delegated child finishing. The text is the entire wake, so it must
   * reach the provider as a real prompt.
   */
  readonly delivery?: "adapter_buffered" | "message_text";
  /**
   * The message the continuation run starts from, when the adapter picks it:
   * its turn input carries this id, so the adapter can tell which of its held
   * wakes a run was dispatched for. Otherwise the service allocates one.
   */
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Clears a pending offer that the continuation worker intentionally drops. */
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/**
 * Adapters offer a continuation request when provider-native work completes
 * outside an active turn (for example a Claude background task wake turn) so
 * the orchestrator can start a run that ingests it. The default reference
 * drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that
 * drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void, ProviderContinuationQueueFull>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<{ readonly request: ProviderContinuationRequest; readonly bytes: number }>(MAX_PENDING_CONTINUATIONS);
    let items = 0;
    let bytes = 0;
    return {
      // Never park a producer holding a native wake body. Rejection belongs to
      // its origin; other providers can keep using this shared control lane.
      offer: (request: ProviderContinuationRequest) => Effect.suspend(() => {
        const weight = encodedBytes(request);
        if (items >= MAX_PENDING_CONTINUATIONS || bytes + weight > MAX_PENDING_CONTINUATION_BYTES)
          return Effect.fail(new ProviderContinuationQueueFull({ maxItems: MAX_PENDING_CONTINUATIONS, maxBytes: MAX_PENDING_CONTINUATION_BYTES }));
        if (!Queue.offerUnsafe(queue, { request, bytes: weight }))
          return Effect.fail(new ProviderContinuationQueueFull({ maxItems: MAX_PENDING_CONTINUATIONS, maxBytes: MAX_PENDING_CONTINUATION_BYTES }));
        items++;
        bytes += weight;
        return Effect.void;
      }),
      take: Queue.take(queue).pipe(Effect.map((entry) => {
        items = Math.max(0, items - 1);
        bytes = Math.max(0, bytes - entry.bytes);
        return entry.request;
      })),
    };
  }),
);
