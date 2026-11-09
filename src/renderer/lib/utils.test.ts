import { describe, expect, test } from "vite-plus/test";

import { cn, omitRecordKey } from "./utils";

describe("cn icon geometry", () => {
  test("keeps the last Nodex icon size", () => {
    expect(cn("icon-xs", "icon-2xs")).toBe("icon-2xs");
  });

  test("resolves two-axis icon and Tailwind sizes by order", () => {
    expect(cn("size-4", "icon-2xs")).toBe("icon-2xs");
    expect(cn("icon-2xs", "size-4")).toBe("size-4");
  });

  test("preserves a later single-axis override", () => {
    expect(cn("icon-2xs", "w-8", "h-6")).toBe("icon-2xs w-8 h-6");
    expect(cn("w-8", "h-6", "icon-2xs")).toBe("icon-2xs");
  });
});

describe("omitRecordKey", () => {
  test("drops only the named key", () => {
    expect(omitRecordKey({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });

  test("returns the same record when the key is absent, including inherited names", () => {
    const record = { a: 1 };
    expect(omitRecordKey(record, "b")).toBe(record);
    expect(omitRecordKey(record, "toString")).toBe(record);
  });
});
