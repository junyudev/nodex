import { describe, expect, test } from "vite-plus/test";
import { readableIpcError } from "./ipc-error-message";

describe("readableIpcError", () => {
  test("keeps only the reason after Electron's channel prefix", () => {
    expect(
      readableIpcError(
        new Error(
          "Error invoking remote method 'codex:scheduled-automations:create': Error: This Agent is turned off. Turn it on in Settings.",
        ),
      ),
    ).toBe("This Agent is turned off. Turn it on in Settings.");
    expect(readableIpcError("Error invoking remote method 'inbox:send': Core refused it")).toBe(
      "Core refused it",
    );
  });

  test("falls back when a rejection carries no readable reason", () => {
    expect(
      readableIpcError(new Error("Error invoking remote method 'x': Error: "), "Not saved"),
    ).toBe("Not saved");
    expect(readableIpcError({ code: 1 }, "Not saved")).toBe("Not saved");
    expect(readableIpcError(undefined)).toBe("");
  });
});
