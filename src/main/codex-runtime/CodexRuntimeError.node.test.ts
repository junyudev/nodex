import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { describe, expect, test } from "vite-plus/test";
import {
  codexRuntimeError,
  isCodexThreadLifecycleAlreadyAppliedRequestError,
  isCodexThreadStopAlreadySettledRequestError,
} from "./CodexRuntimeError";

const requestFailure = (input: {
  readonly method: string;
  readonly code?: number;
  readonly message: string;
  readonly operation?: "receive-response" | "decode-payload";
  readonly data?: unknown;
}) =>
  codexRuntimeError({
    operation: "request",
    reason: "request",
    retryable: false,
    hostId: "local",
    method: input.method,
    cause: new CodexAppServerRequestError({
      code: input.code ?? -32_600,
      errorMessage: input.message,
      method: input.method,
      operation: input.operation ?? "receive-response",
      ...(input.data === undefined ? {} : { data: input.data }),
    }),
  });

describe("Codex Thread stop terminal response classification", () => {
  test("accepts only the exact unloaded Thread response for a skeleton read", () => {
    const input = { method: "thread/turns/list", threadId: "child-a" } as const;
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "thread/turns/list",
          message: "thread not loaded: child-a",
        }),
        input,
      ),
    ).toBe(true);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "thread/turns/list",
          message: "internal agent died while reading child-a",
        }),
        input,
      ),
    ).toBe(false);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "thread/turns/list",
          message: "thread not loaded: another-child",
        }),
        input,
      ),
    ).toBe(false);
  });

  test("accepts exact terminal interrupt responses but rejects method and protocol ambiguity", () => {
    const input = {
      method: "turn/interrupt",
      threadId: "child-a",
      turnId: "turn-a",
    } as const;
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({ method: "turn/interrupt", message: "no active turn to interrupt" }),
        input,
      ),
    ).toBe(true);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({ method: "turn/interrupt", message: "thread not found: child-a" }),
        input,
      ),
    ).toBe(true);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "turn/interrupt",
          code: -32_603,
          message: "failed to interrupt turn: internal error; agent loop died unexpectedly",
        }),
        input,
      ),
    ).toBe(true);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({ method: "turn/interrupt", message: "thread not loaded: child-a" }),
        input,
      ),
    ).toBe(false);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({ method: "turn/steer", message: "no active turn to interrupt" }),
        input,
      ),
    ).toBe(false);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "turn/interrupt",
          message: "no active turn to interrupt",
          operation: "decode-payload",
        }),
        input,
      ),
    ).toBe(false);
    expect(
      isCodexThreadStopAlreadySettledRequestError(
        requestFailure({
          method: "turn/interrupt",
          code: -32_603,
          message: "failed to interrupt turn: internal agent died",
        }),
        input,
      ),
    ).toBe(false);
  });
});

describe("Realtime stop missing Thread proof", () => {
  const input = { method: "thread/realtime/stop", threadId: "voice-thread" } as const;
  test("recognizes the exact native missing Thread response", () => {
    expect(
      isCodexThreadLifecycleAlreadyAppliedRequestError(
        requestFailure({ method: input.method, message: "thread not found: voice-thread" }),
        input,
      ),
    ).toBe(true);
  });
  test("does not grant retirement from another method, Thread, protocol failure or diagnostic", () => {
    for (const failure of [
      requestFailure({
        method: "thread/realtime/start",
        message: "thread not found: voice-thread",
      }),
      requestFailure({ method: input.method, message: "thread not found: another-thread" }),
      requestFailure({
        method: input.method,
        code: -32601,
        message: "method not found: thread/realtime/stop",
      }),
      requestFailure({
        method: input.method,
        code: -32603,
        message: "thread not found: voice-thread",
      }),
      requestFailure({
        method: input.method,
        operation: "decode-payload",
        message: "thread not found: voice-thread",
      }),
      requestFailure({
        method: input.method,
        message: "transport closed; thread not found: voice-thread",
      }),
      requestFailure({
        method: input.method,
        message: "thread not found: voice-thread",
        data: { diagnostic: true },
      }),
      codexRuntimeError({
        operation: "request",
        reason: "timeout",
        retryable: true,
        method: input.method,
        cause: new CodexAppServerRequestError({
          method: input.method,
          operation: "receive-response",
          code: -32600,
          errorMessage: "thread not found: voice-thread",
        }),
      }),
    ])
      expect(isCodexThreadLifecycleAlreadyAppliedRequestError(failure, input)).toBe(false);
  });
});
