import type { ToolFailure } from "../../shared/nodex-agent-tools";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface NodexAgentDynamicExecutionContext {
  readonly threadId: string;
  readonly callId: string;
  readonly operationId: string;
  readonly authority: NodexAgentTurnContext | null;
}

export function toolFailure(
  code: ToolFailure["error"]["code"],
  message: string,
  recovery: ToolFailure["error"]["recovery"],
  retryable = false,
): ToolFailure {
  return {
    error: { code, message, retryable, recovery },
  };
}

export class NodexAgentDynamicToolFailure extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.error.message);
    this.name = "NodexAgentDynamicToolFailure";
  }
}

export function fail(failure: ToolFailure): never {
  throw new NodexAgentDynamicToolFailure(failure);
}

export function actorProject(context: NodexAgentDynamicExecutionContext): string | null {
  if (context.authority) return context.authority.actorProjectId;
  return fail(
    toolFailure(
      "authorization_denied",
      "This Nodex tool requires verified execution authority",
      "start_new_task",
    ),
  );
}

export function withExecutionTimeout<T, E, R>(
  operation: Effect.Effect<T, E, R>,
  timeoutMs: number,
): Effect.Effect<T, E | NodexAgentDynamicToolFailure, R> {
  return operation.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new NodexAgentDynamicToolFailure(
            toolFailure(
              "timeout",
              "The Nodex write did not finish within its execution window; retry the same call identity",
              "retry_same",
              true,
            ),
          ),
        ),
    }),
  );
}
