import * as Effect from "effect/Effect";
import { csvParseRows } from "d3-dsv";
import {
  isVisualRow,
  isVisualScalar,
  validateVisualKeys,
  VISUAL_LIMITS,
  type VisualRow,
  type VisualRows,
  type VisualSource,
} from "../../shared/visual/contract";
import type { VisualProgram } from "../../shared/visual/compiler";
import { textByteLength } from "../../shared/visual/metadata";

export type VisualSourceReference = Extract<VisualSource, { kind: "file" | "table" }>;
export type VisualSourceContent =
  | { kind: "file"; text: string }
  | { kind: "table"; cells: string[][] };

export type ReadVisualSource = (
  reference: VisualSourceReference,
) => Effect.Effect<VisualSourceContent, unknown>;

function gridRows([columns, ...rows]: string[][]): VisualRow[] {
  if (
    !columns?.length ||
    columns.some((heading) => !heading.trim() || heading === "__proto__") ||
    new Set(columns).size !== columns.length
  )
    throw new Error("The source needs unique, nonempty column headings");
  return rows.map((row) => {
    if (row.length !== columns.length)
      throw new Error("Source rows must have the same width as the header");
    return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  });
}
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (isVisualScalar(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return (
    isVisualRow(value) &&
    Object.entries(value).every(
      ([key, item]) => key !== "__proto__" && isJsonValue(item, depth + 1),
    )
  );
}

export function parseVisualSource(
  reference: VisualSourceReference,
  content: VisualSourceContent,
): VisualRow[] {
  if (reference.kind === "table" && content.kind === "table") return gridRows(content.cells);
  if (reference.kind !== "file" || content.kind !== "file")
    throw new Error("Unexpected Visual source kind");
  if (textByteLength(content.text) > VISUAL_LIMITS.resolvedBytes)
    throw new Error("Page File sources are limited to 4 MiB");
  const text = content.text.replace(/^\uFEFF/u, "");
  if (reference.format === "csv") return gridRows(csvParseRows(text));
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isVisualRow) || !isJsonValue(parsed))
    throw new Error("The JSON source must be an array of row objects");
  return parsed;
}

export const resolveVisualSources = Effect.fn("Visual.resolveSources")(function* (
  program: VisualProgram,
  read: ReadVisualSource,
): Effect.fn.Return<VisualRows, unknown> {
  let totalBytes = 0;
  return yield* Effect.forEach(program.figures, ({ sources }) =>
    Effect.forEach(Object.entries(sources), ([name, source]) =>
      Effect.gen(function* () {
        const rows =
          source.kind === "data" || source.kind === "query"
            ? source.data
            : yield* read(source).pipe(
                Effect.flatMap((content) =>
                  Effect.try({
                    try: () => parseVisualSource(source, content),
                    catch: (cause) =>
                      new Error(
                        `${name}: ${cause instanceof Error ? cause.message : "Invalid source"}`,
                      ),
                  }),
                ),
              );
        totalBytes += textByteLength(JSON.stringify(rows));
        if (rows.length > VISUAL_LIMITS.resolvedRows || totalBytes > VISUAL_LIMITS.resolvedBytes)
          return yield* Effect.fail(
            new Error("Resolved sources exceed 20,000 rows per source or 4 MiB per Visual"),
          );
        const invalid = validateVisualKeys(rows, source.key);
        if (invalid) return yield* Effect.fail(new Error(`${name}: ${invalid}`));
        return [name, rows] as const;
      }),
    ).pipe(Effect.map(Object.fromEntries)),
  );
});

export const noVisualPage: ReadVisualSource = () =>
  Effect.fail(new Error("Provide a Visual block to resolve its Page Files and tables"));
