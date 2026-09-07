import { expect, it } from "vite-plus/test";
import { describeContentSchemaInput, sqlQuerySchema } from "./query-schemas";

it("validates SQL bindings from the Core contract and rejects extra caller authority", () => {
  expect(
    sqlQuerySchema.parse({
      scope: { bindings: [{ table: "tasks", data_source_id: "source" }] },
      sql: "SELECT * FROM tasks",
      parameters: { title: "hello" },
    }),
  ).toMatchObject({ sql: "SELECT * FROM tasks" });
  for (const input of [
    { scope: {}, sql: "SELECT 1", profileId: "other" },
    { scope: { bindings: [{ table: "tasks", projectId: "other" }] }, sql: "SELECT 1" },
    { scope: { bindings: [{ table: "tasks", data_source_id: 12 }] }, sql: "SELECT 1" },
  ])
    expect(sqlQuerySchema.safeParse(input).success).toBe(false);
  expect(describeContentSchemaInput.safeParse({ scope: {}, relation: "pages" }).success).toBe(true);
});
