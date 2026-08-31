import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

const sortJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
};

function listFiles(rootPath: string, currentPath = rootPath): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(rootPath, entryPath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Schema generator emitted a non-file entry: ${entryPath}`);
    files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function readFingerprintContent(filePath: string): Buffer {
  if (path.extname(filePath) !== ".json") return readFileSync(filePath);
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as JsonValue;
  return Buffer.from(JSON.stringify(sortJsonValue(parsed)), "utf8");
}

export function fingerprintCodexSchemaTree(rootPath: string): string {
  const hash = createHash("sha256");
  for (const filePath of listFiles(rootPath)) {
    hash.update(path.relative(rootPath, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFingerprintContent(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}
