import { describe, expect, it } from "vitest";
import {
  flattenToolInputSchema,
  portableToolInputSchema,
  toolInputSchemaProblem,
} from "./ToolInputSchema.ts";

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const literal = (value: string) => ({ type: "string", const: value });
const text = { type: "string", minLength: 1 };

describe("tool input schemas every provider accepts", () => {
  it("names what would make a provider drop a tool", () => {
    expect(toolInputSchemaProblem(object({ name: text }, ["name"]))).toBeUndefined();
    expect(toolInputSchemaProblem({ properties: {} })).toBe("does not declare type object");
    expect(toolInputSchemaProblem({ type: "object", oneOf: [] })).toBe(
      "uses oneOf at the top level",
    );
    expect(toolInputSchemaProblem({ type: "object", anyOf: [], allOf: [] })).toBe(
      "uses anyOf, allOf at the top level",
    );
    expect(toolInputSchemaProblem([])).toBe("is not a JSON object");
  });

  it("keeps advertised patterns to the syntax every Agent's regular expressions share", () => {
    const keyed = (pattern: string) =>
      toolInputSchemaProblem(object({ key: { type: "string", pattern } }, []));
    expect(keyed("^[a-z][a-z0-9_-]{0,63}$")).toBeUndefined();
    expect(keyed("^[^\\s]+$")).toBeUndefined();
    for (const pattern of [
      "^a{1,128}(?![\\s\\S])",
      "^(?=a)",
      "(?<!a)b",
      "(?<name>a)",
      "(a)\\1",
      "^[^\\uD800-\\uDFFF]$",
    ])
      expect(keyed(pattern)).toContain("regular expression engines reject");
    expect(
      toolInputSchemaProblem(
        object({ list: { type: "array", items: { type: "string", pattern: "(?!x)" } } }, []),
      ),
    ).toContain("reject");
    expect(
      toolInputSchemaProblem(object({ fixed: { type: "string", const: "(?!data)" } }, [])),
    ).toBeUndefined();
  });

  it("writes escaped characters literally so every engine reads them", () => {
    const titled = (pattern: string) =>
      portableToolInputSchema(object({ title: { type: "string", pattern } }, [])).properties
        .title as { pattern: string };
    const { pattern } = titled("^[^\\s\\u2028\\u2029][^\\u0009]*$");
    expect(pattern).toBe("^[^\\s\u2028\u2029][^\\x09]*$");
    expect(new RegExp(pattern, "u").test("a\u2028b")).toBe(true);
    expect(new RegExp(pattern, "u").test("\u2028b")).toBe(false);
    // An escaped backslash before `u` is a backslash and a letter, not an escape.
    expect(titled("^\\\\u$").pattern).toBe("^\\\\u$");
    expect(
      toolInputSchemaProblem(object({ title: titled("^\\\\u[^\\u00e9]$") }, [])),
    ).toBeUndefined();
    // A surrogate names no character, so it stays escaped and stays refused.
    expect(toolInputSchemaProblem(object({ title: titled("^[^\\uD800-\\uDFFF]$") }, []))).toContain(
      "reject",
    );
  });

  it("leaves a single object as it is", () => {
    const schema = object({ name: text }, ["name"]);
    expect(flattenToolInputSchema(schema)).toBe(schema);
  });

  it("covers every alternative of a nested discriminated union with one object", () => {
    const flattened = flattenToolInputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      oneOf: [
        object({ operation: literal("list"), cursor: text }, ["operation"]),
        {
          oneOf: [
            object({ operation: literal("create"), kind: literal("cron"), cwd: text }, [
              "operation",
              "kind",
              "cwd",
            ]),
            object({ operation: literal("create"), kind: literal("heartbeat"), target: text }, [
              "operation",
              "kind",
            ]),
          ],
        },
        object({ operation: literal("delete"), id: { ...text, description: "Exact ID" } }, [
          "operation",
          "id",
        ]),
      ],
    });

    expect(toolInputSchemaProblem(flattened)).toBeUndefined();
    expect(flattened).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "create", "delete"] },
        cursor: { ...text, description: "Only with operation list." },
        kind: {
          type: "string",
          enum: ["cron", "heartbeat"],
          description: "Required with operation create.",
        },
        cwd: { ...text, description: "Required with operation create and kind cron." },
        target: { ...text, description: "Only with operation create and kind heartbeat." },
        id: { ...text, description: "Exact ID. Required with operation delete." },
      },
      required: ["operation"],
      additionalProperties: false,
    });
  });

  it("keeps every shape of a field that alternatives define differently", () => {
    const flattened = flattenToolInputSchema({
      anyOf: [
        object({ section: text, items: { type: "array" } }, ["section", "items"]),
        object({ section: text, items: { type: "string" } }, ["section"]),
      ],
    });
    expect(flattened.properties).toEqual({
      section: text,
      items: { anyOf: [{ type: "array" }, { type: "string" }] },
    });
    expect(flattened.required).toEqual(["section"]);
  });

  it("refuses alternatives that are not objects", () => {
    expect(() => flattenToolInputSchema({ oneOf: [{ type: "string" }] })).toThrow("not an object");
  });
});
