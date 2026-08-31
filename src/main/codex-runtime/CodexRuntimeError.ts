import * as Schema from "effect/Schema";
import { CodexAppServerError } from "@nodex/effect-codex-app-server/errors";

export const CodexRuntimeFailureReason = Schema.Literals([
  "spawn",
  "initialize",
  "outcome-unknown",
  "pressure",
  "timeout",
  "protocol",
  "session-lost",
  "host-unavailable",
  "request",
  "closing",
]);

export type CodexRuntimeFailureReason = typeof CodexRuntimeFailureReason.Type;

export class CodexRuntimeError extends Schema.TaggedError<CodexRuntimeError>()(
  "CodexRuntimeError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: CodexRuntimeFailureReason,
    retryable: Schema.Boolean,
    hostId: Schema.optionalKey(Schema.String),
    generation: Schema.optionalKey(Schema.Int),
    pid: Schema.optionalKey(Schema.Int),
    method: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const codexRuntimeError = (input: {
  readonly operation: string;
  readonly reason: CodexRuntimeFailureReason;
  readonly retryable: boolean;
  readonly hostId?: string;
  readonly generation?: number;
  readonly pid?: number;
  readonly method?: string;
  readonly cause?: unknown;
}): CodexRuntimeError =>
  new CodexRuntimeError({
    message: `Codex ${input.operation} failed`,
    operation: input.operation,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

const isCodexAppServerError = Schema.is(CodexAppServerError);

export const classifyCodexClientError = (input: {
  readonly operation: string;
  readonly cause: unknown;
  readonly hostId: string;
  readonly generation?: number;
  readonly pid?: number;
  readonly method?: string;
}): CodexRuntimeError => {
  if (Schema.is(CodexRuntimeError)(input.cause)) return input.cause;
  const clientError = isCodexAppServerError(input.cause) ? input.cause : undefined;
  const classification = (() => {
    switch (clientError?._tag) {
      case "CodexAppServerSpawnError":
        return { reason: "spawn", retryable: true } as const;
      case "CodexAppServerProcessExitedError":
      case "CodexAppServerTransportError":
      case "CodexAppServerInputStreamEndedError":
        return { reason: "session-lost", retryable: true } as const;
      case "CodexAppServerProtocolParseError":
      case "CodexAppServerIdentifierGenerationError":
        return { reason: "protocol", retryable: false } as const;
      case "CodexAppServerRequestError":
        return { reason: "request", retryable: clientError.code === -32_001 } as const;
      default:
        return { reason: "request", retryable: false } as const;
    }
  })();
  return codexRuntimeError({
    operation: input.operation,
    ...classification,
    hostId: input.hostId,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.method === undefined ? {} : { method: input.method }),
    cause: input.cause,
  });
};
