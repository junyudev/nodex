import { expect, test } from "vite-plus/test";
import { CodexTurnDeliveryError } from "./codex-conversation-state/codex-turn-delivery";
import {
  encodeCodexNativeRequestFailure,
  isCodexNativeMethodUnsupported,
  unwrapCodexNativeRequestOutcome,
} from "./codex-native-request-outcome";

test("native failure code and data survive an adapter wrapper and structured cloning", () => {
  const native = Object.assign(new Error("expected active turn id `old` but found `new`"), {
    code: -32000,
    data: { actual: "new" },
  });
  const encoded = structuredClone({
    type: "error" as const,
    error: encodeCodexNativeRequestFailure(
      new Error("IPC command failed", { cause: new Error("Endpoint failed", { cause: native }) }),
    ),
  });
  try {
    unwrapCodexNativeRequestOutcome(encoded);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code: -32000, message: native.message, data: { actual: "new" } });
  }
});

test("unknown-method text only disables the matching native capability", () => {
  expect(
    isCodexNativeMethodUnsupported(
      { code: -32601, message: "Unavailable" },
      "thread/settings/update",
    ),
  ).toBe(true);
  expect(
    isCodexNativeMethodUnsupported(
      new Error("unknown variant thread/settings/update"),
      "thread/settings/update",
    ),
  ).toBe(true);
  expect(
    isCodexNativeMethodUnsupported(
      new Error("unknown method other/method"),
      "thread/settings/update",
    ),
  ).toBe(false);
});

test.each(["not-sent", "outcome-unknown"] as const)(
  "native delivery preserves the actual identity and %s stage across IPC",
  (stage) => {
    const native = Object.assign(new Error("Connection ended"), {
      code: -32000,
      data: { generation: 7 },
    });
    const delivery = { requestId: "turn/start:actual-wire-id", method: "turn/start", stage };
    const failure = new Error("Application failed", {
      cause: new CodexTurnDeliveryError(native.message, delivery, { cause: native }),
    });
    const outcome = structuredClone({
      type: "error" as const,
      error: encodeCodexNativeRequestFailure(failure),
    });
    expect(outcome.error).toEqual({
      code: -32000,
      message: native.message,
      data: native.data,
      delivery,
    });
    expect(() => unwrapCodexNativeRequestOutcome(outcome)).toThrow(CodexTurnDeliveryError);
    try {
      unwrapCodexNativeRequestOutcome(outcome);
    } catch (error) {
      expect(error).toMatchObject({
        delivery,
        message: native.message,
        cause: { code: -32000, data: native.data },
      });
    }
  },
);
