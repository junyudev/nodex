import * as Schema from "effect/Schema";

export const AgentRuntimeFailureReason = Schema.Literals([
  "spawn",
  "initialize",
  "protocol",
  "request",
  "request-cancelled",
  "authentication-required",
  "resource-not-found",
  "pressure",
  "capability",
  "authorization",
  "session-lost",
  "timeout",
  "closing",
]);

export type AgentRuntimeFailureReason = typeof AgentRuntimeFailureReason.Type;

export class AgentRuntimeError extends Schema.TaggedError<AgentRuntimeError>()(
  "AgentRuntimeError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: AgentRuntimeFailureReason,
    retryable: Schema.Boolean,
    pid: Schema.optionalKey(Schema.Int),
    method: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    protocolCode: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const agentRuntimeError = (input: {
  readonly operation: string;
  readonly reason: AgentRuntimeFailureReason;
  readonly retryable: boolean;
  readonly pid?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly protocolCode?: number;
  readonly cause?: unknown;
}): AgentRuntimeError =>
  new AgentRuntimeError({
    message: `${input.operation}: ${input.cause instanceof Error ? input.cause.message : "Agent operation failed"}`,
    operation: input.operation,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.protocolCode === undefined ? {} : { protocolCode: input.protocolCode }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

export const classifyAgentRuntimeError = (input: {
  readonly operation: string;
  readonly reason?: AgentRuntimeFailureReason;
  readonly retryable?: boolean;
  readonly pid?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly cause: unknown;
}): AgentRuntimeError => {
  if (Schema.is(AgentRuntimeError)(input.cause)) return input.cause;
  const requestCode =
    input.cause && typeof input.cause === "object" && "code" in input.cause
      ? (input.cause as { readonly code?: unknown }).code
      : undefined;
  const protocolCode = typeof requestCode === "number" ? requestCode : undefined;
  const requestReason =
    protocolCode === -32800
      ? "request-cancelled"
      : protocolCode === -32000
        ? "authentication-required"
        : protocolCode === -32002
          ? "resource-not-found"
          : "request";
  return agentRuntimeError({
    operation: input.operation,
    reason: input.reason ?? requestReason,
    retryable: input.retryable ?? false,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(protocolCode === undefined ? {} : { protocolCode }),
    cause: input.cause,
  });
};
