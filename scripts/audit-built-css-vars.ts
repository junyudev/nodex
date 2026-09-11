import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PREFIXES = ["--vscode-", "--color-token-", "--tw-"];

const findLatestBuildCss = (): string => {
  const assetsDir = resolve(process.cwd(), "out/renderer/assets");
  if (!existsSync(assetsDir)) {
    throw new Error(`Renderer assets directory not found: ${assetsDir}`);
  }

  const matches = readdirSync(assetsDir)
    .filter((name) => /^globals-.*\.css$/.test(name))
    .map((name) => resolve(assetsDir, name))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);

  const latest = matches.at(-1);
  if (!latest) {
    throw new Error("No renderer build CSS found in out/renderer/assets.");
  }

  return latest;
};

const args = process.argv.slice(2);
const buildCssPath = resolve(args[0] ?? findLatestBuildCss());
const prefixes = args.length > 1 ? args.slice(1) : DEFAULT_PREFIXES;

if (!existsSync(buildCssPath)) {
  throw new Error(`Build CSS not found: ${buildCssPath}`);
}

const css = readFileSync(buildCssPath, "utf8");
const declarationPattern = /(?<=[{;])\s*(--[A-Za-z0-9_.\\-]+)\s*:/g;
const referencePattern = /var\((--[A-Za-z0-9_.\\-]+)/g;

const declarations = new Set<string>();
for (const match of css.matchAll(declarationPattern)) {
  declarations.add(match[1]);
}

const references = new Set<string>();
for (const match of css.matchAll(referencePattern)) {
  const name = match[1];
  if (prefixes.some((prefix) => name.startsWith(prefix))) {
    references.add(name);
  }
}

const undefinedReferences = [...references].filter((name) => !declarations.has(name)).sort();

console.log(`Build: ${buildCssPath}`);
console.log(`Prefixes: ${prefixes.join(", ")}`);
console.log(`Referenced vars: ${references.size}`);
console.log(`Undefined vars: ${undefinedReferences.length}`);

if (undefinedReferences.length > 0) {
  for (const name of undefinedReferences) {
    console.log(`- ${name}`);
  }
  process.exitCode = 1;
}
