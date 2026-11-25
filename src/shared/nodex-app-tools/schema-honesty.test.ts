import { describe, expect, it, test } from "vitest";
import {
  flattenToolInputSchema,
  portableToolInputSchema,
  toolInputSchemaProblem,
} from "@nodex/agent-runtime/tool-input-schema";
import { z } from "zod";
import { appContentToolContracts } from "./content-catalog";
import { appToolCatalog } from "./catalog";
import { appToolArgumentSchemas } from "./argument-schemas";
import { nativeAppToolCatalog } from "../../main/app-tools/HostedAppToolCatalog";
import { uniqueScalarValues } from "../schema-constraints";
import { sqlQuerySchema } from "./query-schemas";

const representedChecks = new Set([
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "bigint_format",
  "min_length",
  "max_length",
  "length_equals",
  "min_size",
  "max_size",
  "size_equals",
  "string_format",
  "mime_type",
]);

/** Inspect executable schemas, so a new hidden leaf predicate fails even when JSON conversion drops it. */
const isObjectSchema = (schema: z.core.$ZodType): boolean => {
  const def = (schema as z.core.$ZodTypes)._zod.def;
  return def.type === "object" || (def.type === "union" && def.options.every(isObjectSchema));
};

const hiddenConstraints = (root: z.ZodType): string[] => {
  const problems: string[] = [];
  const visit = (
    schema: z.core.$ZodType,
    path: string,
    ancestors: ReadonlySet<z.core.$ZodType>,
    objectTransform = false,
  ): void => {
    if (ancestors.has(schema)) return;
    const seen = new Set([...ancestors, schema]);
    const def = (schema as z.core.$ZodTypes)._zod.def;
    const meta = z.globalRegistry.get(schema);
    for (const check of def.checks ?? []) {
      const kind = check._zod.def.check;
      if (representedChecks.has(kind)) continue;
      if (kind === "custom" && isObjectSchema(schema)) continue;
      if (
        kind === "custom" &&
        def.type === "array" &&
        meta?.uniqueItems === true &&
        (check as z.core.$ZodCustom)._zod.def.fn === uniqueScalarValues
      )
        continue;
      problems.push(`${path}: ${kind} has no JSON Schema assertion`);
    }
    switch (def.type) {
      case "object":
        for (const [field, child] of Object.entries(def.shape))
          visit(child, `${path}.${field}`, seen);
        if (def.catchall) visit(def.catchall, `${path}.*`, seen);
        return;
      case "array":
        return visit(def.element, `${path}[]`, seen);
      case "union":
        def.options.forEach((child, index) => visit(child, `${path}|${index}`, seen));
        return;
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "nonoptional":
        return visit(def.innerType, path, seen);
      case "record":
        visit(def.keyType, `${path}.key`, seen);
        return visit(def.valueType, `${path}.value`, seen);
      case "lazy":
        return visit(def.getter(), path, seen);
      case "pipe": {
        const propertyNames = meta?.propertyNames as Record<string, unknown> | undefined;
        // fromJSONSchema interprets propertyNames with an identity guard. For string-only
        // property names that guard adds no constraint; the keyword remains in the schema.
        if (
          def.in._zod.def.type === "transform" &&
          (def.out._zod.def.type === "record" || def.out._zod.def.type === "object") &&
          propertyNames?.type === "string" &&
          Object.keys(propertyNames).length === 1 &&
          def.in._zod.def.checks?.length === 1
        )
          return visit(def.out, path, seen);
        visit(def.in, path, seen);
        return visit(def.out, path, seen, def.in._zod.def.type === "object");
      }
      case "custom":
        problems.push(`${path}: custom schema has no JSON Schema assertion`);
        return;
      case "transform":
        if (!objectTransform)
          problems.push(`${path}: field transform has no JSON Schema assertion`);
        return;
      default:
        return;
    }
  };
  visit(root, "$", new Set());
  return problems;
};

