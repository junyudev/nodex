import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src/renderer/generated/page-search-wasm");
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
    "nodex-page-search-kernel",
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
    resolve(root, "target/wasm32-unknown-unknown/release/nodex_page_search_kernel.wasm"),
    "--out-dir",
    output,
    "--target",
    "web",
    "--typescript",
  ],
  { cwd: root, stdio: "inherit" },
);

const generatedJavaScript = resolve(output, "nodex_page_search_kernel.js");
const source = readFileSync(generatedJavaScript, "utf8");
writeFileSync(generatedJavaScript, `/* eslint-disable */\n${source}`);
