import { describe, expect, it } from "vite-plus/test";
import {
  distributeObjectUnions,
  normalizeCodexRealtimeSchemaFieldNames,
  parseCodexRequestEntries,
  type SchemaJson,
} from "./codex-schema-generator";
import { createGeneratedCodexSchema } from "../src/shared/generated-codex-schema";

describe("Effect Codex schema generation", () => {
  it.each([
    [
      "TurnStartedThreadTimelineEntry",
      "turnStarted",
      { turn_id: "turnId", started_at: "startedAt" },
    ],
    [
      "TurnCompletedThreadTimelineEntry",
      "turnCompleted",
      {
        turn_id: "turnId",
        started_at: "startedAt",
        completed_at: "completedAt",
        duration_ms: "durationMs",
      },
    ],
    [
      "BemItemPromotedThreadRealtimeItem",
      "bemItemPromoted",
      { turn_id: "turnId", item_id: "itemId" },
    ],
  ] as const)(
    "native %s field correction preserves validation and rejects the exported aliases",
    (title, type, fields) => {
      const properties: Record<string, SchemaJson> = {
        type: { const: type },
        ...Object.fromEntries(
          Object.keys(fields).map((name) => [
            name,
            name.endsWith("_id")
              ? { type: "string", minLength: 1 }
              : { type: "integer", minimum: 0 },
          ]),
        ),
      };
      const schema = normalizeCodexRealtimeSchemaFieldNames({
        $schema: "http://json-schema.org/draft-07/schema#",
        title,
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      });
      const parser = createGeneratedCodexSchema<Record<string, unknown>>(schema);
      const native: Record<string, unknown> = {
        type,
        ...Object.fromEntries(
          Object.entries(fields).map(([name, wireName]) => [
            wireName,
            name.endsWith("_id") ? "identity" : 12,
          ]),
        ),
      };
      expect(parser.parse(native)).toEqual(native);
      for (const [exportedName, wireName] of Object.entries(fields)) {
        const { [wireName]: value, ...rest } = native;
        expect(() => parser.parse({ ...rest, [exportedName]: value })).toThrow();
        expect(() => parser.parse(rest)).toThrow();
        expect(() =>
          parser.parse({ ...native, [wireName]: exportedName.endsWith("_id") ? "" : -1 }),
        ).toThrow();
      }
      expect(normalizeCodexRealtimeSchemaFieldNames(schema)).toEqual(schema);
    },
  );

  it("leaves unrelated snake-case protocol fields unchanged and rejects ambiguous export correction", () => {
    const unrelated = {
      title: "OtherProtocolObject",
      properties: { turn_id: { type: "string" } },
      required: ["turn_id"],
    };
    expect(normalizeCodexRealtimeSchemaFieldNames(unrelated)).toEqual(unrelated);
    expect(() =>
      normalizeCodexRealtimeSchemaFieldNames({
        title: "TurnStartedThreadTimelineEntry",
        properties: { turn_id: { type: "string" }, turnId: { type: "string" } },
      }),
    ).toThrow("conflicting");
  });

  it("keeps requests whose generated params property is optional", () => {
    expect(
      parseCodexRequestEntries(`
        | { "method": "account/usage/read", id: RequestId, params?: GetUsageParams | undefined }
        | { "method": "thread/start", id: RequestId, params: ThreadStartParams };
      `),
    ).toEqual([
      { method: "account/usage/read", paramsType: "GetUsageParams | undefined" },
      { method: "thread/start", paramsType: "ThreadStartParams" },
    ]);
  });

  it.each(["oneOf", "anyOf"])("distributes shared object fields over %s branches", (union) => {
    expect(
      distributeObjectUnions({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        [union]: [
          {
            type: "object",
            title: "CommandHook",
            properties: {
              handlerType: { const: "command" },
              command: { type: "string" },
            },
            required: ["handlerType", "command"],
          },
          {
            type: "object",
            properties: { handlerType: { const: "agent" } },
            required: ["handlerType"],
          },
        ],
      }),
    ).toEqual({
      [union]: [
        {
          type: "object",
          title: "CommandHook",
          properties: {
            key: { type: "string" },
            handlerType: { const: "command" },
            command: { type: "string" },
          },
          required: ["key", "handlerType", "command"],
        },
        {
          type: "object",
          properties: {
            key: { type: "string" },
            handlerType: { const: "agent" },
          },
          required: ["key", "handlerType"],
        },
      ],
    });
  });
});