describe("hosted tool schema honesty", () => {
  it("covers the full catalog and its native projection", () => {
    expect(Object.keys(appToolArgumentSchemas).sort()).toEqual(
      appToolCatalog.map((tool) => tool.name).sort(),
    );
    for (const tool of nativeAppToolCatalog) expect(appToolCatalog).toContain(tool);
  });

  for (const tool of appToolCatalog)
    it(`${tool.name} publishes its executable input constraints`, () => {
      const schema = appToolArgumentSchemas[tool.name]!;
      expect(hiddenConstraints(schema)).toEqual([]);
      // Every provider must be able to call it; a union validator publishes its one-object cover.
      expect(toolInputSchemaProblem(tool.inputSchema)).toBeUndefined();
      const { $schema: _publishedDialect, ...published } = tool.inputSchema;
      // The same constraints, with patterns spelled so every Agent's engine compiles them.
      const { $schema: _validatorDialect, ...expected } = portableToolInputSchema(
        flattenToolInputSchema(z.toJSONSchema(schema, { io: "input" })),
      );
      if (schema === sqlQuerySchema) {
        const expand = (document: Record<string, unknown>): unknown => {
          const definitions = document.$defs as Record<string, unknown> | undefined;
          const visit = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(visit);
            if (value === null || typeof value !== "object") return value;
            const record = value as Record<string, unknown>;
            if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/"))
              return visit(definitions?.[record.$ref.slice(8)]);
            return Object.fromEntries(
              Object.entries(record)
                .filter(
                  ([key, child]) =>
                    key !== "$defs" &&
                    !(
                      key === "properties" &&
                      child !== null &&
                      typeof child === "object" &&
                      Object.keys(child).length === 0
                    ),
                )
                .map(([key, child]) => [
                  key,
                  key === "required" && Array.isArray(child)
                    ? [...child].sort((left, right) => String(left).localeCompare(String(right)))
                    : visit(child),
                ]),
            );
          };
          return visit(document);
        };
        expect(expand(published)).toEqual(expand({ ...expected, type: "object" }));
        return;
      }
      expect(published).toEqual({ ...expected, type: "object" });
    });

  it("catches scalar predicates and transforms hidden by JSON conversion", () => {
    expect(
      hiddenConstraints(z.object({ key: z.string().refine((key) => key.startsWith("internal:")) })),
    ).toHaveLength(1);
    expect(
      hiddenConstraints(z.object({ key: z.string().transform((key) => key.trim()) })),
    ).toHaveLength(1);
    expect(hiddenConstraints(z.object({ key: z.string().trim().min(1) }))).toHaveLength(1);
    expect(hiddenConstraints(z.object({ key: z.custom(() => true) }))).toHaveLength(1);
    expect(
      hiddenConstraints(z.object({ key: z.union([z.string(), z.number()]).refine(() => false) })),
    ).toHaveLength(1);
    expect(hiddenConstraints(z.object({ key: z.string().min(1).max(128) }))).toEqual([]);
  });
});

test.each([
  ["create_pages", { destination: { kind: "library" }, pages: [{ title: "Retry test" }] }],
  [
    "set_page_properties",
    { updates: [{ pageIds: ["NODEX-4"], values: [{ propertyId: "Status", value: "done" }] }] },
  ],
  ["update_page", { pageId: "page:retry", values: [{ propertyId: "Status", value: "done" }] }],
] as const)("hosted %s retry keys count Unicode scalar values", (name, args) => {
  const schema = appToolArgumentSchemas[name]!;
  const published = appToolCatalog.find((tool) => tool.name === name)!;
  // JSON Schema lengths count Unicode characters, as the validator does.
  expect(published.inputSchema.properties?.idempotencyKey).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 128,
  });
  expect(published.inputSchema.properties?.idempotencyKey).not.toHaveProperty("pattern");
  for (const key of [" ", " /:", "nodexop:v1:broken", "cli-1-reorg", "😀".repeat(128)])
    expect(schema.safeParse({ ...args, idempotencyKey: key }).success).toBe(true);
  for (const key of ["", "😀".repeat(129), "\ud800"]) {
    expect(schema.safeParse({ ...args, idempotencyKey: key }).success).toBe(false);
  }
});

test("hosted content results validate their links alongside the semantic data", () => {
  const pageId = "page:one";
  const pageUrl = "nodex://pages/page%3Aone";
  const location = { kind: "page", pageId };
  const fetch = appContentToolContracts.fetch;
  const resource = {
    id: "block/a",
    pageKey: null,
    type: "paragraph",
    lifecycle: "active",
    location,
  };
  const fetchOutput = { data: { resource } };
  const linkedFetch = fetch.serializeOutput(fetchOutput);
  expect(linkedFetch).toMatchObject({
    success: true,
    data: { data: { resource: { ...resource, url: `${pageUrl}#block%2Fa` } } },
  });
  expect(
    fetch.outputSchema.safeParse({
      data: { resource: { ...resource, url: `${pageUrl}#block%2Fa` } },
    }).success,
  ).toBe(true);

  expect(
    fetch.serializeOutput({
      data: { resource: { ...resource, id: pageId, type: "page" } },
    }),
  ).toMatchObject({ success: true, data: { data: { resource: { url: pageUrl } } } });

  const view = { viewId: "view:one", dataSourceId: "source", name: "Plans", layout: "list" };
  const row = {
    pageId,
    pageKey: null,
    title: "Plan",
    values: {},
    placement: { viewId: view.viewId, groupKey: null },
  };
  const queryOutput = {
    data: {
      database: { databaseId: "database", name: "Planning" },
      dataSource: { dataSourceId: "source", name: "Plans", properties: [] },
      view,
      rows: [row],
    },
  };
  const query = appContentToolContracts.query_database_view;
  expect(query.serializeOutput(queryOutput)).toEqual({
    success: true,
    data: {
      data: {
        ...queryOutput.data,
        view: { ...view, url: "nodex://views/view%3Aone" },
        rows: [{ ...row, url: pageUrl }],
      },
    },
  });
  expect(query.outputSchema.safeParse(queryOutput).success).toBe(false);

  const page = { pageId, pageKey: null, location, bodyBlocksCreated: 1 };
  const create = appContentToolContracts.create_pages;
  expect(create.serializeOutput({ data: { created: 1, pages: [page] } })).toEqual({
    success: true,
    data: { data: { created: 1, pages: [{ ...page, url: pageUrl }] } },
  });
});
