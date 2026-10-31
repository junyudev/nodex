import { describe, expect, test } from "vite-plus/test";
import { classifyImageAssetSource, resolveImageDisplaySource } from "./image-source";

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
