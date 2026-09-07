import { expect, it } from "vite-plus/test";
import { toolSuccess } from "./app-tool-result";

it("returns a complete failure instead of truncating an oversized result", () => {
  const result = toolSuccess({ rows: ["正文".repeat(150_000)] });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ error: { code: "result_too_large" } });
});

it("enforces a narrower tool budget without changing the successful payload", () => {
  const value = { text: "x".repeat(1000) };
  expect(toolSuccess(value, 500).isError).toBe(true);
  expect(toolSuccess(value, 3000).structuredContent).toEqual(value);
});
