import { afterEach, describe, expect, it, test } from "vite-plus/test";
import { extractJsonSchemaRoot, stableJson, type JsonObject } from "./codex-schemas";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateCodexSchemaToolArchivePaths } from "./codex-schema-tool";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import {
  distributeObjectUnions,
  normalizeCodexRealtimeSchemaFieldNames,
  parseCodexRequestEntries,
  type SchemaJson,
} from "./codex-schema-generator";
import { createGeneratedCodexSchema } from "../src/shared/generated-codex-schema";

describe("Codex runtime schema extraction", () => {
  it("extracts and rewrites a transitive cyclic reference closure", () => {
    const bundle: JsonObject = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {
        Root: {
          properties: {
            value: { $ref: "#/definitions/v2/Value" },
          },
          type: "object",
        },
        v2: {
          Value: {
            anyOf: [{ type: "string" }, { $ref: "#/definitions/v2/Wrapper" }],
          },
          Wrapper: {
            properties: {
              value: { $ref: "#/definitions/v2/Value" },
            },
            type: "object",
          },
        },
      },
    };

    expect(extractJsonSchemaRoot(bundle, "Root")).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {
        definitions__v2__Value: {
          anyOf: [{ type: "string" }, { $ref: "#/definitions/definitions__v2__Wrapper" }],
        },
        definitions__v2__Wrapper: {
          properties: {
            value: { $ref: "#/definitions/definitions__v2__Value" },
          },
          type: "object",
        },
      },
      properties: {
        value: { $ref: "#/definitions/definitions__v2__Value" },
      },
      title: "Root",
      type: "object",
    });
  });

  it("resolves escaped JSON Pointer segments", () => {
    const bundle: JsonObject = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {
        Root: { $ref: "#/definitions/path~1with~0tokens" },
        "path/with~tokens": { type: "boolean" },
      },
    };

    expect(extractJsonSchemaRoot(bundle, "Root")).toMatchObject({
      $ref: "#/definitions/definitions__path%2Fwith~0tokens",
      definitions: {
        "definitions__path%2Fwith~tokens": { type: "boolean" },
      },
    });
  });

  it("rejects missing roots, unresolved refs, and remote refs", () => {
    const base: JsonObject = {
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: {},
    };

    expect(() => extractJsonSchemaRoot(base, "Missing")).toThrow("does not define Missing");
    expect(() =>
      extractJsonSchemaRoot(
        {
          ...base,
          definitions: { Root: { $ref: "#/definitions/Missing" } },
        },
        "Root",
      ),
    ).toThrow("unresolved reference");
    expect(() =>
      extractJsonSchemaRoot(
        {
          ...base,
          definitions: { Root: { $ref: "https://example.com/schema.json" } },
        },
        "Root",
      ),
    ).toThrow("unsupported non-local reference");
  });

  it("serializes object keys deterministically without reordering arrays", () => {
    expect(stableJson({ z: 1, a: { y: 2, b: 3 }, order: ["z", "a"] })).toBe(
      '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "order": [\n    "z",\n    "a"\n  ],\n  "z": 1\n}\n',
    );
  });
});

describe("schema tool archive admission", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  test.skipIf(process.platform === "win32")(
    "rejects links before extracting a schema tool archive",
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "nodex-codex-schema-archive-"));
      roots.push(root);
      const payload = path.join(root, "payload");
      mkdirSync(payload);
      writeFileSync(path.join(payload, "codex-aarch64-apple-darwin"), "binary\n", { mode: 0o755 });
      symlinkSync("codex-aarch64-apple-darwin", path.join(payload, "codex-link"));
      const archivePath = path.join(root, "schema-tool.tar.gz");
      execFileSync("/usr/bin/tar", [
        "-czf",
        archivePath,
        "-C",
        payload,
        "codex-aarch64-apple-darwin",
        "codex-link",
      ]);

      expect(() => validateCodexSchemaToolArchivePaths(archivePath)).toThrow(
        "only regular files and directories",
      );
    },
  );
});

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

  it("preserves shared fields through nested image-source alternatives", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { startedAtMs: { type: "number" } },
      required: ["startedAtMs"],
      oneOf: [
        {
          type: "object",
          properties: { type: { const: "imageGeneration" } },
          required: ["type"],
          anyOf: [
            { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
            { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
          ],
        },
        {
          type: "object",
          properties: { type: { const: "plan" }, text: { type: "string" } },
          required: ["type", "text"],
        },
      ],
    } as const satisfies SchemaJson;
    const original = createGeneratedCodexSchema(schema);
    const normalized = {
      $schema: schema.$schema,
      ...(distributeObjectUnions(schema) as object),
    };
    const distributed = createGeneratedCodexSchema(normalized);
    const imported = SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12(normalized),
    );
    for (const [value, valid] of [
      [{ type: "imageGeneration", startedAtMs: 1, fileId: "file-1" }, true],
      [{ type: "imageGeneration", startedAtMs: 1, result: "AQID" }, true],
      [{ type: "imageGeneration", startedAtMs: 1, fileId: "file-1", result: "AQID" }, true],
      [{ type: "plan", startedAtMs: 1, text: "Ship" }, true],
      [{ type: "imageGeneration", fileId: "file-1" }, false],
      [{ type: "imageGeneration", startedAtMs: 1 }, false],
      [{ type: "imageGeneration", startedAtMs: "invalid", result: "AQID" }, false],
      [{ type: "plan", startedAtMs: 1 }, false],
    ] as const) {
      expect(original.safeParse(value).success).toBe(valid);
      expect(distributed.safeParse(value).success).toBe(valid);
      expect(Schema.is(imported)(value)).toBe(valid);
    }
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
