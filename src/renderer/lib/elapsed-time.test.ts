import { describe, expect, test } from "bun:test";
import { formatElapsedSince } from "./elapsed-time";

describe("formatElapsedSince", () => {
  test("matches sidebar-style elapsed labels", () => {
    const now = 1_000_000;

    expect(formatElapsedSince(now, now)).toBe("now");
    expect(formatElapsedSince(now - 59_000, now)).toBe("now");
    expect(formatElapsedSince(now - 60_000, now)).toBe("1m");
    expect(formatElapsedSince(now - 3_600_000, now)).toBe("1h");
    expect(formatElapsedSince(now - 86_400_000, now)).toBe("1d");
    expect(formatElapsedSince(now - 7 * 86_400_000, now)).toBe("1w");
    expect(formatElapsedSince(now - 30 * 86_400_000, now)).toBe("1mo");
    expect(formatElapsedSince(now - 365 * 86_400_000, now)).toBe("1y");
  });
});
