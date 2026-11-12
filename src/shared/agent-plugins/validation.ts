import { z } from "zod";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  // JSON.parse produces own properties. Keep opaque namespaces and keys such as "__proto__".
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export function own(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export const text = z.string();
export const strings = z.array(text);
export const jsonObject = z.custom<JsonObject>((value) => asObject(value) !== undefined);
export const stringMap = z.custom<Record<string, string>>((value) => {
  const object = asObject(value);
  return object !== undefined && Object.values(object).every((entry) => typeof entry === "string");
});
export const pluginName = text
  .min(1)
  .max(64)
  .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);

const authorFields = {
  name: text.optional(),
  email: text.optional(),
  url: text.optional(),
};

export const identityFields = {
  name: pluginName,
  version: text.optional(),
  description: text.optional(),
  author: z.object(authorFields).optional(),
  homepage: text.optional(),
  repository: text.optional(),
  license: text.optional(),
  keywords: strings.optional(),
};

export const strictAuthor = z.strictObject(authorFields);

export function schemaIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** Normalize portable slash-separated paths. Reject ambiguous Windows path syntax. */
export function packageRelativePath(value: string): string | undefined {
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some((segment) => segment === ".." || segment.includes(":"))
  )
    return undefined;
  return segments.filter((segment) => segment && segment !== ".").join("/") || ".";
}
