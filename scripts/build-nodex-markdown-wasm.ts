/**
 * Builds the WebAssembly module the app reads and writes Nodex Markdown with, from the same
 * `nodex-markdown` crate Core links natively. The output is committed so the app builds without
 * a Rust toolchain; the fixture test reads it back to prove it matches the crate.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src/shared/generated/nodex-markdown-wasm");
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
    "nodex-markdown",
    "--profile",
    "wasm-release",
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
    resolve(root, "target/wasm32-unknown-unknown/wasm-release/nodex_markdown.wasm"),
    "--out-dir",
    output,
    "--target",
    "web",
    "--typescript",
  ],
  { cwd: root, stdio: "inherit" },
);

// Callers always name the module. Without wasm-bindgen's `import.meta.url` default the loader
// also runs where code is compiled to CommonJS, such as Playwright's test harness.
const defaultModule =
  /\n\s*if \(module_or_path === undefined\) \{\n\s*module_or_path = new URL\('nodex_markdown_bg\.wasm', import\.meta\.url\);\n\s*\}/;
const generatedJavaScript = resolve(output, "nodex_markdown.js");
const source = readFileSync(generatedJavaScript, "utf8");
if (!defaultModule.test(source)) {
  throw new Error("wasm-bindgen's default module URL changed; update the build script");
}
const portable = source.replace(defaultModule, "");
if (portable.includes("import.meta")) {
  throw new Error("The generated loader still depends on import.meta");
}
writeFileSync(generatedJavaScript, `/* eslint-disable */\n${portable}`);
