import { describe, expect, test } from "vite-plus/test";
import {
  parseCodexUserInputAutoResolutionActivityInput,
  parseCodexUserInputAutoResolutionTarget,
} from "./codex-user-input-auto-resolution";

describe("Codex user-input auto-resolution IPC validation", () => {
  test("accepts trimmed conversation identities and strict scalar request ids", () => {
    expect(
      parseCodexUserInputAutoResolutionActivityInput({
        hostId: " local ",
        conversationId: " thread-1 ",
      }),
    ).toEqual({ hostId: "local", conversationId: "thread-1" });
    expect(
      parseCodexUserInputAutoResolutionTarget({
        hostId: " local ",
        conversationId: " thread-1 ",
        requestId: 0,
      }),
    ).toEqual({
      hostId: "local",
      conversationId: "thread-1",
      requestId: 0,
    });
    expect(
      parseCodexUserInputAutoResolutionTarget({
        hostId: " local ",
        conversationId: "thread-1",
        requestId: "",
      }),
    ).toEqual({
      hostId: "local",
      conversationId: "thread-1",
      requestId: "",
    });
  });

  test.each([
    null,
    undefined,
    [],
    {},
    { conversationId: "thread-1", requestId: "request" },
    { hostId: " ", conversationId: "thread-1", requestId: "request" },
    { hostId: " local ", conversationId: "" },
    { hostId: " local ", conversationId: "   " },
    { hostId: " local ", conversationId: "thread-1", requestId: null },
    { hostId: " local ", conversationId: "thread-1", requestId: Number.NaN },
    { hostId: " local ", conversationId: "thread-1", requestId: Number.POSITIVE_INFINITY },
    { hostId: " local ", conversationId: "thread-1", requestId: true },
  ])("rejects malformed input %#", (input) => {
    expect(parseCodexUserInputAutoResolutionTarget(input)).toBeNull();
  });
});
