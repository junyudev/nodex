export const VISUAL_MODULES = [
  "react",
  "d3-scale",
  "d3-shape",
  "d3-array",
  "d3-format",
  "d3-time",
  "d3-time-format",
  "d3-hierarchy",
  "@observablehq/plot",
] as const;

export const VISUAL_LIMITS = {
  textBytes: 1024 * 1024,
  inlineBytes: 256 * 1024,
  inlineRows: 2_000,
  resolvedBytes: 4 * 1024 * 1024,
  resolvedRows: 20_000,
  pixelsPerSide: 4096,
  liveGuests: 3,
  renderMilliseconds: 5_000,
} as const;

export type VisualScalar = string | number | boolean | null;
export type VisualValue = VisualScalar | VisualValue[] | { [name: string]: VisualValue };
export type VisualRow = Record<string, VisualValue>;
export type VisualKey = VisualScalar | VisualScalar[];

export type VisualSource = { key: string | string[] } & (
  | { kind: "data"; data: VisualRow[] }
  | { kind: "query"; sql: string; data: VisualRow[]; refreshedAt: string }
  | { kind: "file"; file: string; format: "csv" | "json" }
  | { kind: "table"; block: string; header: true }
);

export type VisualParam =
  | { kind: "range"; min: number; max: number; step?: number; value: number }
  | { kind: "select"; options: VisualScalar[]; value: VisualScalar }
  | { kind: "toggle"; value: boolean };

/** Offsets are UTF-16 and the end is exclusive. */
export interface VisualSpan {
  start: number;
  end: number;
}
export interface VisualDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  span?: VisualSpan;
}
export interface VisualTextLiteral extends VisualSpan {
  value: string;
  kind: "jsx-text" | "string";
}
export interface VisualFigure {
  caption: string;
  sources: Record<string, VisualSource>;
  params: Record<string, VisualParam>;
}
export type VisualRows = Record<string, VisualRow[]>[];
export type VisualParamValues = Record<string, VisualScalar>[];

export type VisualRewrite =
  | {
      kind: "row";
      figure: number;
      source: string;
      key: VisualKey;
      field: string;
      value: VisualValue;
    }
  | { kind: "query"; figure: number; source: string; data: VisualRow[]; refreshedAt: string }
  | { kind: "param"; figure: number; param: string; value: VisualScalar }
  | { kind: "text"; span: VisualSpan; value: string };

export function visualRowKey(row: VisualRow, key: VisualSource["key"]): VisualKey | undefined {
  const columns = typeof key === "string" ? [key] : key;
  const parts = columns.map((column) => (Object.hasOwn(row, column) ? row[column] : undefined));
  if (!parts.every(isVisualScalar)) return undefined;
  return typeof key === "string" ? parts[0] : parts;
}

export function isVisualScalar(value: unknown): value is VisualScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function isVisualRow(value: unknown): value is VisualRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateVisualKeys(
  rows: VisualRow[],
  key: VisualSource["key"],
): string | undefined {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = visualRowKey(row, key);
    if (value === undefined) return "Every row needs a scalar value in each key column";
    const encoded = JSON.stringify(value);
    if (seen.has(encoded)) return "Row keys must be unique";
    seen.add(encoded);
  }
  return undefined;
}
