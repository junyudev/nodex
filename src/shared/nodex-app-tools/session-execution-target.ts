import { z } from "zod";

/** A child execution stays inside its Core product Session's bound root. */
export const sessionExecutionSchema = z.strictObject({
  threadId: z.string().trim().min(1).max(512),
});
export interface SessionExecutionTarget {
  readonly sessionId: string;
  readonly execution?: z.infer<typeof sessionExecutionSchema>;
}
export const runtimeSessionTarget = (target: SessionExecutionTarget) => ({
  sessionId: target.sessionId,
  ...(target.execution ? { threadId: target.execution.threadId } : {}),
});
