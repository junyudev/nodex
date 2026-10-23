export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

export function getString(
  candidate: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!candidate) return undefined;
  const value = candidate[key];
  return typeof value === "string" ? value : undefined;
}

export function getNumber(
  candidate: Record<string, unknown> | null,
  key: string,
): number | undefined {
  if (!candidate) return undefined;
  const value = candidate[key];
  return typeof value === "number" ? value : undefined;
}

export function humanizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";

  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

/** Script tools author their activity title; other tools' title arguments are input data. */
export function resolveScriptToolTitle(tool: string, argumentsValue: unknown): string | null {
  if (tool.trim().toLowerCase() !== "js") return null;
  const rawTitle = asRecord(argumentsValue)?.title;
  if (typeof rawTitle !== "string") return null;
  const title = rawTitle.trim().replace(/\s+/g, " ");
  if (!title) return null;
  return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
}
