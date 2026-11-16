/**
 * Nodex advertises its tools to every Agent over MCP. Some providers accept only one plain object at
 * the top of a tool's input schema and drop any other tool without an error, so every advertised
 * tool takes one object. A tool whose calls have several shapes advertises the object that covers
 * all of them; its own validator still accepts exactly one shape per call.
 */
type JsonObject = { readonly [key: string]: unknown };

const UNIONS = ["oneOf", "anyOf"] as const;
const TOP_LEVEL_FORBIDDEN = [
  ...UNIONS,
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "const",
  "enum",
];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Agents validate tool schemas with their own regular expression engine, and some, such as Go's
 * RE2, reject the whole toolbox over one pattern they can't compile. Advertised patterns keep to
 * the syntax every engine shares: no lookaround, named groups, backreferences or `\u` escapes.
 */
const isNonportablePattern = (pattern: string): boolean => {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1] ?? "";
    if (char === "\\") {
      if (next === "u" || next === "k" || (next >= "1" && next <= "9")) return true;
      index += 1;
    } else if (char === "(" && next === "?" && /[=!<]/u.test(pattern[index + 2] ?? "")) {
      return true;
    }
  }
  return false;
};

const nonportablePattern = (schema: unknown): string | undefined => {
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const found = nonportablePattern(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObject(schema)) return undefined;
  if (typeof schema.pattern === "string" && isNonportablePattern(schema.pattern))
    return schema.pattern;
  for (const [key, value] of Object.entries(schema)) {
    // Example values and constants are data, not schemas.
    if (key === "const" || key === "enum" || key === "examples" || key === "default") continue;
    const found = nonportablePattern(value);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** `\uXXXX` escapes name characters every engine reads literally; ASCII ones become `\xHH`. */
const literalizePattern = (pattern: string): string =>
  pattern.replace(/\\(?:u([0-9A-Fa-f]{4})|[\s\S])/gu, (escape, hex: string | undefined) => {
    if (hex === undefined) return escape;
    const code = Number.parseInt(hex, 16);
    // A surrogate is no character of its own; such a pattern stays non-portable.
    if (code >= 0xd800 && code <= 0xdfff) return escape;
    return code < 0x80 ? `\\x${hex.slice(2)}` : String.fromCharCode(code);
  });

/** The schema with each pattern written in the syntax every Agent's engine shares, where it can be. */
export const portableToolInputSchema = <Schema>(schema: Schema): Schema => {
  if (Array.isArray(schema)) return schema.map(portableToolInputSchema) as Schema;
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "pattern" && typeof value === "string"
        ? literalizePattern(value)
        : key === "const" || key === "enum" || key === "examples" || key === "default"
          ? value
          : portableToolInputSchema(value),
    ]),
  ) as Schema;
};

/** Why a provider could drop a tool advertising this input schema, or undefined when none would. */
export const toolInputSchemaProblem = (schema: unknown): string | undefined => {
  if (!isObject(schema)) return "is not a JSON object";
  if (schema.type !== "object") return "does not declare type object";
  const forbidden = TOP_LEVEL_FORBIDDEN.filter((key) => key in schema);
  if (forbidden.length > 0) return `uses ${forbidden.join(", ")} at the top level`;
  if (schema.properties !== undefined && !isObject(schema.properties))
    return "declares properties that are not an object";
  const pattern = nonportablePattern(schema);
  if (pattern !== undefined)
    return `uses a pattern some Agents' regular expression engines reject: ${pattern}`;
  return undefined;
};

const propertiesOf = (variant: JsonObject): JsonObject =>
  isObject(variant.properties) ? variant.properties : {};
const requiredOf = (variant: JsonObject): ReadonlyArray<unknown> =>
  Array.isArray(variant.required) ? variant.required : [];

/** A union's sibling keywords apply to each of its alternatives. */
const alternativesOf = (schema: JsonObject): ReadonlyArray<JsonObject> => {
  const key = UNIONS.find((candidate) => Array.isArray(schema[candidate]));
  if (key === undefined) return [schema];
  const { [key]: alternatives, ...shared } = schema;
  return (alternatives as ReadonlyArray<unknown>).flatMap((alternative) => {
    if (!isObject(alternative))
      throw new Error("A tool input alternative is not a JSON Schema object.");
    return alternativesOf({ ...shared, ...alternative });
  });
};

