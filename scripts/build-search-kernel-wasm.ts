import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "crates/nodex-search-kernel/generated");
const expectedWasmBindgenVersion = "0.2.129";

const wasmBindgenVersion = execFileSync("wasm-bindgen", ["--version"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!wasmBindgenVersion.endsWith(expectedWasmBindgenVersion)) {
  throw new Error(
    `wasm-bindgen ${expectedWasmBindgenVersion} is required; found ${wasmBindgenVersion}`,
  );
}

execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "nodex-search-kernel",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--features",
    "wasm",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  "wasm-bindgen",
  [
    resolve(root, "target/wasm32-unknown-unknown/release/nodex_search_kernel.wasm"),
    "--out-dir",
    output,
    "--target",
    "web",
    "--typescript",
  ],
  { cwd: root, stdio: "inherit" },
);

const generatedJavaScript = resolve(output, "nodex_search_kernel.js");
const source = readFileSync(generatedJavaScript, "utf8");
const defaultModule =
  /\n\s*if \(module_or_path === undefined\) \{\n\s*module_or_path = new URL\('nodex_search_kernel_bg\.wasm', import\.meta\.url\);\n\s*\}/;
if (!defaultModule.test(source)) throw new Error("Unexpected wasm-bindgen module loader");
writeFileSync(generatedJavaScript, `/* eslint-disable */\n${source.replace(defaultModule, "")}`);
rmSync(resolve(output, "nodex_search_kernel_bg.wasm.d.ts"));
