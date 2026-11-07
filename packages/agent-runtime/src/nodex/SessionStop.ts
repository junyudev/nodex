import { CommandId, ThreadId } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import { DispatchModeLimit, type DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

/** Stop reaches the conversation and its delegated subtree through their durable command owners. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const threads = yield* ThreadManagementService;
  return Effect.fn("SessionStop.execute")(function* (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
    readonly modeLimit?: DispatchModes | undefined;
  }) {
    const shell = yield* orchestrator.getThreadShell(input.threadId);
    if (!shell) return yield* Effect.fail(new Error("Session execution is unavailable"));
    yield* orchestrator
      .dispatch({
        type: "thread.stop",
        threadId: input.threadId,
        commandId: input.commandId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      .pipe(Effect.provideService(DispatchModeLimit, input.modeLimit));
    yield* threads
      .stopDelegatedTasks(input)
      .pipe(Effect.provideService(DispatchModeLimit, input.modeLimit));
    return {
      stopped: shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0,
    };
  });
});
