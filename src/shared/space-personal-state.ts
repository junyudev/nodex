/** Device-local presentation state may contain global Desktop preferences or a fully qualified key. */
export function personalStateKeySpace(key: string): string | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value[0] !== "space") return null;
    return value.length === 4 &&
      typeof value[1] === "string" &&
      (value[2] === null || typeof value[2] === "string") &&
      typeof value[3] === "string"
      ? value[1]
      : "";
  } catch {
    return null;
  }
}

export function personalStateKeyMatches(
  key: string,
  spaceId: string,
  memberId?: string | null,
): boolean {
  const owner = personalStateKeySpace(key);
  if (owner === null) return true;
  if (owner !== spaceId) return false;
  return memberId === undefined || (JSON.parse(key) as unknown[])[2] === memberId;
}
