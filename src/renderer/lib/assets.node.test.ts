import { describe, expect, test } from "vite-plus/test";

import {
  clearManagedAssetDisplayUrlCache,
  resolveAssetSourceToDisplayUrl,
  resolveLocalImageDisplayUrl,
} from "./assets";
import { getAssetSource } from "../../shared/assets";

describe("assets helpers", () => {
  test("maps a canonical managed locator through its absolute path to app://fs", () => {
    const source = getAssetSource("abc.png");

    expect(resolveAssetSourceToDisplayUrl(source, () => "/profile/assets/abc.png")).toBe(
      "app://fs/@fs/profile/assets/abc.png",
    );
  });

  test("passes through non-asset URLs", () => {
    const external = "https://example.com/image.png";
    expect(resolveAssetSourceToDisplayUrl(external)).toBe(external);
  });

  test("passes through invalid asset URIs", () => {
    const invalid = "nodex://assets/not/valid/path/extra";
    expect(resolveAssetSourceToDisplayUrl(invalid)).toBe(invalid);
  });

  test("caches only successful managed path resolutions for the renderer lifetime", () => {
    clearManagedAssetDisplayUrlCache();
    const source = getAssetSource("cached.png");
    let calls = 0;
    const resolver = () => {
      calls += 1;
      return calls === 1 ? null : "/profile/assets/cached.png";
    };

    expect(resolveAssetSourceToDisplayUrl(source, resolver)).toBe(null);
    expect(resolveAssetSourceToDisplayUrl(source, resolver)).toBe(
      "app://fs/@fs/profile/assets/cached.png",
    );
    expect(resolveAssetSourceToDisplayUrl(source, resolver)).toBe(
      "app://fs/@fs/profile/assets/cached.png",
    );
    expect(calls).toBe(2);
  });

  test("does not encode an invalid preload result as a relative app path", () => {
    clearManagedAssetDisplayUrlCache();
    expect(
      resolveAssetSourceToDisplayUrl(getAssetSource("relative.png"), () => "relative.png"),
    ).toBe(null);
  });

  test("shows a file path an image names on this computer through app://fs", () => {
    expect(resolveLocalImageDisplayUrl("/Users/me/cache/shot #1.png")).toBe(
      "app://fs/@fs/Users/me/cache/shot%20%231.png",
    );
    expect(resolveLocalImageDisplayUrl("file:///Users/me/a%20b.png")).toBe(
      "app://fs/@fs/Users/me/a%20b.png",
    );
    expect(resolveLocalImageDisplayUrl("C:\\Users\\me\\shot.png")).toBe(
      "app://fs/@fs/C:/Users/me/shot.png",
    );
    expect(resolveLocalImageDisplayUrl("https://example.com/shot.png")).toBe(
      "https://example.com/shot.png",
    );
  });

  test("keeps a file URL's host, which names a network share", () => {
    expect(resolveLocalImageDisplayUrl("file://server/share/chart.png")).toBe(
      "app://fs/@fs//server/share/chart.png",
    );
    expect(resolveLocalImageDisplayUrl("file://localhost/tmp/chart.png")).toBe(
      "app://fs/@fs/tmp/chart.png",
    );
  });
});
