import { describe, expect, test } from "bun:test";
import { createUuidV7, createUuidV7FromTimestamp, isUuidV7 } from "./card-id";

describe("card-id", () => {
  test("creates canonical lowercase UUID-v7 values", () => {
    const value = createUuidV7();
    expect(isUuidV7(value)).toBeTrue();
    expect(value).toBe(value.toLowerCase());
  });

  test("creates monotonic timestamp-derived UUID-v7 values", () => {
    const first = createUuidV7FromTimestamp(1_762_400_000_000, 0);
    const second = createUuidV7FromTimestamp(1_762_400_000_000, 1);
    const third = createUuidV7FromTimestamp(1_762_400_000_001, 0);

    expect(isUuidV7(first)).toBeTrue();
    expect(isUuidV7(second)).toBeTrue();
    expect(isUuidV7(third)).toBeTrue();
    expect(first < second).toBeTrue();
    expect(second < third).toBeTrue();
  });

  test("rejects non-v7 values", () => {
    expect(isUuidV7("not-a-uuid")).toBeFalse();
    expect(isUuidV7("550e8400-e29b-41d4-a716-446655440000")).toBeFalse();
  });
});
