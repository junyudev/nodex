import { transformSync } from "esbuild";
import { expect, test } from "vite-plus/test";
import { eagerRequireSpecifiers, emittedModuleImports } from "./emitted-module-graph";

test.each([false, true])("reads static and dynamic imports with minify=%s", (minify) => {
  const { code } = transformSync(
    `import { bootstrap } from "./runtime.js";
     import "./side-effects.js";
     export * from "./forwarded.js";
     export { ready, done } from "./named.js";
     export { bootstrap };
     export const start = () => import("./application.js");
     export const text = 'import "./not-an-import.js";';`,
    { format: "esm", minify },
  );
  expect(emittedModuleImports("entry.js", code)).toEqual({
    staticImports: ["./runtime.js", "./side-effects.js", "./forwarded.js", "./named.js"],
    dynamicImports: ["./application.js"],
  });
});

test("rejects invalid code instead of treating it as dependency-free", () => {
  expect(() => emittedModuleImports("entry.js", "import {")).toThrow("Unable to parse");
  expect(() => eagerRequireSpecifiers("entry.js", "require(")).toThrow("Unable to parse");
});

test("finds only the requires a CommonJS chunk runs while it loads", () => {
  const source = `"use strict";
const runtime = require("./runtime.js"), markdown = require("./markdown.js");
let electron = require("electron");
if (process.platform === "darwin") require("./darwin.js");
class Window { static { require("./window.js"); } open() { return require("./later.js"); } }
function menu() { return require("./menu.js"); }
const locale = () => Promise.resolve().then(() => require("./zh-CN.js"));
require(process.env.PLUGIN);`;
  expect(eagerRequireSpecifiers("bootstrap.js", source)).toEqual([
    "./runtime.js",
    "./markdown.js",
    "electron",
    "./darwin.js",
    "./window.js",
  ]);
});
