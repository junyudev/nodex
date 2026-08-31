const DEFAULT_MAXIMUM_LENGTH = 2_048;
const MAX_CAUSE_DEPTH = 12;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;
const TAG_ONLY_ERROR = /^[A-Za-z][A-Za-z0-9]*Error$/u;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const sanitizeMessage = (value: unknown, maximumLength: number): string | null => {
  if (typeof value !== "string") return null;
  const sanitized = value.replaceAll(CONTROL_CHARACTERS, " ").replaceAll(/\s+/gu, " ").trim();
  if (!sanitized || TAG_ONLY_ERROR.test(sanitized)) return null;
  return sanitized.slice(0, maximumLength);
};

const readDeepestUsefulMessage = (
  value: unknown,
  seen: Set<unknown>,
  depth: number,
  maximumLength: number,
): string | null => {
  if (depth >= MAX_CAUSE_DEPTH || value === null || value === undefined || seen.has(value)) {
    return null;
  }
  if (typeof value === "string") return sanitizeMessage(value, maximumLength);
  const record = asRecord(value);
  if (!record) return null;
  seen.add(value);

  const nested = readDeepestUsefulMessage(record.cause, seen, depth + 1, maximumLength);
  if (nested) return nested;
  return sanitizeMessage(record.message, maximumLength);
};

/** Projects nested runtime/tagged failures into one bounded message suitable for a process wire. */
export function readActionableErrorMessage(
  cause: unknown,
  options: { readonly fallback: string; readonly maximumLength?: number },
): string {
  const maximumLength = Math.max(1, Math.floor(options.maximumLength ?? DEFAULT_MAXIMUM_LENGTH));
  return (
    readDeepestUsefulMessage(cause, new Set(), 0, maximumLength) ??
    options.fallback.slice(0, maximumLength)
  );
}
