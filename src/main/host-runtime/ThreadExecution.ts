import * as path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { NativeConversationExtension } from "../app-tools/NativeConversationExtension";
import { CodexThreadExecution } from "../codex-application/CodexThreadExecution";
import type { ManagedWorktreeHandoffPreparation } from "../codex-application/ManagedWorktreeHandoff";
import { rewriteExecutionWorkspaceRoots } from "../codex/codex-execution-workspace-roots";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { createOperationId } from "../core-runtime/operation-identity";

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
  const native = yield* NativeConversationExtension;
  const error = (operation: string, threadId: string, cause: unknown) =>
    new ThreadExecutionError({ operation, threadId, cause });
  const authority = Effect.fn("ThreadExecution.authority")(function* (threadId: string) {
    const thread = yield* workspace
      .getThread(threadId)
      .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (!thread) return yield* error("read", threadId, new Error("Chat was not found"));
    if (thread.backendBinding.kind === "acp")
      return yield* error(
        "read",
        threadId,
        new Error("This Agent does not support moving execution"),
      );
    if (thread.backendBinding.kind === "claude" && thread.executionHostId !== "local")
      return yield* error("read", threadId, new Error("Claude execution requires the local host"));
    return thread;
  });
  const read = Effect.fn("ThreadExecution.read")(function* (
    threadId: string,
    destinationHostId?: string | null,
  ) {
    const thread = yield* authority(threadId);
    if (thread.backendBinding.kind === "codex")
      return yield* codex
        .read(threadId)
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (destinationHostId && destinationHostId !== "local")
      return yield* error(
        "read",
        threadId,
        new Error("Claude execution can only move on the local host"),
      );
    const context = yield* workspace
      .readThreadExecutionContext(threadId)
      .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (
      !thread.cwd ||
      !path.isAbsolute(thread.cwd) ||
      !context ||
      context.projectId !== thread.projectId
    )
      return yield* error("read", threadId, new Error("Chat execution location is unavailable"));
    const primary = context.writableRoots[0];
    if (!primary || !path.isAbsolute(primary))
      return yield* error("read", threadId, new Error("Chat workspace root is unavailable"));
    const workspaceRoots = yield* Effect.try({
      try: () =>
        rewriteExecutionWorkspaceRoots({
          sourcePrimary: primary,
          targetPrimary: primary,
          workspaceRoots: context.writableRoots,
        }),
      catch: (cause) => error("read", threadId, cause),
    });
    return {
      hostId: "local",
      cwd: thread.cwd,
      workspaceRoots,
      projectId: thread.projectId,
      managedWorktreePath: thread.managedWorktreePath,
      projectlessOutputDirectory: thread.projectlessOutputDirectory,
      projectlessWorkspaceBrowserRoot: thread.projectlessWorkspaceBrowserRoot,
    } satisfies CodexThreadExecutionLocation;
  });
  return ThreadExecution.of({
    read,
    // Recovery must seal both admission owners even when Core cannot report backend authority.
    // These setters only change admission markers; they never start or connect a runtime.
    setRecoveryRequired: (threadId, required) =>
      codex.setRecoveryRequired(threadId, required).pipe(
        Effect.mapError((cause) => error("set-recovery-required", threadId, cause)),
        Effect.andThen(
          native
            .setExecutionRecoveryRequired(threadId, required)
            .pipe(Effect.mapError((cause) => error("set-recovery-required", threadId, cause))),
        ),
      ),
    withHandoff: (threadId, use) =>
      authority(threadId).pipe(
        Effect.flatMap((thread) =>
          (thread.backendBinding.kind === "codex"
            ? codex.withHandoff(threadId, use)
            : native.withExecutionHandoff(threadId, use)
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? error("handoff-admission", threadId, cause) : cause,
            ),
          ),
        ),
      ),
    stop: Effect.fn("ThreadExecution.stop")(function* (threadId) {
      const thread = yield* authority(threadId);
      yield* (
        thread.backendBinding.kind === "codex"
          ? codex.stop(threadId)
          : native.stopExecution(threadId)
      ).pipe(Effect.mapError((cause) => error("stop", threadId, cause)));
    }),
    withRuntimeLocation: (threadId, location, preparation, use) =>
      authority(threadId).pipe(
        Effect.flatMap((thread) => {
          if (thread.backendBinding.kind === "codex")
            return codex.switchRuntime(threadId, location, preparation).pipe(
              Effect.mapError((cause) => error("switch-runtime", threadId, cause)),
              Effect.andThen(use),
            );
          if (location.hostId !== "local" || preparation?.prepared.direction === "cross-host")
            return Effect.fail(
              error(
                "switch-runtime",
                threadId,
                new Error("Claude execution can only move on the local host"),
              ),
            );
          return native
            .withExecutionLocation(threadId, location, use)
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof Error ? error("switch-runtime", threadId, cause) : cause,
              ),
            );
        }),
      ),
    commit: Effect.fn("ThreadExecution.commit")(function* (threadId, location) {
      const thread = yield* authority(threadId);
      if (thread.backendBinding.kind === "codex")
        return yield* codex
          .commit(threadId, location)
          .pipe(Effect.mapError((cause) => error("commit", threadId, cause)));
      if (
        location.hostId !== "local" ||
        location.projectId !== thread.projectId ||
        !path.isAbsolute(location.cwd)
      )
        return yield* error(
          "commit",
          threadId,
          new Error("Claude execution requires its current local Project"),
        );
      const committed = yield* workspace
        .setThreadExecutionLocation(threadId, {
          executionHostId: location.hostId,
          cwd: location.cwd,
          managedWorktreePath: location.managedWorktreePath,
          runtimeWorkspaceRoots: location.workspaceRoots,
          projectlessOutputDirectory: location.projectlessOutputDirectory,
          projectlessWorkspaceBrowserRoot: location.projectlessWorkspaceBrowserRoot,
        })
        .pipe(Effect.mapError((cause) => error("commit", threadId, cause)));
      if (!committed)
        return yield* error(
          "commit",
          threadId,
          new Error("Chat disappeared while moving execution"),
        );
    }),
    followUp: Effect.fn("ThreadExecution.followUp")(function* (threadId, prompt) {
      const thread = yield* authority(threadId);
      if (thread.backendBinding.kind === "codex")
        return yield* codex
          .followUp(threadId, prompt)
          .pipe(Effect.mapError((cause) => error("follow-up", threadId, cause)));
      yield* native
        .submit({ threadId, prompt, operationId: createOperationId("thread-execution.follow-up") })
        .pipe(Effect.mapError((cause) => error("follow-up", threadId, cause)));
    }),
  });
});

export const live = Layer.effect(ThreadExecution, make);
