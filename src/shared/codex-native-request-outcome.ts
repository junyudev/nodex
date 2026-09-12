import {
  CodexTurnDeliveryError,
  type CodexRequestDelivery,
  type CodexTurnDelivery,
} from "./codex-conversation-state/codex-turn-delivery";

/** Native errors cross process boundaries as data so codes and messages survive Electron IPC. */
export interface CodexNativeRequestFailure {
  readonly code: number | null;
  readonly message: string;
  readonly data?: unknown;
  readonly delivery?: CodexRequestDelivery;
}
export interface CodexNativeResponseMetadata {
  readonly abandonmentReason?: "timeout" | "disposed";
  readonly hostId?: string;
  readonly hostMetrics?: import("@nodex/effect-codex-app-server/protocol").CodexAppServerRequestMetrics;
  readonly receivedAtMs?: number;
  readonly requestMethod?: string;
  readonly trace?: import("./codex-request-lifecycle").CodexRequestTraceContext | null;
}
export type CodexNativeRequestOutcome<T> = CodexNativeResponseMetadata &
  (
    | { readonly type: "result"; readonly result: T }
    | { readonly type: "error"; readonly error: CodexNativeRequestFailure }
  );

export interface CodexNativeResponseMessage {
  readonly type: "mcp-response";
  readonly hostId: string;
  readonly hostMetrics?: CodexNativeResponseMetadata["hostMetrics"];
  readonly receivedAtMs?: number;
  readonly requestMethod?: string;
  readonly trace?: import("./codex-request-lifecycle").CodexRequestTraceContext | null;
  readonly message: {
    readonly id: string;
    readonly result?: unknown;
    readonly error?: CodexNativeRequestFailure;
  };
}

export type CodexNativeRequestDeliveryUpdate =
  | { readonly type: "outcome-unknown"; readonly delivery: CodexTurnDelivery }
  | {
      readonly type: "failed";
      readonly delivery: CodexRequestDelivery;
      readonly message: string;
    };

export interface CodexNativeDeliveryMessage {
  readonly type: "mcp-request-delivery";
  readonly hostId: string;
  readonly update: CodexNativeRequestDeliveryUpdate;
}

export type CodexNativeResponseEnvelope = CodexNativeResponseMessage | CodexNativeDeliveryMessage;

export function encodeCodexNativeRequestFailure(cause: unknown): CodexNativeRequestFailure {
  let current = cause;
  let message = "Native request failed";
  let delivery: CodexRequestDelivery | undefined;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof CodexTurnDeliveryError) delivery ??= current.delivery;
    const value = current as { code?: unknown; message?: unknown; data?: unknown; cause?: unknown };
    if (typeof value.message === "string" && value.message) message = value.message;
    if (typeof value.code === "number")
      return {
        code: value.code,
        message,
        ...(value.data !== undefined ? { data: value.data } : {}),
        ...(delivery ? { delivery } : {}),
      };
    current = value.cause;
  }
  if (typeof current === "string" && current) message = current;
  return { code: null, message, ...(delivery ? { delivery } : {}) };
}

export class CodexNativeRequestError extends Error {
  readonly code: number | null;
  readonly data: unknown;
  constructor(failure: CodexNativeRequestFailure) {
    super(failure.message);
    this.name = "CodexNativeRequestError";
    this.code = failure.code;
    this.data = failure.data;
  }
}

export function unwrapCodexNativeRequestOutcome<T>(outcome: CodexNativeRequestOutcome<T>): T {
  if (outcome.type === "error") throw createCodexNativeRequestError(outcome.error);
  return outcome.result;
}

export function createCodexNativeRequestError(failure: CodexNativeRequestFailure): Error {
  const error = new CodexNativeRequestError(failure);
  return failure.delivery
    ? new CodexTurnDeliveryError(error.message, failure.delivery, { cause: error })
    : error;
}

export function isCodexNativeMethodUnsupported(error: unknown, method: string): boolean {
  const failure = encodeCodexNativeRequestFailure(error);
  const message = failure.message.toLowerCase();
  return (
    failure.code === -32601 ||
    message.includes("method not found") ||
    ((message.includes("unknown method") || message.includes("unknown variant")) &&
      message.includes(method))
  );
}
