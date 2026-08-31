/**
 * A conservative, capped size estimate for protocol-shaped JSON values.
 *
 * It intentionally never serializes, maps, or enumerates into an intermediate array: ingress
 * admission must be able to reject a hostile payload without allocating a second payload-sized
 * string or collection. The estimate uses UTF-16 string storage and array slot overhead, so it is
 * deliberately an upper bound for the byte-oriented residency budgets that consume it.
 */
const MAX_TRAVERSAL_DEPTH = 128;

const normalizedLimit = (limit: number): number =>
  Number.isSafeInteger(limit) && limit > 0 ? limit : 1;

/**
 * Returns at most `limit + 1`. A result greater than `limit` means the value must not be admitted.
 * Sparse arrays and excessively deep structures are rejected conservatively rather than scanning
 * an attacker-controlled logical length or consuming the JavaScript call stack.
 */
export const cappedApproximateValueBytes = (value: unknown, inputLimit: number): number => {
  const limit = normalizedLimit(inputLimit);
  const seen = new WeakSet<object>();
  let bytes = 0;

  const charge = (amount: number): boolean => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > limit - bytes) {
      bytes = limit + 1;
      return false;
    }
    bytes += amount;
    return true;
  };

  const visit = (current: unknown, depth: number): boolean => {
    if (depth > MAX_TRAVERSAL_DEPTH) {
      bytes = limit + 1;
      return false;
    }
    if (current === null || current === undefined) return charge(8);
    if (typeof current === "string") return charge(16 + current.length * 2);
    if (typeof current === "number" || typeof current === "boolean") return charge(8);
    if (typeof current !== "object") return charge(16);
    if (seen.has(current)) return charge(8);
    seen.add(current);

    if (Array.isArray(current)) {
      if (!charge(24) || !charge(current.length * 8)) return false;
      const sparseEntries = current as unknown as Record<string, unknown>;
      for (const key in sparseEntries) {
        if (!Object.hasOwn(sparseEntries, key)) continue;
        if (!charge(8 + key.length * 2) || !visit(sparseEntries[key], depth + 1)) return false;
      }
      return true;
    }

    if (!charge(32)) return false;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (
        !charge(8 + key.length * 2) ||
        !visit((current as Record<string, unknown>)[key], depth + 1)
      ) {
        return false;
      }
    }
    return true;
  };

  visit(value, 0);
  return bytes;
};
