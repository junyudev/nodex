import { describe, expect, test } from "bun:test";

import { parseInlineContent } from "./parser-inline";
import { serializeInlineContent } from "./serializer-inline";

function roundTripInline(value: string): string {
  return serializeInlineContent(parseInlineContent(value));
}

function repeatRoundTrip(value: string, cycles: number): string {
  let current = value;
  for (let index = 0; index < cycles; index += 1) {
    current = roundTripInline(current);
  }
  return current;
}

describe("parser-inline link escapes", () => {
  test("escaped link labels remain stable across repeated round-trips", () => {
    const input = "[\\*\\*agents.md\\*\\*](http://agents.md)";
    const once = roundTripInline(input);
    const twice = roundTripInline(once);

    expect(once).toBe(input);
    expect(twice).toBe(input);
  });

  test("problematic markdown line is idempotent after first save", () => {
    const input =
      "**dump convex to **[**agents.md**](http://agents.md)** in case it: forgot to read about schema (and know nothing about convex)**";
    const once = repeatRoundTrip(input, 1);
    const afterMany = repeatRoundTrip(input, 22);

    expect(afterMany).toBe(once);

    const backslashRuns = [...afterMany.matchAll(/(\\+)\*/g)];
    expect(backslashRuns.length).toBe(4);
    expect(backslashRuns.every((match) => match[1].length === 1)).toBeTrue();
  });

  test("invalid span color parses as plain text content", () => {
    const input = '<span color="rgb(240, 239, 237)">this is some example text.</span>';
    const roundTripped = roundTripInline(input);
    expect(roundTripped).toBe("this is some example text.");
  });

  test("invalid span color stays stable across repeated round-trips", () => {
    const input = '<span color="rgb(240, 239, 237)">text</span>';
    const once = roundTripInline(input);
    const twice = roundTripInline(once);
    expect(once).toBe("text");
    expect(twice).toBe("text");
  });
});
