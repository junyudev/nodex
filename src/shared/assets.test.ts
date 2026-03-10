import { describe, expect, test } from "bun:test";

import {
  getAssetSource,
  parseAssetSource,
} from "./assets";

describe("shared asset helpers", () => {
  test("getAssetSource returns the canonical asset URI", () => {
    expect(getAssetSource("abc.png")).toBe("nodex://assets/abc.png");
  });

  test("parseAssetSource accepts the canonical asset URI", () => {
    const parsed = parseAssetSource("nodex://assets/abc.png");

    expect(parsed?.fileName).toBe("abc.png");
    expect(Boolean(parsed)).toBeTrue();
  });

  test("parseAssetSource rejects nested asset paths", () => {
    expect(parseAssetSource("nodex://assets/default/abc.png") === null).toBeTrue();
  });

  test("parseAssetSource rejects invalid nested asset paths", () => {
    expect(parseAssetSource("nodex://assets/default/extra/abc.png") === null).toBeTrue();
  });
});
