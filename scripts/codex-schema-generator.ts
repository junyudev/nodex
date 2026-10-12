import { Visitor, type Expression, type SpreadElement } from "oxc-parser";
import { parseTypeScriptSource } from "./lib/oxc-source";
import type {
  ThreadRealtimeItem,
  ThreadTimelineEntry,
} from "../packages/codex-app-server-protocol/src/v2";

export interface CodexMethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

type JsonPrimitive = boolean | number | string | null;
export type SchemaJson =
  | JsonPrimitive
  | readonly SchemaJson[]
  | { readonly [key: string]: SchemaJson };

function isSchemaObject(value: SchemaJson | undefined): value is Record<string, SchemaJson> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Declared wire objects retain JSON extensions; typed dictionaries retain their value contract. */
export function allowCodexProtocolExtensions(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type !== "object") return schema;
  if (schema.additionalProperties !== null && typeof schema.additionalProperties === "object")
    return schema;
  return { ...schema, additionalProperties: true };
}

function isSchemaMember(
  expression: Expression | SpreadElement | null | undefined,
  name: string,
): boolean {
  return (
    expression?.type === "MemberExpression" &&
    !expression.computed &&
    expression.object.type === "Identifier" &&
    expression.object.name === "Schema" &&
    expression.property.type === "Identifier" &&
    expression.property.name === name
  );
}

function isJsonSchemaExpression(
  expression: Expression | SpreadElement | null | undefined,
): boolean {
  if (isSchemaMember(expression, "Json")) return true;
  if (expression?.type !== "CallExpression") return false;
  const callee = expression.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "annotate" &&
    isSchemaMember(callee.object, "Json")
  );
}

/** Keep extension values statically unknown without weakening their runtime JSON validation. */
export function renderCodexProtocolExtensionViews(source: string): string {
  const edits: Array<{ readonly start: number; readonly end: number }> = [];
  let runtimeCount = 0;
  let typeCount = 0;
  new Visitor({
    CallExpression(node) {
      if (!isSchemaMember(node.callee, "StructWithRest")) return;
      const rest = node.arguments[1];
      if (rest?.type !== "ArrayExpression") return;
      for (const record of rest.elements) {
        if (record?.type !== "CallExpression" || !isSchemaMember(record.callee, "Record")) continue;
        const value = record.arguments[1];
        if (
          !value ||
          !isSchemaMember(record.arguments[0], "String") ||
          !isJsonSchemaExpression(value)
        )
          continue;
        edits.push({ start: value.start, end: value.end });
        runtimeCount += 1;
      }
    },
    TSIntersectionType(node) {
      for (const type of node.types) {
        if (type.type !== "TSTypeLiteral" || type.members.length !== 1) continue;
        const member = type.members[0];
        if (member?.type !== "TSIndexSignature") continue;
        const annotation = member.typeAnnotation.typeAnnotation;
        if (annotation.type !== "TSTypeReference") continue;
        const name = annotation.typeName;
        if (
          name.type !== "TSQualifiedName" ||
          name.left.type !== "Identifier" ||
          name.left.name !== "Schema" ||
          name.right.name !== "Json"
        )
          continue;
        edits.push({ start: annotation.start, end: annotation.end });
        typeCount += 1;
      }
    },
  }).visit(parseTypeScriptSource("codex-generated-extensions.ts", source));

  if (runtimeCount !== typeCount) {
    throw new Error(`Unpaired Codex extension views: ${runtimeCount} codecs, ${typeCount} types`);
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits.toSorted((left, right) => left.start - right.start)) {
    chunks.push(source.slice(cursor, edit.start), "CodexJsonExtension");
    cursor = edit.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

const timelineStartedFields = {
  turn_id: "turnId",
  started_at: "startedAt",
} satisfies Record<string, keyof Extract<ThreadTimelineEntry, { type: "turnStarted" }>>;
const timelineCompletedFields = {
  turn_id: "turnId",
  started_at: "startedAt",
  completed_at: "completedAt",
  duration_ms: "durationMs",
} satisfies Record<string, keyof Extract<ThreadTimelineEntry, { type: "turnCompleted" }>>;
const promotedItemFields = {
  turn_id: "turnId",
  item_id: "itemId",
} satisfies Record<string, keyof Extract<ThreadRealtimeItem, { type: "bemItemPromoted" }>>;
const nativeRealtimeFields: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  TurnStartedThreadTimelineEntry: timelineStartedFields,
  TurnCompletedThreadTimelineEntry: timelineCompletedFields,
  BemItemPromotedThreadRealtimeItem: promotedItemFields,
};

/** The pinned exporter misses serde's enum field renames; preserve its constraints under the native TypeScript names. */
export function normalizeCodexRealtimeSchemaFieldNames(value: SchemaJson): SchemaJson {
  if (Array.isArray(value)) return value.map(normalizeCodexRealtimeSchemaFieldNames);
  if (!isSchemaObject(value)) return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      normalizeCodexRealtimeSchemaFieldNames(child),
    ]),
  );
  const fields =
    typeof value.title === "string" && Object.hasOwn(nativeRealtimeFields, value.title)
      ? nativeRealtimeFields[value.title]
      : undefined;
  if (!fields || !isSchemaObject(normalized.properties)) return normalized;
  for (const [exportedName, wireName] of Object.entries(fields)) {
    if (exportedName in normalized.properties && wireName in normalized.properties)
      throw new Error(`Codex schema declares conflicting ${exportedName}/${wireName} fields`);
  }
  return {
    ...normalized,
    properties: Object.fromEntries(
      Object.entries(normalized.properties).map(([name, schema]) => [fields[name] ?? name, schema]),
    ),
    ...(Array.isArray(normalized.required)
      ? {
          required: normalized.required.map((name) =>
            typeof name === "string" ? (fields[name] ?? name) : name,
          ),
        }
      : {}),
  };
}

