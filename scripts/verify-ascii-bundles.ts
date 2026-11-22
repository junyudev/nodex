import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { measureWorkbenchClosure } from "./lib/startup-closure";

/**
 * V8 keeps a script's source as one-byte text only while every character in it is ASCII; a
 * single other character makes it hold the whole file as two-byte text for as long as the
 * process runs. Main, preloads, the Agent Runtime's own bundle and everything the Workbench
 * always loads stay ASCII. Bundlers escape string literals themselves; a character inside a
 * regular expression or a tagged template is kept as written, so write it as a `\u` escape.
 */
const files = (directory: string, exclude: (file: string) => boolean = () => false): string[] =>
  readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (exclude(file)) return [];
    if (statSync(file).isDirectory()) return files(file, exclude);
    return /\.(?:c|m)?js$/u.test(name) ? [file] : [];
  });

const checked = [
  ...files(path.resolve("out/main")),
  ...files(path.resolve("out/preload")),
  ...files(path.resolve("out/agent-runtime"), (file) => path.basename(file) === "node_modules"),
  ...measureWorkbenchClosure({
    rendererDirectory: path.resolve("out/renderer"),
    rootChunkName: "application-renderer",
    onDemandPackages: [],
  }).javaScriptFiles,
];

const failures = checked.flatMap((file) => {
  const source = readFileSync(file);
  const offset = source.findIndex((byte) => byte > 0x7f);
  if (offset < 0) return [];
  const context = source
    .subarray(Math.max(0, offset - 60), offset + 20)
    .toString("utf8")
    .replace(/\s+/gu, " ");
  return [`${path.relative(process.cwd(), file)} at byte ${offset}: …${context}…`];
});

if (failures.length > 0)
  throw new Error(
    [
      "Bundles that stay loaded must be ASCII so V8 keeps their source one-byte. Write these",
      "characters as \\u escapes in source (regular expressions and tagged templates keep them):",
      ...failures.map((failure) => `  ${failure}`),
    ].join("\n"),
  );
process.stdout.write(`${checked.length} always-loaded bundles are ASCII.\n`);
