import { transformSync } from "esbuild";
import { expect, test } from "vite-plus/test";
import { rendererBootstrapImports } from "./renderer-bootstrap-imports";

test.each([false, true])("finds eager dependencies with minify=%s", (minify) => {
  const { code } = transformSync(
    `import { bootstrap } from "./runtime.js";
     import "./side-effects.js";
     export * from "./forwarded.js";
     export { ready } from "./named.js";
     export { bootstrap };
     export const start = () => import("./application.js");
     export const text = 'import "./not-an-import.js";';`,
    { format: "esm", minify },
  );
  expect(rendererBootstrapImports("entry.js", code)).toEqual([
    "./runtime.js",
    "./side-effects.js",
    "./forwarded.js",
    "./named.js",
  ]);
});

test("rejects invalid entry code instead of treating it as dependency-free", () => {
  expect(() => rendererBootstrapImports("entry.js", "import {")).toThrow("Unable to parse");
});
