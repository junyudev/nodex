import { describe, expect, test } from "vite-plus/test";
import { cappedApproximateValueBytes } from "./codex-bounded-value-size";

describe("capped protocol value sizing", () => {
  test("short-circuits giant strings and sparse arrays at the requested budget", () => {
    const limit = 128;

    expect(cappedApproximateValueBytes("x".repeat(limit), limit)).toBe(limit + 1);
    expect(cappedApproximateValueBytes(new Array<unknown>(1_000_000), limit)).toBe(limit + 1);
  });

  test("counts shared or cyclic structures once without allocating a serialization", () => {
    const shared = { text: "small" };
    const cycle: { readonly shared: typeof shared; self?: unknown } = { shared };
    cycle.self = cycle;

    expect(cappedApproximateValueBytes(cycle, 1_024)).toBeLessThanOrEqual(1_024);
  });
});
