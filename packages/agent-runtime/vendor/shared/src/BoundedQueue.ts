import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// These are retained intake limits, independent of native output/history limits.
export const DEFAULT_MAX_ITEMS = 512;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// A 20 MiB image payload expands to about 28 MiB when native prompts encode it as base64.
export const MAX_PROMPT_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = DEFAULT_MAX_BYTES;
const encoder = new TextEncoder();

export class BufferOverflow extends Schema.TaggedError<BufferOverflow>()("BufferOverflow", {
  label: Schema.String,
  maxItems: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `${this.label} exceeded its retained message budget (${this.maxItems} items / ${this.maxBytes} bytes).`;
  }
}

export interface BoundedQueue<A, E> {
  readonly failed: Deferred.Deferred<never, E>;
  readonly queue: Queue.Queue<{ readonly value: A; readonly bytes: number }, E | Cause.Done>;
  readonly mapOverflow: (error: BufferOverflow) => E;
  readonly label: string;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly sizeOf: (value: A) => number;
  items: number;
  bytes: number;
  failure: Option.Option<E>;
}

export const encodedBytes = (value: unknown): number => {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
};

export const make = <A, E>(options: {
  readonly label: string;
  readonly mapOverflow: (error: BufferOverflow) => E;
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly sizeOf?: (value: A) => number;
}): Effect.Effect<BoundedQueue<A, E>> =>
  Effect.gen(function* () {
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const queue = yield* Queue.bounded<
      { readonly value: A; readonly bytes: number },
      E | Cause.Done
    >(maxItems);
    const failed = yield* Deferred.make<never, E>();
    return {
      failed,
      queue,
      label: options.label,
      maxItems,
      maxBytes,
      sizeOf: options.sizeOf ?? encodedBytes,
      mapOverflow: options.mapOverflow,
      items: 0,
      bytes: 0,
      failure: Option.none<E>(),
    };
  });

// Fail before shutdown: waiters see the cause, while queued bodies are discarded
// immediately. Producer admission never waits for a reader or spawns a waiter.
export const failCauseUnsafe = <A, E>(self: BoundedQueue<A, E>, cause: Cause.Cause<E>): void => {
  if (Option.isNone(self.failure)) self.failure = Cause.findErrorOption(cause);
  Deferred.doneUnsafe(self.failed, Effect.failCause(cause));
  Queue.failCauseUnsafe(self.queue, cause);
  Queue.shutdownUnsafe(self.queue);
  self.items = 0;
  self.bytes = 0;
};

export const overflowUnsafe = <A, E>(self: BoundedQueue<A, E>): void => {
  if (Option.isSome(self.failure)) return;
  failCauseUnsafe(
    self,
    Cause.fail(
      self.mapOverflow(
        new BufferOverflow({ label: self.label, maxItems: self.maxItems, maxBytes: self.maxBytes }),
      ),
    ),
  );
};

export const offer = <A, E>(self: BoundedQueue<A, E>, value: A): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (Option.isSome(self.failure) || self.queue.state._tag !== "Open") return false;
    let bytes: number;
    try {
      bytes = self.sizeOf(value);
    } catch {
      overflowUnsafe(self);
      return false;
    }
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      self.items >= self.maxItems ||
      self.bytes + bytes > self.maxBytes
    ) {
      overflowUnsafe(self);
      return false;
    }
    if (!Queue.offerUnsafe(self.queue, { value, bytes })) return false;
    self.items++;
    self.bytes += bytes;
    return true;
  });

export const take = <A, E>(self: BoundedQueue<A, E>): Effect.Effect<A, E | Cause.Done> =>
  Queue.take(self.queue).pipe(
    Effect.map(({ value, bytes }) => {
      self.items = Math.max(0, self.items - 1);
      self.bytes = Math.max(0, self.bytes - bytes);
      return value;
    }),
  );

export const stream = <A, E>(self: BoundedQueue<A, E>): Stream.Stream<A, E> =>
  Stream.fromEffectRepeat(take(self));
export const failure = <A, E>(self: BoundedQueue<A, E>): Effect.Effect<Option.Option<E>> =>
  Effect.sync(() => self.failure);
export const fail = <A, E>(self: BoundedQueue<A, E>, error: E): Effect.Effect<void> =>
  Effect.sync(() => failCauseUnsafe(self, Cause.fail(error)));
export const failCause = <A, E>(
  self: BoundedQueue<A, E>,
  cause: Cause.Cause<E>,
): Effect.Effect<void> => Effect.sync(() => failCauseUnsafe(self, cause));
export const clear = <A, E>(self: BoundedQueue<A, E>): Effect.Effect<void> =>
  Queue.clear(self.queue).pipe(
    Effect.ignore,
    Effect.tap(() =>
      Effect.sync(() => {
        self.items = 0;
        self.bytes = 0;
      }),
    ),
    Effect.asVoid,
  );
export const end = <A, E>(self: BoundedQueue<A, E>): Effect.Effect<void> =>
  Queue.end(self.queue).pipe(Effect.asVoid);
