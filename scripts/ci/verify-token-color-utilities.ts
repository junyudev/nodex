import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import {
  createTokenColorValidator,
  explicitCssClasses,
  extractClassCandidates,
} from "./token-color-utilities";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });

async function main(): Promise<void> {
  const started = performance.now();
  const root = resolve(import.meta.dirname, "../..");
  const renderer = resolve(root, "src/renderer");
  const files = listFiles(renderer);
  const sources = files.filter((path) => sourceExtensions.has(extname(path)));
  const styles = files
    .filter((path) => extname(path) === ".css")
    .map((path) => ({ path, css: readFileSync(path, "utf8") }));
  const validate = await createTokenColorValidator(
    readFileSync(resolve(renderer, "globals.css"), "utf8"),
    renderer,
    explicitCssClasses(styles),
  );
  const usages = sources.flatMap((path) =>
    extractClassCandidates(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")),
  );
  const missing = validate(usages);
  for (const usage of missing) {
    console.error(
      `${usage.path}:${usage.line}:${usage.column} Undefined token color utility: ${usage.candidate}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} token color usages generate no CSS. Define the color in theme-token-bridge.css or use an existing utility.`,
    );
  }
  console.log(
    `Token color utilities verified: ${usages.length} usages, ${new Set(usages.map(({ candidate }) => candidate)).size} candidates, ${sources.length} files (${Math.round(performance.now() - started)} ms).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
