/** Physical JSON arrays remain segmented until an internal consumer needs ordinary arrays. */
export class CodexChunkedArray {
  constructor(
    readonly chunks: readonly (readonly unknown[])[],
    readonly length: number,
  ) {}

  *[Symbol.iterator](): Generator {
    for (const chunk of this.chunks) yield* chunk;
  }
}

const sourceLineBytes = new WeakMap<object, number>();
const receivedAtMsByValue = new WeakMap<object, number>();
const chunkedValues = new WeakSet<object>();
const originalValues = new WeakMap<object, object>();

export const setCodexSourceLineBytes = (value: object, bytes: number): void => {
  sourceLineBytes.set(value, bytes);
};

export const getCodexSourceLineBytes = (value: object): number | undefined =>
  sourceLineBytes.get(value);

/** Physical ingress timestamp retained across generated decoding/materialization boundaries. */
export const setCodexReceivedAtMs = (value: object, receivedAtMs: number): void => {
  receivedAtMsByValue.set(value, receivedAtMs);
};

export const getCodexReceivedAtMs = (value: object): number | undefined =>
  receivedAtMsByValue.get(value);

export const codexTransportArrayValues = (value: object): Iterable<unknown> | null =>
  value instanceof CodexChunkedArray ? value : null;

export function markCodexChunkedJson(value: Record<string, unknown>): void {
  chunkedValues.add(value);
  for (const part of [value.result, value.params])
    if (typeof part === "object" && part !== null) chunkedValues.add(part);
}

/** Generated decoders may allocate new objects without carrying physical transport metadata. */
export function copyCodexTransportMetadata(source: unknown, target: unknown): void {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof target !== "object" ||
    target === null
  )
    return;
  const bytes = sourceLineBytes.get(source);
  if (bytes !== undefined) sourceLineBytes.set(target, bytes);
  const receivedAtMs = receivedAtMsByValue.get(source);
  if (receivedAtMs !== undefined) receivedAtMsByValue.set(target, receivedAtMs);
  const original = originalValues.get(source) ?? (chunkedValues.has(source) ? source : undefined);
  if (original && original !== target) originalValues.set(target, original);
}

export function codexTransportValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  return (originalValues.get(value) ?? value) as T;
}

export function materializeCodexJson(value: unknown): unknown {
  if (value instanceof CodexChunkedArray) return materialize(value);
  if (typeof value !== "object" || value === null || !chunkedValues.has(value)) return value;
  return materialize(value);
}

function materialize(value: unknown): unknown {
  if (value instanceof CodexChunkedArray || Array.isArray(value)) {
    const result = Array.from(value, materialize);
    copyCodexTransportMetadata(value, result);
    return result;
  }
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: materialize(item),
    });
  copyCodexTransportMetadata(value, result);
  return result;
}
