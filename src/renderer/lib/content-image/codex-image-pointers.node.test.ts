import { describe, expect, test } from "vite-plus/test";
import {
  CodexConversationImageAssetError,
  isCodexImageAssetPointer,
  parseAbsoluteImagePath,
  shouldRetryCodexImageAssetQuery,
} from "./codex-image-pointers";

describe("Codex conversation image assets", () => {
  test("classifies only supported asset pointers and absolute filesystem paths", () => {
    expect(isCodexImageAssetPointer(" file-service://asset-1 ")).toBe(true);
    expect(isCodexImageAssetPointer("sediment://asset-2")).toBe(true);
    expect(isCodexImageAssetPointer("https://example.test/image.png")).toBe(false);
    expect(parseAbsoluteImagePath("/tmp/generated.png")).toBe("/tmp/generated.png");
    expect(parseAbsoluteImagePath("C:\\tmp\\generated.png")).toBe("C:/tmp/generated.png");
    expect(parseAbsoluteImagePath("data:image/png;base64,aW1hZ2U=")).toBe(null);
  });

  test("retries transient and status-free failures at most three times", () => {
    const transient = new CodexConversationImageAssetError("try again", 429);
    const permanent = new CodexConversationImageAssetError("missing", 404);
    const statusFree = new Error("network failed");

    expect(shouldRetryCodexImageAssetQuery(0, transient)).toBe(true);
    expect(shouldRetryCodexImageAssetQuery(2, statusFree)).toBe(true);
    expect(shouldRetryCodexImageAssetQuery(0, permanent)).toBe(false);
    expect(shouldRetryCodexImageAssetQuery(3, transient)).toBe(false);
  });
});
