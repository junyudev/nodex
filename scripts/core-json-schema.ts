/** Extract a generated OpenAPI schema and its transitive local references as JSON Schema. */
export const extractCoreJsonSchema = (
  schemas: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> => {
  const definitions: Record<string, unknown> = {};
  const visited = new Set<string>([name]);
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key !== "$ref") return [key, convert(entry)];
        if (typeof entry !== "string" || !entry.startsWith("#/components/schemas/"))
          throw new Error("Core schema contains a non-local reference");
        const referenced = entry.slice("#/components/schemas/".length);
        if (!(referenced in schemas))
          throw new Error(`Missing generated Core schema: ${referenced}`);
        if (!visited.has(referenced)) {
          visited.add(referenced);
          definitions[referenced] = convert(schemas[referenced]);
        }
        return [key, referenced === name ? "#" : `#/$defs/${referenced}`];
      }),
    );
  };
  const root = convert(schemas[name]);
  if (typeof root !== "object" || root === null || Array.isArray(root))
    throw new Error(`Missing generated Core schema: ${name}`);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...root, $defs: definitions };
};