const constOf = (schema: unknown): { readonly value: unknown } | undefined =>
  isObject(schema) && "const" in schema ? { value: schema.const } : undefined;

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const spoken = (values: ReadonlyArray<unknown>): string => {
  const words = values.map(String);
  return words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
};

/**
 * One object whose properties cover every alternative of a top-level `oneOf`/`anyOf`. A property
 * that is a constant in every alternative naming it, such as `mode`, becomes an enum, and a
 * property used by only some of its values says which.
 */
export const flattenToolInputSchema = (schema: JsonObject): JsonObject => {
  if (!UNIONS.some((key) => key in schema)) return schema;
  const { $schema, description, ...union } = schema;
  const variants = alternativesOf(union).map((variant) => {
    if (variant.type !== undefined && variant.type !== "object")
      throw new Error("A tool input alternative is not an object.");
    if (UNIONS.some((key) => key in variant) || "allOf" in variant || "$ref" in variant)
      throw new Error("A tool input alternative must be a plain object schema.");
    return variant;
  });
  const names = unique(variants.flatMap((variant) => Object.keys(propertiesOf(variant))));
  const holders = (name: string) => variants.filter((variant) => name in propertiesOf(variant));
  const discriminators = names.filter((name) =>
    holders(name).every((variant) => constOf(propertiesOf(variant)[name]) !== undefined),
  );
  const valuesOf = (name: string, among: ReadonlyArray<JsonObject>) =>
    unique(among.flatMap((variant) => constOf(propertiesOf(variant)[name])?.value ?? []));

  const merged = (name: string): JsonObject => {
    const users = holders(name);
    const schemas = users.map((variant) => propertiesOf(variant)[name]);
    let property: JsonObject;
    if (discriminators.includes(name)) {
      const types = unique(schemas.map((entry) => (entry as JsonObject).type));
      property = {
        ...(types.length === 1 && types[0] !== undefined ? { type: types[0] } : {}),
        enum: valuesOf(name, users),
      };
    } else {
      const distinct = unique(schemas);
      property = distinct.length === 1 ? (distinct[0] as JsonObject) : { anyOf: distinct };
    }
    const among = (subset: ReadonlyArray<JsonObject>) =>
      discriminators.flatMap((discriminator) => {
        if (discriminator === name) return [];
        if (!subset.every((variant) => discriminator in propertiesOf(variant))) return [];
        const used = valuesOf(discriminator, subset);
        return used.length < valuesOf(discriminator, variants).length
          ? [`${discriminator} ${spoken(used)}`]
          : [];
      });
    const requiring = users.filter((variant) => requiredOf(variant).includes(name));
    const only = users.length < variants.length ? among(users) : [];
    const needed =
      requiring.length > 0 && requiring.length < variants.length ? among(requiring) : [];
    const hints = [
      ...(only.length > 0 && requiring.length === users.length && needed.length > 0
        ? []
        : only.length > 0
          ? [`Only with ${only.join(" and ")}.`]
          : []),
      ...(needed.length > 0 ? [`Required with ${needed.join(" and ")}.`] : []),
    ];
    if (hints.length === 0) return property;
    const own = typeof property.description === "string" ? property.description.trim() : "";
    return {
      ...property,
      description: [own === "" || /[.!?]$/.test(own) ? own : `${own}.`, ...hints]
        .filter((part) => part !== "")
        .join(" "),
    };
  };

  const required = names.filter((name) =>
    variants.every((variant) => requiredOf(variant).includes(name)),
  );
  return {
    ...($schema === undefined ? {} : { $schema }),
    ...(description === undefined ? {} : { description }),
    type: "object",
    properties: Object.fromEntries(names.map((name) => [name, merged(name)])),
    ...(required.length > 0 ? { required } : {}),
    ...(variants.every((variant) => variant.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};
