import type { Readback } from "../../../shared/readback";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";

/** The Runtime operations a Readback acts through; tests substitute them. */
export interface ReadbackExecution {
  readonly message: typeof agentRuntimeRuntime.message;
  readonly stop: typeof agentRuntimeRuntime.stop;
}

/**
 * Sends a correction to the chat that spoke, without opening it. While the Run is working the
 * Runtime delivers it the way that chat's Agent takes guidance mid-Run (steering, or stopping and
 * restarting with it); once the Run has ended it starts the next one.
 */
export async function replyToReadback(
  readback: Readback,
  text: string,
  execution: ReadbackExecution = agentRuntimeRuntime,
): Promise<void> {
  const reply = text.trim();
  if (reply.length === 0) return;
  await execution.message({
    sessionId: readback.sessionId,
    message: { messageId: createUuidV7(), text: reply },
    intent: "auto",
  });
}

/** Stops exactly the Run the Readback describes; a later Run of the same chat keeps going. */
export async function stopReadbackRun(
  readback: Readback,
  execution: ReadbackExecution = agentRuntimeRuntime,
): Promise<void> {
  await execution.stop({
    sessionId: readback.sessionId,
    threadId: readback.threadId,
    runId: readback.runId,
  });
}