/** Parses the tagged request union emitted by codex app-server's TypeScript generator. */
export function parseCodexRequestEntries(fileContents: string): ReadonlyArray<CodexMethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params\??:\s*([^,}]+)/g;
  const entries: CodexMethodEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: match[2]!.trim(),
    });
  }
  return entries;
}

/** Parses the tagged notification union emitted by codex app-server's TypeScript generator. */
export function parseCodexNotificationEntries(
  fileContents: string,
): ReadonlyArray<CodexMethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: CodexMethodEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

/**
 * Effect's JSON Schema importer cannot represent an object intersected with a
 * oneOf or anyOf. Distributing the shared object fields over each branch
 * preserves the JSON Schema contract while keeping the discriminator useful.
 */
export function distributeObjectUnions(value: SchemaJson): SchemaJson {
  if (Array.isArray(value)) {
    return value.map(distributeObjectUnions);
  }
  if (!isSchemaObject(value)) {
    return value;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, distributeObjectUnions(child)]),
  ) as Record<string, SchemaJson>;
  if (normalized.type !== "object") {
    return normalized;
  }

  for (const union of ["oneOf", "anyOf"] as const) {
    const branches = normalized[union];
    if (
      !Array.isArray(branches) ||
      !branches.every((branch) => isSchemaObject(branch) && branch.type === "object")
    ) {
      continue;
    }

    const sharedProperties = isSchemaObject(normalized.properties) ? normalized.properties : {};
    const sharedRequired = Array.isArray(normalized.required) ? normalized.required : [];
    const sharedSchema = Object.fromEntries(
      Object.entries(normalized).filter(([key]) => key !== union),
    );

    return {
      [union]: branches.map((branch) => {
        if (!isSchemaObject(branch)) return branch;
        const branchProperties = isSchemaObject(branch.properties) ? branch.properties : {};
        const branchRequired = Array.isArray(branch.required) ? branch.required : [];
        return {
          ...sharedSchema,
          ...branch,
          properties: { ...sharedProperties, ...branchProperties },
          required: [...new Set([...sharedRequired, ...branchRequired])],
        };
      }),
    };
  }

  return normalized;
}
