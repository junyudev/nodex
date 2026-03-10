import { describe, expect, test } from "bun:test";
import { resolveExternalImageSource } from "./image-block";

describe("image block external source resolution", () => {
  test("rewrites canonical nodex asset URI to the flat API image URL", () => {
    const resolved = resolveExternalImageSource("nodex://assets/plan.png");
    expect(resolved).toBe("http://localhost:51283/api/assets/plan.png");
  });

  test("keeps standard URLs unchanged", () => {
    const source = "https://example.com/plan.png";
    expect(resolveExternalImageSource(source)).toBe(source);
  });
});
