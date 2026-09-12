import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type { CodexAppServerDecodedMessage } from "@nodex/effect-codex-app-server/protocol";
import { getLogger } from "../../logging/logger";

type IncomingItem =
  | { readonly line: string; readonly receivedAtMs: number }
  | CodexAppServerDecodedMessage;

const depthThresholds = [100, 250, 500, 1_000, 2_500, 5_000];
const sizeThresholds = [64 * 1024, 256 * 1024, 1024 * 1024];
const overflowDepth = 20_000;
const decodeLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** Decode each complete transport callback independently; partial lines never cross frames. */
export function codexIncomingLines(data: unknown): string[] {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : null;
  return text ? text.split(/\r?\n/).filter((line) => line.trim().length > 0) : [];
}

/** The host queue stays distinct from the physical stdout parser's dispatch queue. */
export const makeCodexIncomingMessages = Effect.fn("makeCodexIncomingMessages")(function* () {
  const clock = yield* Clock.Clock;
  const wake = yield* Queue.sliding<void>(1);
  const logger = getLogger();
  let items: IncomingItem[] = [];
  let readIndex = 0;
  let highWater = 0;
  let nextDepthThreshold = 0;
  let largestLine = 0;
  let nextSizeThreshold = 0;
  let ended = false;
  let disposed = false;
  let failure: PlatformError.PlatformError | undefined;
  let endFailure: PlatformError.PlatformError | undefined;
  let sliceStarted: number | undefined;
  let sliceCount = 0;
  let previous: {
    bytes: number;
    parseDurationMs: number;
    startedAt: number;
    value: unknown;
  } | null = null;
  const depth = () => items.length - readIndex;
  const compact = () => {
    if (readIndex === 0 || readIndex < 1_024 || readIndex < depth()) return;
    items.copyWithin(0, readIndex);
    items.length -= readIndex;
    readIndex = 0;
  };
  const resetDepth = () => {
    items = [];
    readIndex = 0;
    highWater = 0;
    nextDepthThreshold = 0;
  };
  const finishSlice = () => {
    if (sliceStarted === undefined) return;
    const duration = clock.currentTimeMillisUnsafe() - sliceStarted;
    if (duration >= 8 || depth() >= 200)
      logger.debug("incoming_line_queue_drain_slice", {
        flushAll: ended,
        drainedCount: sliceCount,
        queueRemaining: depth(),
        drainDurationMs: duration,
        queueDepthHighWaterMark: highWater,
      });
    if (depth() === 0) {
      if (highWater >= depthThresholds[0]!)
        logger.debug("incoming_line_queue_drained", { queueDepthHighWaterMark: highWater });
      resetDepth();
    } else compact();
    sliceStarted = undefined;
    sliceCount = 0;
  };
  const fail = (error: PlatformError.PlatformError) => {
    failure ??= error;
    resetDepth();
    Queue.offerUnsafe(wake, undefined);
  };
  const offer = (batch: readonly IncomingItem[]) => {
    if (disposed || ended || failure || batch.length === 0) return;
    compact();
    for (const item of batch) items.push(item);
    highWater = Math.max(highWater, depth());
    while (
      nextDepthThreshold < depthThresholds.length &&
      depth() >= depthThresholds[nextDepthThreshold]!
    ) {
      logger.debug("incoming_line_queue_depth_threshold", {
        threshold: depthThresholds[nextDepthThreshold++],
        queueDepth: depth(),
        linesInBatch: batch.length,
        queueDepthHighWaterMark: highWater,
      });
    }
    if (depth() >= overflowDepth) {
      logger.warn("app_server_connection.incoming_line_queue_overflow", {
        queueDepth: depth(),
        overflowThreshold: overflowDepth,
      });
      fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "CodexIncomingMessages",
          method: "enqueue",
          cause: new Error("Incoming line queue overflow"),
        }),
      );
      return;
    }
    Queue.offerUnsafe(wake, undefined);
  };
  const trackSize = (bytes: number) => {
    largestLine = Math.max(largestLine, bytes);
    while (nextSizeThreshold < sizeThresholds.length && bytes >= sizeThresholds[nextSizeThreshold]!)
      logger.debug("incoming_line_size_threshold", {
        threshold: sizeThresholds[nextSizeThreshold++],
        lineBytes: bytes,
        lineBytesHighWaterMark: largestLine,
      });
  };
  const finishDispatch = () => {
    if (!previous) return;
    const { bytes, parseDurationMs, startedAt, value } = previous;
    previous = null;
    const dispatchDurationMs = clock.currentTimeMillisUnsafe() - startedAt;
    if (parseDurationMs < 8 && dispatchDurationMs < 8 && bytes < sizeThresholds[0]!) return;
    const method =
      typeof value === "object" && value !== null && "method" in value ? value.method : null;
    const hasId = typeof value === "object" && value !== null && "id" in value;
    logger.debug("incoming_line_processed", {
      routeKind: method
        ? hasId
          ? "request"
          : "notification"
        : hasId
          ? "response"
          : "unrecognized",
      method,
      lineBytes: bytes,
      parseDurationMs,
      dispatchDurationMs,
      queueDepth: depth(),
    });
  };
  const nextSlice = Effect.callback<void>((resume) => {
    const handle = setImmediate(() => resume(Effect.void));
    return Effect.sync(() => clearImmediate(handle));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposed = true;
      resetDepth();
      previous = null;
      Queue.offerUnsafe(wake, undefined);
    }),
  );
  const messages = Stream.unfold(undefined, () =>
    Effect.gen(function* () {
      finishDispatch();
      for (;;) {
        if (failure) return yield* failure;
        if (disposed) return undefined;
        if (
          sliceStarted !== undefined &&
          (depth() === 0 ||
            (!ended && (sliceCount >= 200 || clock.currentTimeMillisUnsafe() - sliceStarted >= 8)))
        )
          finishSlice();
        if (depth() === 0) {
          if (ended && endFailure) return yield* endFailure;
          if (ended) return undefined;
          yield* Queue.take(wake);
          continue;
        }
        if (sliceStarted === undefined) {
          if (!ended) yield* nextSlice;
          if (failure || disposed) continue;
          sliceStarted = clock.currentTimeMillisUnsafe();
        }
        const item = items[readIndex++]!;
        sliceCount += 1;
        const startedAt = clock.currentTimeMillisUnsafe();
        if (!("line" in item)) {
          trackSize(item.bytes);
          previous = { bytes: item.bytes, parseDurationMs: 0, startedAt, value: item.value };
          return [item, undefined] as const;
        }
        const line = item.line.trim();
        const bytes = Buffer.byteLength(line, "utf8");
        trackSize(bytes);
        const decoded = decodeLine(line);
        if (Result.isFailure(decoded)) {
          logger.warn("Codex app-server returned an invalid JSON line", {
            lineBytes: bytes,
            errorName: decoded.failure.name,
          });
          logger.debug("incoming_line_parse_failed", {
            lineBytes: bytes,
            parseDurationMs: clock.currentTimeMillisUnsafe() - startedAt,
            queueDepth: depth(),
          });
          continue;
        }
        const value = decoded.success;
        const parsedAt = clock.currentTimeMillisUnsafe();
        previous = { bytes, parseDurationMs: parsedAt - startedAt, startedAt: parsedAt, value };
        return [{ value, bytes, receivedAtMs: item.receivedAtMs }, undefined] as const;
      }
    }),
  );
  return {
    messages,
    depth,
    offerParsed: (message: CodexAppServerDecodedMessage) => offer([message]),
    offerData: (data: unknown, receivedAtMs: number) =>
      offer(codexIncomingLines(data).map((line) => ({ line, receivedAtMs }))),
    fail,
    end: (error?: PlatformError.PlatformError) => {
      ended = true;
      endFailure = error;
      Queue.offerUnsafe(wake, undefined);
    },
  };
});
