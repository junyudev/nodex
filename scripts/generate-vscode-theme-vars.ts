import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildVscodeTokenCss,
  parseVscodeTokenKeys,
} from "../src/renderer/lib/vscode-theme-vars";

const REPO_ROOT = resolve(import.meta.dir, "..");
const KEYS_FILE = resolve(REPO_ROOT, "scripts/vscode-theme-color-keys.txt");
const OUTPUT_FILE = resolve(REPO_ROOT, "src/renderer/styles/vscode-theme-vars.css");

function main(): void {
  const keyContents = readFileSync(KEYS_FILE, "utf8");
  const keys = parseVscodeTokenKeys(keyContents);

  const css = buildVscodeTokenCss(keys);

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, css, "utf8");

  console.log(`Generated ${OUTPUT_FILE}`);
  console.log(`VS Code token keys: ${keys.length}`);
}

main();
