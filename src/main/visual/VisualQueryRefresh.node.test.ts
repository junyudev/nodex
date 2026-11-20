import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import type { QueryRead, QueryReadSnapshot } from "../core-client/types";
import type { PageDetail } from "../../shared/page-detail";
import { projectContentRoute } from "../../shared/content-routing-context";
import { refreshVisualQuery } from "./VisualQueryRefresh";

const sql = "SELECT page_id AS id, title FROM pages LIMIT 2";
const input = {
  source: `<nodex.Visualize caption="Page titles" sources={{pages: {kind: "query", key: "id", sql: ${JSON.stringify(sql)}, data: [], refreshedAt: "2026-01-01T00:00:00.000Z"}}} params={{}}>{() => <svg role="img" aria-label="Pages" />}</nodex.Visualize>`,
  page: { pageId: "page-a", routingContext: projectContentRoute("project-a") },
  figure: 0,
  sourceName: "pages",
};

const snapshot = (rows: unknown[][]): QueryReadSnapshot => ({
  store_epoch: "epoch",
  commit_head: 0,
  contract_version: 5,
  value: {
    kind: "query",
    value: { columns: ["id", "title"], rows, returned_count: rows.length, snapshot: "observation" },
  },
});
const library = {
  readProjectPageDetail: (projectId: string, pageId: string) => {
    expect([projectId, pageId]).toEqual(["project-a", "page-a"]);
    return Effect.succeed({ ok: true as const, value: { storeEpoch: "epoch" } as PageDetail });
  },
  readLibraryPageDetail: () => Effect.die(new Error("Expected the Page's Project route")),
};

it.effect("refreshes the named query with the Page's Project route and returns keyed rows", () =>
  Effect.gen(function* () {
    const query = {
      read: (read: QueryRead, projectId: string | null) => {
        expect(projectId).toBe("project-a");
        expect(read).toEqual({
          kind: "query",
          query: { sql, parameters: {}, scope: { database_id: null, bindings: [] } },
        });
        return Effect.succeed(snapshot([["id-a", "New title"]]));
      },
    };
    const result = yield* refreshVisualQuery(input, query, library);
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "id-a", title: "New title" }],
      refreshedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u),
    });
  }),
);

it.effect(
  "refuses missing Pages before running SQL and rejects oversized or ambiguous results",
  () =>
    Effect.gen(function* () {
      const inaccessible = yield* refreshVisualQuery(
        input,
        {
          read: () => Effect.die(new Error("A missing Page must not run SQL")),
        },
        {
          ...library,
          readProjectPageDetail: () =>
            Effect.succeed({
              ok: false,
              error: { code: "page_not_found", message: "Missing", retryable: false },
            }),
        },
      );
      expect(inaccessible).toMatchObject({ ok: false, code: "page-unavailable" });
      const cases = [
        { rows: Array.from({ length: 2001 }, (_, i) => [i, "row"]), code: "result-too-large" },
        { rows: [["id-a", "図".repeat(100_000)]], code: "result-too-large" },
        {
          rows: [
            ["same", "first"],
            ["same", "second"],
          ],
          code: "invalid-result",
        },
      ];
      for (const { rows, code } of cases) {
        const result = yield* refreshVisualQuery(
          input,
          { read: () => Effect.succeed(snapshot(rows)) },
          library,
        );
        expect(result).toMatchObject({ ok: false, code });
      }
    }),
);
