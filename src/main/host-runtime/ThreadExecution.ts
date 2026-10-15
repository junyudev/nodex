import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CodexThreadExecution } from "../codex-application/CodexThreadExecution";
import type { ManagedWorktreeHandoffPreparation } from "../codex-application/ManagedWorktreeHandoff";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class ThreadExecutionError extends Schema.TaggedError<ThreadExecutionError>()(
  "ThreadExecutionError",
  { operation: Schema.String, threadId: Schema.String, cause: Schema.Defect() },
) {}

/** The handoff transaction chooses execution from durable backend authority. */
export class ThreadExecution extends Context.Service<
  ThreadExecution,
  {
    readonly read: (
      threadId: string,
      destinationHostId?: string | null,
    ) => Effect.Effect<CodexThreadExecutionLocation, ThreadExecutionError>;
    readonly stop: (threadId: string) => Effect.Effect<void, ThreadExecutionError>;
    readonly setRecoveryRequired: (
      threadId: string,
      required: boolean,
    ) => Effect.Effect<void, ThreadExecutionError>;
    readonly withHandoff: <A, E, R>(
      threadId: string,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ThreadExecutionError, R>;
    readonly withRuntimeLocation: <A, E, R>(
      threadId: string,
      location: CodexThreadExecutionLocation,
      preparation: ManagedWorktreeHandoffPreparation | null,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ThreadExecutionError, R>;
    readonly commit: (
      threadId: string,
      location: CodexThreadExecutionLocation,
    ) => Effect.Effect<void, ThreadExecutionError>;
    readonly followUp: (
      threadId: string,
      prompt: string,
    ) => Effect.Effect<void, ThreadExecutionError>;
  }
>()("nodex/main/host-runtime/ThreadExecution") {}

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const codex = yield* CodexThreadExecution;
  const error = (operation: string, threadId: string, cause: unknown) =>
    new ThreadExecutionError({ operation, threadId, cause });
  const authority = Effect.fn("ThreadExecution.authority")(function* (threadId: string) {
    const thread = yield* workspace
      .getThread(threadId)
      .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (!thread) return yield* error("read", threadId, new Error("Chat was not found"));
    if (thread.backendBinding.kind !== "codex")
      return yield* error(
        "read",
        threadId,
        new Error("This Session executes through Agent Runtime"),
      );
    return thread;
  });
  const mapped = <A, E, R>(operation: string, threadId: string, use: Effect.Effect<A, E, R>) =>
    use.pipe(Effect.mapError((cause) => error(operation, threadId, cause)));
  const owned = <A, E, R>(operation: string, threadId: string, use: Effect.Effect<A, E, R>) =>
    authority(threadId).pipe(Effect.andThen(mapped(operation, threadId, use)));
  return ThreadExecution.of({
    read: (threadId) => owned("read", threadId, codex.read(threadId)),
    setRecoveryRequired: (threadId, required) =>
      mapped("set-recovery-required", threadId, codex.setRecoveryRequired(threadId, required)),
    withHandoff: (threadId, use) =>
      owned("handoff-admission", threadId, codex.withHandoff(threadId, use)),
    stop: (threadId) => owned("stop", threadId, codex.stop(threadId)),
    withRuntimeLocation: (threadId, location, preparation, use) =>
      owned(
        "switch-runtime",
        threadId,
        codex.switchRuntime(threadId, location, preparation).pipe(Effect.andThen(use)),
      ),
    commit: (threadId, location) => owned("commit", threadId, codex.commit(threadId, location)),
    followUp: (threadId, prompt) => owned("follow-up", threadId, codex.followUp(threadId, prompt)),
  });
});

export const live = Layer.effect(ThreadExecution, make);
