import * as Schema from "effect/Schema";

export const AcpRuntimeFailureReason = Schema.Literals([
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

export type AcpRuntimeFailureReason = typeof AcpRuntimeFailureReason.Type;

export class AcpRuntimeError extends Schema.TaggedError<AcpRuntimeError>()("AcpRuntimeError", {
  message: Schema.String,
  operation: Schema.String,
  reason: AcpRuntimeFailureReason,
  retryable: Schema.Boolean,
  pid: Schema.optionalKey(Schema.Int),
  method: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  protocolCode: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const acpRuntimeError = (input: {
  readonly operation: string;
  readonly reason: AcpRuntimeFailureReason;
  readonly retryable: boolean;
  readonly pid?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly protocolCode?: number;
  readonly cause?: unknown;
}): AcpRuntimeError =>
  new AcpRuntimeError({
    message: `ACP ${input.operation} failed`,
    operation: input.operation,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.protocolCode === undefined ? {} : { protocolCode: input.protocolCode }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

export const classifyAcpRuntimeError = (input: {
  readonly operation: string;
  readonly reason?: AcpRuntimeFailureReason;
  readonly retryable?: boolean;
  readonly pid?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly cause: unknown;
}): AcpRuntimeError => {
  if (Schema.is(AcpRuntimeError)(input.cause)) return input.cause;
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
  return acpRuntimeError({
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
