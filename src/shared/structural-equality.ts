/** Compares plain protocol values without depending on object key insertion order. */
export function areStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => areStructurallyEqual(entry, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areStructurallyEqual(leftRecord[key], rightRecord[key]),
  );
}
