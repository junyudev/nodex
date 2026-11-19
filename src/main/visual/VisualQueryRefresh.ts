import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import { projectIdFromContentRoutingContext } from "../../shared/content-routing-context";
import type { VisualQueryRefreshInput, VisualQueryRefreshResult } from "../../shared/visual/bridge";
import {
  isVisualScalar,
  validateVisualKeys,
  VISUAL_LIMITS,
  type VisualRow,
  type VisualSource,
} from "../../shared/visual/contract";
import { textByteLength } from "../../shared/visual/metadata";
import { compileVisual, rewriteVisual } from "../../shared/visual/native";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { CoreModules } from "../core-runtime/CoreModules";
import type { LibraryModule } from "../library-application/LibraryModule";

type Failure = Extract<VisualQueryRefreshResult, { ok: false }>;
const failure = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

function projectRows(
  result: components["schemas"]["SqlResult"],
  key: VisualSource["key"],
): { ok: true; rows: VisualRow[] } | Failure {
  const { columns, rows } = result;
  if (rows.length > VISUAL_LIMITS.inlineRows)
    return failure("result-too-large", "A Visual query can return at most 2,000 rows");
  if (
    !columns.length ||
    new Set(columns).size !== columns.length ||
    columns.some((name) => !name.trim() || name === "__proto__")
  )
    return failure("invalid-result", "The query must return unique, nonempty column names");
  if (!(typeof key === "string" ? [key] : key).every((name) => columns.includes(name)))
    return failure("invalid-result", "The query must return each Visual key column");
  const projected: VisualRow[] = [];
  // Include the repeated object keys and JSON escaping that the source rewrite will store.
  let bytes = 2;
  for (const row of rows) {
    if (row.length !== columns.length || !row.every(isVisualScalar))
      return failure("invalid-result", "The query must return scalar cells");
    const object = Object.fromEntries(columns.map((name, index) => [name, row[index]]));
    bytes += textByteLength(JSON.stringify(object)) + Number(projected.length > 0);
    if (bytes > VISUAL_LIMITS.inlineBytes)
      return failure("result-too-large", "A Visual query result can use at most 256 KiB");
    projected.push(object);
  }
  const invalid = validateVisualKeys(projected, key);
  return invalid ? failure("invalid-result", invalid) : { ok: true, rows: projected };
}

export const refreshVisualQuery = Effect.fn("Visual.refreshQuery")(function* (
  input: VisualQueryRefreshInput,
  query: CoreModules["Service"]["query"],
  library: Pick<LibraryModule["Service"], "readProjectPageDetail" | "readLibraryPageDetail">,
): Effect.fn.Return<VisualQueryRefreshResult> {
  const compiled = compileVisual(input.source);
  if (!compiled.ok) return failure("invalid-source", "Fix the Visual source before refreshing");
  const sources = compiled.program.figures[input.figure]?.sources;
  const selected = sources && Object.hasOwn(sources, input.sourceName) && sources[input.sourceName];
  if (!selected || selected.kind !== "query")
    return failure("invalid-source", "Choose a query source in this Visual");

  const { pageId, routingContext } = input.page;
  const projectId = projectIdFromContentRoutingContext(routingContext);
  const page = yield* Effect.result(
    projectId
      ? library.readProjectPageDetail(projectId, pageId)
      : library.readLibraryPageDetail(pageId),
  );
  if (page._tag === "Failure" || !page.success.ok)
    return failure("page-unavailable", "The Visual's Page is unavailable");

  const result = yield* Effect.result(
    query.read(
      {
        kind: "query",
        query: { scope: { database_id: null, bindings: [] }, sql: selected.sql, parameters: {} },
      },
      projectId,
      { deadlineMs: 20_000 },
    ),
  );
  if (result._tag === "Failure") {
    const { cause } = result.failure;
    return failure(
      "query-failed",
      cause instanceof CoreModuleResponseError
        ? cause.coreError.message
        : "The Visual query could not run",
    );
  }
  if (result.success.store_epoch !== page.success.value.storeEpoch)
    return failure("page-unavailable", "The Visual's Page changed while refreshing");
  const { value } = result.success;
  if (value.kind !== "query") return failure("query-failed", "The Visual query returned no result");
  const projected = projectRows(value.value, selected.key);
  if (!projected.ok) return projected;
  const refreshedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const rewritten = rewriteVisual(input.source, {
    kind: "query",
    figure: input.figure,
    source: input.sourceName,
    data: projected.rows,
    refreshedAt,
  });
  if (!rewritten.ok)
    return failure(
      "result-too-large",
      "The refreshed query would put the Visual over its source limit",
    );
  return { ...projected, refreshedAt };
});
