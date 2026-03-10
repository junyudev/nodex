import { describe, expect, test } from "bun:test";

import { resolveOccurrenceScopeOptions } from "./occurrence-scope-options";

describe("resolveOccurrenceScopeOptions", () => {
  test("shows only this and this-and-future on non-first recurring occurrences", () => {
    const options = resolveOccurrenceScopeOptions(false);
    expect(JSON.stringify(options.map((option) => option.scope))).toBe(
      JSON.stringify(["this", "this-and-future"]),
    );
    expect(options[1]?.isPrimary).toBeTrue();
  });

  test("shows only this and all on first recurring occurrence", () => {
    const options = resolveOccurrenceScopeOptions(true);
    expect(JSON.stringify(options.map((option) => option.scope))).toBe(
      JSON.stringify(["this", "all"]),
    );
    expect(options[1]?.label).toBe("All occurrences");
  });
});
