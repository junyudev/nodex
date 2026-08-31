import * as Schema from "effect/Schema";
import {
  CodexAppServerError,
  CodexAppServerRequestError,
} from "@nodex/effect-codex-app-server/errors";

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
const isCodexAppServerRequestError = Schema.is(CodexAppServerRequestError);

export type CodexThreadStopRequest =
  | { readonly method: "thread/turns/list"; readonly threadId: string }
  | { readonly method: "turn/interrupt"; readonly threadId: string; readonly turnId: string };

/** Recognizes only current app-server responses that prove the requested Turn is no longer live. */
export const isCodexThreadStopAlreadySettledRequestError = (
  error: unknown,
  input: CodexThreadStopRequest,
): boolean => {
  if (!Schema.is(CodexRuntimeError)(error)) return false;
  if (error.reason !== "request" || error.method !== input.method) return false;
  if (!isCodexAppServerRequestError(error.cause)) return false;
  if (error.cause.method !== input.method || error.cause.operation !== "receive-response") {
    return false;
  }
  if (error.cause.data !== undefined && error.cause.data !== null) return false;

  if (input.method === "thread/turns/list") {
    return (
      error.cause.code === -32_600 && error.cause.message === `thread not loaded: ${input.threadId}`
    );
  }

  if (error.cause.code === -32_600) {
    return (
      error.cause.message === `thread not found: ${input.threadId}` ||
      error.cause.message === "no active turn to interrupt"
    );
  }

  return (
    error.cause.code === -32_603 &&
    error.cause.message === "failed to interrupt turn: internal error; agent loop died unexpectedly"
  );
};

export type CodexThreadLifecycleRequestMethod = "thread/archive" | "thread/delete" | "thread/read";

/**
 * Recognizes the exact app-server response proving that a lifecycle mutation is already applied.
 *
 * The method, response operation, JSON-RPC code, Thread id, and current Codex message all belong
 * to the proof. Transport, host, timeout, protocol, and method-not-found failures are never
 * lifecycle authority, even when a nested diagnostic happens to contain "not found".
 */
export const isCodexThreadLifecycleAlreadyAppliedRequestError = (
  error: unknown,
  input: {
    readonly method: CodexThreadLifecycleRequestMethod;
    readonly threadId: string;
  },
): boolean => {
  if (!Schema.is(CodexRuntimeError)(error)) return false;
  if (error.reason !== "request" || error.method !== input.method) return false;
  if (!isCodexAppServerRequestError(error.cause)) return false;
  if (error.cause.method !== input.method || error.cause.operation !== "receive-response") {
    return false;
  }
  if (error.cause.data !== undefined && error.cause.data !== null) return false;

  const expected = (() => {
    switch (input.method) {
      case "thread/archive":
        return {
          code: -32_603,
          message: `failed to archive session: thread ${input.threadId} not found`,
        } as const;
      case "thread/delete":
        return { code: -32_600, message: `thread not found: ${input.threadId}` } as const;
      case "thread/read":
        return { code: -32_600, message: `thread not loaded: ${input.threadId}` } as const;
    }
  })();
  return error.cause.code === expected.code && error.cause.message === expected.message;
};

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
