import { describe, expect, test } from "vite-plus/test";
import {
  CodexConversationImageAssetError,
  isCodexImageAssetPointer,
  parseAbsoluteImagePath,
  shouldRetryCodexImageAssetQuery,
} from "./codex-image-pointers";
import { classifyImageAssetSource, resolveImageDisplaySource } from "./image-source";

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

describe("image sources", () => {
  test("classifies data, managed, pointer, remote, and local sources", () => {
    expect(classifyImageAssetSource("data:image/png;base64,YQ==").kind).toBe("data");
    expect(classifyImageAssetSource("nodex://assets/hero.png").kind).toBe("managed");
    expect(classifyImageAssetSource("nodex://assets/folder/hero.png").kind).toBe("invalid");
    expect(classifyImageAssetSource("file-service://asset-1").kind).toBe("pointer");
    expect(classifyImageAssetSource("https://example.test/hero.png").kind).toBe("remote");
    expect(classifyImageAssetSource("nodex-asset://managed/hero.png").kind).toBe("invalid");
    expect(classifyImageAssetSource("data:text/plain,hello").kind).toBe("invalid");
    expect(classifyImageAssetSource("/tmp/hero.png")).toMatchObject({
      kind: "local",
      localPath: "/tmp/hero.png",
    });
    expect(classifyImageAssetSource("file:///tmp/hero.png")).toMatchObject({
      kind: "local",
      localPath: "/tmp/hero.png",
    });
    expect(classifyImageAssetSource("javascript:alert(1)").kind).toBe("invalid");
  });

  test("only exposes local display URLs when the caller owns local-path access", () => {
    expect(resolveImageDisplaySource("/tmp/hero.png", { allowLocalPath: false })).toBe(null);
    expect(resolveImageDisplaySource("/tmp/hero.png", { allowLocalPath: true })).toBe(
      "app://fs/@fs/tmp/hero.png",
    );
    expect(
      resolveImageDisplaySource("nodex://assets/hero.png", {
        allowLocalPath: false,
        resolveManagedAssetPath: () => "/profile/assets/hero.png",
      }),
    ).toBe("app://fs/@fs/profile/assets/hero.png");
    expect(
      resolveImageDisplaySource("nodex://assets/missing.png", {
        allowLocalPath: false,
        resolveManagedAssetPath: () => null,
      }),
    ).toBe(null);
  });
});
