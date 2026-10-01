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
