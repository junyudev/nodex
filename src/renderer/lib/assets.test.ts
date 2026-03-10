import { describe, expect, test } from "bun:test";

import { resolveAssetSourceToHttpUrl } from "./assets";
import { getAssetSource } from "../../shared/assets";

describe("assets helpers", () => {
  test("resolveAssetSourceToHttpUrl maps canonical nodex asset URI to flat asset route", () => {
    const source = getAssetSource("abc.png");

    expect(resolveAssetSourceToHttpUrl(source)).toBe(
      "http://localhost:51283/api/assets/abc.png",
    );
  });

  test("resolveAssetSourceToHttpUrl passes through non-asset URLs", () => {
    const external = "https://example.com/image.png";
    expect(resolveAssetSourceToHttpUrl(external)).toBe(external);
  });

  test("resolveAssetSourceToHttpUrl passes through invalid asset URI", () => {
    const invalid = "nodex://assets/not/valid/path/extra";
    expect(resolveAssetSourceToHttpUrl(invalid)).toBe(invalid);
  });
});
