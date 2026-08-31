import { describe, expect, test } from "vitest";
import { toElectronIpcRendererError } from "./electron-ipc-error";

describe("Electron IPC error projection", () => {
  test("surfaces the deepest actionable tagged-error cause", () => {
    const cause = {
      _tag: "CodexIpcError",
      message: "CodexIpcError",
      operation: "codex:thread:start-for-session",
      cause: {
        message: "CodexSessionThreadLaunchError",
        cause: new Error("Agent runtime substituted the requested execution profile"),
      },
    };

    expect(toElectronIpcRendererError(cause).message).toBe(
      "Agent runtime substituted the requested execution profile",
    );
  });

  test("bounds and sanitizes renderer-visible messages", () => {
    const message = `bad\nrequest\u0000${"x".repeat(2_000)}`;
    const projected = toElectronIpcRendererError(new Error(message));

    expect(projected.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(projected.message.length).toBeLessThanOrEqual(1_000);
  });

  test("uses a stable fallback for opaque failures", () => {
    expect(toElectronIpcRendererError({ message: "CodexIpcError" }).message).toBe(
      "The requested operation could not be completed",
    );
  });
});
