import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hashes Core bytes and, for a packaged runtime, verifies its extension-free logical identity. */
export function readCoreArtifactDigest(executablePath: string, manifestPath?: string): string {
  const actual = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  if (!manifestPath) return actual;

  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isRecord(manifest) || !Array.isArray(manifest.binaries)) {
    throw new Error("Packaged native runtime manifest has no binary inventory");
  }
  const entries = manifest.binaries
    .filter(isRecord)
    .filter((binary) => binary.name === "nodex-core");
  const expected = entries.length === 1 ? entries[0]?.sourceSha256 : undefined;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error(
      "Packaged native runtime manifest must identify exactly one Core artifact digest",
    );
  }
  if (actual !== expected) {
    throw new Error("Packaged Core executable does not match its runtime manifest");
  }
  return actual;
}
