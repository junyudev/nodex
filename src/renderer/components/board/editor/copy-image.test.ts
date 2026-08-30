import { describe, expect, test } from "vite-plus/test";

import { copyImageToClipboardWithPort } from "./copy-image";

describe("copy image helper", () => {
  test("passes the raw source through the clipboard image port", async () => {
    const invokeCalls: unknown[][] = [];
    const result = await copyImageToClipboardWithPort(
      "nodex://assets/diagram.png",
      async (source) => {
        invokeCalls.push([source]);
        return { ok: true };
      },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(invokeCalls)).toBe(JSON.stringify([["nodex://assets/diagram.png"]]));
  });

  test("returns the structured failure result from the native clipboard path", async () => {
    const result = await copyImageToClipboardWithPort(
      "https://example.com/image.png",
      async () => ({ ok: false, message: "Could not load the image file." }),
    );

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe("Could not load the image file.");
  });

  test("normalizes unexpected invoke failures to a user-facing copy error", async () => {
    const result = await copyImageToClipboardWithPort("nodex://assets/diagram.png", async () => {
      throw new Error("boom");
    });

    expect(result.ok).toBe(false);
    expect("message" in result ? result.message : "").toBe("boom");
  });
});
