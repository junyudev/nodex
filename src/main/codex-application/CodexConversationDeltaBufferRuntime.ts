import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";
import {
  CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS,
  CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS,
  CodexCommandOutputQueue,
  type CodexCommandOutputScheduler,
  type CodexCommandOutputUpdate,
} from "../../shared/codex-conversation-state/codex-command-output-queue";
import {
  CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS,
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaScheduler,
  type CodexFrameTextDeltaUpdate,
} from "../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexConversationDeltaBufferRuntimeOptions {
  readonly frameFlushIntervalMs?: number;
  readonly outputFlushIntervalMs?: number;
  readonly maxBufferedOutputChars?: number;
}

export class CodexConversationDeltaBufferRuntime extends Context.Service<
  CodexConversationDeltaBufferRuntime,
  {
    readonly enqueueFrameText: (update: CodexFrameTextDeltaUpdate) => void;
    readonly enqueueCommandOutput: (update: CodexCommandOutputUpdate) => void;
    readonly drainBeforeCompletion: (conversationId: string, observedAtMs: number) => void;
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
 * Scoped scheduling for manager-local prose and command-output batches. Command output retains
 * a bounded tail per item and flushes on its timer or an explicit completion drain.
 */
export const make = (
  options: CodexConversationDeltaBufferRuntimeOptions = {},
): Effect.Effect<
  CodexConversationDeltaBufferRuntime["Service"],
  never,
  ConversationEntityMap | Scope.Scope
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationEntityMap;
    const frameTimer = yield* FiberHandle.make<void, never>();
    const outputTimer = yield* FiberHandle.make<void, never>();
    const frameScheduler = makeEffectTimerScheduler(yield* FiberHandle.runtime(frameTimer)());
    const outputScheduler = makeEffectTimerScheduler(yield* FiberHandle.runtime(outputTimer)());
    const runLog = yield* FiberSet.makeRuntime<never, void, never>();
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
        });
        for (const outcome of outcomes) {
          if (outcome.disposition === "applied") continue;
          runLog(
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
        const aggregate = conversations.current(threadId);
        aggregate?.commitCommandOutputDeltas({
          updates: threadUpdates,
          observedAtMs,
        });
      }
    };

    const frameQueue = new CodexFrameTextDeltaQueue({
      scheduler: frameScheduler,
      fallbackIntervalMs:
        options.frameFlushIntervalMs ?? CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS,
      onFlush: commitFrameText,
    });
    const outputQueue = new CodexCommandOutputQueue({
      scheduler: outputScheduler,
      flushIntervalMs: options.outputFlushIntervalMs ?? CODEX_COMMAND_OUTPUT_FLUSH_INTERVAL_MS,
      maxBufferedChars: options.maxBufferedOutputChars ?? CODEX_COMMAND_OUTPUT_MAX_BUFFERED_CHARS,
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
        frameQueue.enqueue(update);
      },
      enqueueCommandOutput: (update) => {
        outputQueue.enqueue(update);
      },
      drainBeforeCompletion: (conversationId, observedAtMs) => {
        // Completion drains the manager-global output and prose batches before applying lifecycle state.
        outputQueue.flushNow();
        terminalObservedAtMsByConversation.set(conversationId, observedAtMs);
        try {
          frameQueue.flushNow({ terminalDrainCommit: true });
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
