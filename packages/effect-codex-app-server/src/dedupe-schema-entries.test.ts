import { describe, expect, it } from "@effect/vitest";
import { dedupeSchemaEntries } from "../scripts/dedupe-schema-entries.ts";

const entry = (name: string, body: string) =>
  [name, `export type ${name} = ${body};\nexport const ${name} = ${body};`] as const;
const aliased = (name: string, target: string) =>
  `export type ${name} = ${target};\nexport const ${name} = ${target};`;

describe("dedupeSchemaEntries", () => {
  it("emits one schema per wire type and aliases each root's copy of it", () => {
    const result = dedupeSchemaEntries(
      new Map([
        entry("A__Turn", "Turn({ id: String })"),
        entry("A__Thread", "Thread({ turns: A__Turn })"),
        entry("A", "Root({ thread: A__Thread })"),
        entry("B__Turn", "Turn({ id: String })"),
        entry("B__Thread", "Thread({ turns: B__Turn })"),
        entry("B", "Root({ thread: B__Thread })"),
      ]),
    );
    expect(result.get("B__Turn")).toBe(aliased("B__Turn", "A__Turn"));
    expect(result.get("B__Thread")).toBe(aliased("B__Thread", "A__Thread"));
    // Roots keep their own identity even when they read the same.
    expect(result.get("B")).toBe(entry("B", "Root({ thread: B__Thread })")[1]);
  });

  it("keeps a definition whose references differ even when its own text matches", () => {
    const result = dedupeSchemaEntries(
      new Map([
        entry("A__Turn", "Turn({ id: String })"),
        entry("A__Thread", "Thread({ turns: A__Turn })"),
        entry("B__Turn", "Turn({ id: Number })"),
        entry("B__Thread", "Thread({ turns: B__Turn })"),
      ]),
    );
    expect(result.get("B__Turn")).toBe(entry("B__Turn", "Turn({ id: Number })")[1]);
    expect(result.get("B__Thread")).toBe(entry("B__Thread", "Thread({ turns: B__Turn })")[1]);
  });

  it("merges recursive definitions that refer to themselves", () => {
    const result = dedupeSchemaEntries(
      new Map([
        entry("A__Json", "suspend(() => Union(String, Array(A__Json)))"),
        entry("B__Json", "suspend(() => Union(String, Array(B__Json)))"),
      ]),
    );
    expect(result.get("B__Json")).toBe(aliased("B__Json", "A__Json"));
  });
});
