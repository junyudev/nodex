import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";
import type { CodexComposerPredictionConfiguration } from "../codex-application/CodexComposerPrediction";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";

export interface AgentRuntimeSessionPredictionOptions {
  readonly transitions: Stream.Stream<AgentRuntimeActivityTransition>;
  readonly configuration: Effect.Effect<CodexComposerPredictionConfiguration | null>;
  /** A preference change cancels admission as well as already-dispatched native work. */
  readonly configurationChanges: Stream.Stream<unknown>;
}

/**
 * Prepares the next message when a bound root finishes, even with no Composer mounted.
 * The existing activity owner supplies the live connection; this never starts a cold Runtime,
 * observes execution separately, or caches predictions outside the native interaction owner.
 */
export const run = Effect.fn("AgentRuntimeSessionPredictions.run")(function* (
  options: AgentRuntimeSessionPredictionOptions,
) {
  const requests = yield* FiberMap.make<string, void, never>();
  const predict = Effect.fn("AgentRuntimeSessionPredictions.predict")(function* (
    transition: AgentRuntimeActivityTransition,
  ) {
    const { connection, rootThreadId, endedRun } = transition;
    if (!endedRun) return;
    const configuration = yield* options.configuration;
    if (!configuration?.is_enabled || !configuration.prompt.trim()) return;
    const authority = yield* connection.request("thread.authority", {
      threadId: rootThreadId,
      runId: endedRun.runId,
    });
    if (
      !authority ||
      authority.status !== "completed" ||
      authority.archived ||
      authority.hasNativeBackgroundWork ||
      authority.rootThreadId !== rootThreadId ||
      authority.threadId !== rootThreadId ||
      authority.runtimeGeneration !== connection.identity.runtimeGeneration ||
      authority.nativeThreadRef?.driver !== "codex"
    )
      return;
    // The Runtime owns deduplication, the source fence and the actual prediction fork.
    yield* connection
      .request("native.prediction.request", {
        threadId: rootThreadId,
        latestRunId: endedRun.runId,
        generationTrigger: "live",
        configuration,
      })
      .pipe(
        Effect.onInterrupt(() =>
          connection
            .request("native.prediction.clear", { threadId: rootThreadId })
            .pipe(Effect.timeout("2 seconds"), Effect.ignore),
        ),
      );
  });
  yield* options.configurationChanges.pipe(
    Stream.runForEach(() => FiberMap.clear(requests)),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* options.transitions.pipe(
    Stream.runForEach((transition) => {
      // Queued and delegated continuations still own the conversation's next step.
      if (
        !transition.endedRun ||
        transition.after !== null ||
        (transition.endedRun.status !== null && transition.endedRun.status !== "completed")
      )
        return Effect.void;
      const key = JSON.stringify([
        transition.connection.identity.runtimeGeneration,
        transition.rootThreadId,
        transition.endedRun.runId,
      ]);
      return FiberMap.run(
        requests,
        key,
        predict(transition).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Composer prediction could not be prepared").pipe(
              Effect.annotateLogs({ threadId: transition.rootThreadId, cause }),
            ),
          ),
        ),
        // Register cancellation before inference can yield to a preference change.
        { onlyIfMissing: true, startImmediately: false },
      );
    }),
  );
  yield* FiberMap.awaitEmpty(requests);
}, Effect.scoped);
