import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
  }) {
    const shell = yield* orchestrator.getThreadShell(input.threadId);
    if (!shell) return yield* Effect.fail(new Error("Session execution is unavailable"));
    yield* orchestrator.dispatch({ type: "thread.stop", ...input });
    yield* threads.stopDelegatedTasks(input);
    return {
      stopped: shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0,
    };
  });
});
