import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  readPlainTextFromClipboard,
  writeTextToClipboard,
  writeTextToClipboardStrict,
} from "./clipboard";

const originalApi = window.api;
const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

afterEach(() => {
  vi.restoreAllMocks();
  window.api = originalApi;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
});

describe("renderer text clipboard", () => {
  test("reads native plaintext even when Web Clipboard permission is denied", async () => {
    const invoke = vi.fn(async () => ({ text: "native\r\nplaintext", html: "<b>rich</b>" }));
    const readText = vi.fn(async () => {
      throw new Error("Read permission denied");
    });
    window.api = { invoke, on: () => () => {} };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

    await expect(readPlainTextFromClipboard()).resolves.toBe("native\r\nplaintext");
    await expect(readPlainTextFromClipboard("text/plain")).resolves.toBe("native\r\nplaintext");

    expect(invoke).toHaveBeenCalledWith("clipboard:read-paste");
    expect(readText).not.toHaveBeenCalled();
  });

  test("does not substitute HTML or Markdown when the native clipboard has no plaintext", async () => {
    window.api = {
      invoke: vi.fn(async () => ({ html: "<b>rich</b>", markdown: "**rich**" })),
      on: () => () => {},
    };

    await expect(readPlainTextFromClipboard()).resolves.toBe("");
  });

  test.each(["text/html", "application/x-pierre-multi-selection"])(
    "does not misread ordinary text as the unsupported %s format",
    async (type) => {
      const invoke = vi.fn(async () => ({ text: '["first","second"]' }));
      const readText = vi.fn(async () => '["first","second"]');
      window.api = { invoke, on: () => () => {} };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

      await expect(readPlainTextFromClipboard(type)).resolves.toBe("");

      expect(invoke).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
    },
  );

  test("keeps native read failures visible instead of retrying a denied browser API", async () => {
    const readText = vi.fn(async () => "browser");
    window.api = {
      invoke: vi.fn(async () => {
        throw new Error("Native read failed");
      }),
      on: () => () => {},
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

    await expect(readPlainTextFromClipboard()).rejects.toThrow("Native read failed");

    expect(readText).not.toHaveBeenCalled();
  });

  test("reads plaintext through Web Clipboard when no native bridge exists", async () => {
    const readText = vi.fn(async () => "browser plaintext");
    window.api = undefined;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

    await expect(readPlainTextFromClipboard()).resolves.toBe("browser plaintext");

    expect(readText).toHaveBeenCalledOnce();
  });

  test("strict writes recover through the shared DOM fallback when Web Clipboard is denied", async () => {
    const browserWriteText = vi.fn(async () => {
      throw new Error("Clipboard permission denied");
    });
    const execCommand = vi.fn((command: string) => command === "copy");
    window.api = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await expect(writeTextToClipboardStrict("complete transcript")).resolves.toBeUndefined();

    expect(browserWriteText).toHaveBeenCalledWith("complete transcript");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  test("keeps browser clipboard support when no Electron bridge exists", async () => {
    const browserWriteText = vi.fn(async () => undefined);
    window.api = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });

    await expect(writeTextToClipboard("browser task")).resolves.toBe(true);

    expect(browserWriteText).toHaveBeenCalledWith("browser task");
  });
});
