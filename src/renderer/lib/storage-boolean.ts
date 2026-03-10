export function normalizeStoredBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return defaultValue;
}

export function readStoredBoolean(
  storageKey: string,
  defaultValue: boolean,
): boolean {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultValue;
    return normalizeStoredBoolean(raw, defaultValue);
  } catch {
    return defaultValue;
  }
}

export function writeStoredBoolean(
  storageKey: string,
  value: unknown,
  defaultValue: boolean,
): boolean {
  const normalized = normalizeStoredBoolean(value, defaultValue);
  try {
    localStorage.setItem(storageKey, String(normalized));
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}
