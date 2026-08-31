import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import type * as Scope from "effect/Scope";
import {
  CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS,
  CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS,
  CODEX_COMMAND_OUTPUT_MAX_BUFFERED_KEYS,
  CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UPDATES,
  CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UTF8_BYTES,
  CodexCommandOutputQueue,
  type CodexCommandOutputScheduler,
  type CodexCommandOutputUpdate,
} from "../../shared/codex-conversation-state/codex-command-output-queue";
import {
  CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS,
  CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS,
  CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS_PER_KEY,
  CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_KEYS,
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaScheduler,
  type CodexFrameTextDeltaUpdate,
} from "../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexConversationDeltaBufferRuntimeOptions {
  readonly frameFlushIntervalMs?: number;
  readonly outputFlushIntervalMs?: number;
  readonly maxBufferedFrameKeys?: number;
  readonly maxBufferedFrameCodeUnitsPerKey?: number;
  readonly maxBufferedFrameCodeUnits?: number;
  readonly maxBufferedOutputChars?: number;
  readonly maxBufferedOutputKeys?: number;
  readonly maxBufferedOutputUpdates?: number;
  readonly maxBufferedOutputUtf8Bytes?: number;
}

export class CodexConversationDeltaBufferRuntime extends Context.Service<
  CodexConversationDeltaBufferRuntime,
  {
    readonly enqueueFrameText: (update: CodexFrameTextDeltaUpdate) => void;
    readonly enqueueCommandOutput: (update: CodexCommandOutputUpdate) => void;
    readonly drainFrameText: (conversationId: string, observedAtMs: number) => void;
    readonly clear: (conversationId: string) => void;
  }
>()("nodex/main/codex-application/CodexConversationDeltaBufferRuntime") {}

type EffectTimerRunner = (effect: Effect.Effect<void>) => void;

const makeEffectTimerScheduler = (
  run: EffectTimerRunner,
): CodexFrameTextDeltaScheduler & CodexCommandOutputScheduler => ({
  canUseAnimationFrame: () => false,
  scheduleAnimationFrame: () => () => {},
  scheduleTimeout: (callback, delayMs) => {
    run(Effect.sleep(delayMs).pipe(Effect.andThen(Effect.sync(callback))));
    return () => run(Effect.void);
  },
});

/**
 * Process-global bounded delta admission. Canonical conversation entities own durable state, not
 * transient string buffers; queue pressure therefore cannot grow with Thread fan-out.
 */
export const make = (
  options: CodexConversationDeltaBufferRuntimeOptions = {},
): Effect.Effect<
  CodexConversationDeltaBufferRuntime["Service"],
  never,
  ConversationEntityMap | CodexRendererConversationRegistry | Scope.Scope
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationEntityMap;
    const rendererRegistry = yield* CodexRendererConversationRegistry;
    const frameTimer = yield* FiberHandle.make<void, never>();
    const outputTimer = yield* FiberHandle.make<void, never>();
    const frameScheduler = makeEffectTimerScheduler(yield* FiberHandle.runtime(frameTimer)());
    const outputScheduler = makeEffectTimerScheduler(yield* FiberHandle.runtime(outputTimer)());
    const runFork = Effect.runForkWith(yield* Effect.context());
    const terminalObservedAtMsByConversation = new Map<string, number>();

    const groupByConversation = <TUpdate extends { readonly conversationId: string }>(
      updates: readonly TUpdate[],
    ): ReadonlyMap<string, readonly TUpdate[]> => {
      const grouped = new Map<string, TUpdate[]>();
      for (const update of updates) {
        const current = grouped.get(update.conversationId);
        if (current) {
          current.push(update);
        } else {
          grouped.set(update.conversationId, [update]);
        }
      }
      return grouped;
    };

    const commitFrameText = (
      updates: readonly CodexFrameTextDeltaUpdate[],
      _context?: { readonly terminalDrainCommit: boolean },
    ): void => {
      const defaultObservedAtMs = Date.now();
      for (const [threadId, threadUpdates] of groupByConversation(updates)) {
        const aggregate = conversations.current(threadId);
        if (!aggregate) continue;
        const observedAtMs =
          terminalObservedAtMsByConversation.get(threadId) ?? defaultObservedAtMs;
        const outcomes = aggregate.commitFrameTextDeltas({
          updates: threadUpdates,
          observedAtMs,
          projectReplica: !rendererRegistry.hasOwner(threadId),
        });
        for (const outcome of outcomes) {
          if (outcome.disposition === "applied") continue;
          runFork(
            Effect.logWarning("Skipping frame-text delta at canonical raw boundary").pipe(
              Effect.annotateLogs({
                threadId,
                turnId: outcome.update.turnId,
                itemId: outcome.update.itemId,
                target: outcome.update.target.type,
                disposition: outcome.disposition,
              }),
            ),
          );
        }
      }
    };

    const commitCommandOutput = (
      updates: readonly CodexCommandOutputUpdate[],
      observedAtMs = Date.now(),
    ): void => {
      for (const [threadId, threadUpdates] of groupByConversation(updates)) {
        conversations.current(threadId)?.commitCommandOutputDeltas({
          updates: threadUpdates,
          observedAtMs,
          projectReplica: !rendererRegistry.hasOwner(threadId),
        });
      }
    };

    const frameQueue = new CodexFrameTextDeltaQueue({
      scheduler: frameScheduler,
      fallbackIntervalMs:
        options.frameFlushIntervalMs ?? CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS,
      maxBufferedKeys: options.maxBufferedFrameKeys ?? CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_KEYS,
      maxBufferedCodeUnitsPerKey:
        options.maxBufferedFrameCodeUnitsPerKey ??
        CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS_PER_KEY,
      maxBufferedCodeUnits:
        options.maxBufferedFrameCodeUnits ?? CODEX_FRAME_TEXT_DELTA_MAX_BUFFERED_CODE_UNITS,
      onFlush: commitFrameText,
    });
    const outputQueue = new CodexCommandOutputQueue({
      scheduler: outputScheduler,
      flushIntervalMs: options.outputFlushIntervalMs ?? CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS,
      maxBufferedChars: options.maxBufferedOutputChars ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS,
      maxBufferedKeys: options.maxBufferedOutputKeys ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_KEYS,
      maxBufferedUpdates:
        options.maxBufferedOutputUpdates ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UPDATES,
      maxBufferedUtf8Bytes:
        options.maxBufferedOutputUtf8Bytes ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_UTF8_BYTES,
      onFlush: commitCommandOutput,
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        frameQueue.dispose();
        outputQueue.dispose();
      }),
    );

    return CodexConversationDeltaBufferRuntime.of({
      enqueueFrameText: (update) => {
        const first = frameQueue.enqueue(update);
        if (first.accepted) return;

        // A pressure cut publishes the already bounded batch before accepting more work.
        frameQueue.flushNow({ terminalDrainCommit: false });
        const retry = frameQueue.enqueue(update);
        if (retry.accepted) return;

        // One individually over-budget delta is never retained and is never lost.
        commitFrameText([update]);
      },
      enqueueCommandOutput: (update) => {
        outputQueue.enqueue(update);
      },
      drainFrameText: (conversationId, observedAtMs) => {
        terminalObservedAtMsByConversation.set(conversationId, observedAtMs);
        try {
          frameQueue.flushConversationNow(conversationId, { terminalDrainCommit: true });
        } finally {
          terminalObservedAtMsByConversation.delete(conversationId);
        }
      },
      clear: (conversationId) => {
        frameQueue.discardConversation(conversationId);
        outputQueue.discardConversation(conversationId);
      },
    });
  });
