import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { describe, expect, test } from "vite-plus/test";
import {
  codexRuntimeError,
  isCodexThreadStopAlreadySettledRequestError,
} from "./CodexRuntimeError";

const requestFailure = (input: {
  readonly method: string;
  readonly code?: number;
  readonly message: string;
  readonly operation?: "receive-response" | "decode-payload";
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