export const shutdown = <A, E>(self: BoundedQueue<A, E>): Effect.Effect<void> =>
  Effect.sync(() => {
    Queue.shutdownUnsafe(self.queue);
    self.items = 0;
    self.bytes = 0;
  });

// Arrays parked for causal replay use the same fail-fast budget as their owning
// intake. Cache immutable-array weights so appends remain O(1) in the backlog.
const retainedWeights = new WeakMap<
  ReadonlyArray<unknown>,
  { readonly length: number; readonly bytes: number }
>();
const appendWithinBudget = <A, E, B>(
  self: BoundedQueue<A, E>,
  current: ReadonlyArray<B>,
  values: ReadonlyArray<B>,
  maxBytes: number,
): Array<B> => {
  if (Option.isSome(self.failure) || self.queue.state._tag !== "Open") return [];
  const cached = retainedWeights.get(current);
  let bytes = cached?.length === current.length ? cached.bytes : undefined;
  try {
    bytes ??= current.reduce((total, value) => total + encodedBytes(value), 0);
    bytes += values.reduce((total, value) => total + encodedBytes(value), 0);
  } catch {
    overflowUnsafe(self);
    return [];
  }
  if (current.length + values.length > self.maxItems || bytes > maxBytes) {
    failCauseUnsafe(
      self,
      Cause.fail(
        self.mapOverflow(
          new BufferOverflow({ label: self.label, maxItems: self.maxItems, maxBytes }),
        ),
      ),
    );
    return [];
  }
  const next = [...current, ...values];
  retainedWeights.set(next, { length: next.length, bytes });
  return next;
};

export const appendUnsafe = <A, E, B>(
  self: BoundedQueue<A, E>,
  current: ReadonlyArray<B>,
  ...values: ReadonlyArray<B>
): Array<B> => appendWithinBudget(self, current, values, self.maxBytes);

/** Reject an unfinished native frame before JSON parsing or concatenation. */
export const assertFrameSize = (bytes: number, label: string, maxBytes = MAX_FRAME_BYTES): void => {
  if (bytes <= maxBytes) return;
  throw new BufferOverflow({ label, maxItems: 1, maxBytes });
};

/** Diagnostic fanout owns buffers only while an observer is subscribed. */
export const broadcast = <A, E>(options: Parameters<typeof make<A, E>>[0]) =>
  Effect.gen(function* () {
    const subscribers = new Set<BoundedQueue<A, E>>();
    let terminal: Cause.Cause<E> | undefined;
    let ended = false;
    return {
      stream: Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const queue = yield* make(options);
            if (terminal !== undefined) yield* failCause(queue, terminal);
            else if (ended) yield* end(queue);
            else subscribers.add(queue);
            return queue;
          }),
          (queue) =>
            Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(shutdown(queue))),
        ).pipe(Effect.map(stream)),
      ),
      offer: (value: A) =>
        Effect.forEach(subscribers, (queue) => offer(queue, value)).pipe(
          Effect.map((accepted) => accepted.every(Boolean)),
        ),
      fail: (error: E) =>
        Effect.sync(() => {
          terminal = Cause.fail(error);
        }).pipe(
          Effect.andThen(
            Effect.forEach(subscribers, (queue) => fail(queue, error), { discard: true }),
          ),
        ),
      end: Effect.sync(() => {
        ended = true;
      }).pipe(Effect.andThen(Effect.forEach(subscribers, end, { discard: true }))),
    };
  });

export const pushUnsafe = <A, E, B>(
  self: BoundedQueue<A, E>,
  current: Array<B>,
  ...values: ReadonlyArray<B>
): void => {
  const next = appendUnsafe(self, current, ...values);
  current.splice(0, current.length, ...next);
  const cached = retainedWeights.get(next);
  if (cached !== undefined) retainedWeights.set(current, cached);
};

/** Terminal transport failure can preserve an already admitted valid prefix. */
export const failAfterDrain = <A, E>(self: BoundedQueue<A, E>, error: E): Effect.Effect<void> =>
  Effect.sync(() => {
    if (Option.isSome(self.failure)) return;
    self.failure = Option.some(error);
    Deferred.doneUnsafe(self.failed, Effect.fail(error));
    Queue.failCauseUnsafe(self.queue, Cause.fail(error));
  });

export const isOverflow = (cause: unknown): boolean => {
  let current = cause;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (current instanceof BufferOverflow) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
};

/** SDK user/replay envelopes can echo a supported multi-image prompt. */
export const appendSdkUnsafe = <A, E, B>(
  self: BoundedQueue<A, E>,
  current: ReadonlyArray<B>,
  ...values: ReadonlyArray<B>
): Array<B> => appendWithinBudget(self, current, values, MAX_PROMPT_BYTES);
export const pushSdkUnsafe = <A, E, B>(
  self: BoundedQueue<A, E>,
  current: Array<B>,
  ...values: ReadonlyArray<B>
): void => {
  const next = appendSdkUnsafe(self, current, ...values);
  current.splice(0, current.length, ...next);
  const cached = retainedWeights.get(next);
  if (cached !== undefined) retainedWeights.set(current, cached);
};
