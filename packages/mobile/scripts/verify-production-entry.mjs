#!/usr/bin/env node
// Inspect Metro's exported dependency graph, not source text or minifier spelling.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: node scripts/verify-production-entry.mjs <expo-export-dir>");
const files = readdirSync(directory, { recursive: true }).filter((file) => file.endsWith(".map"));
if (files.length < 2) throw new Error("Expected both Android and iOS exported source maps");
for (const file of files) {
  const { sources } = JSON.parse(readFileSync(resolve(directory, file), "utf8"));
  if (!sources.some((source) => source.endsWith("/src/App.tsx")))
    throw new Error(`Missing product entry in ${file}`);
  if (sources.some((source) => /\/diagnostics\//u.test(source)))
    throw new Error(`Diagnostics shipped in ${file}`);
  console.log(`${file}: product entry present; diagnostics absent (${sources.length} modules)`);
}
