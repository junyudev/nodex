import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { readCoreArtifactDigest } from "./core-artifact";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(filename = "nodex-core.exe") {
  const home = mkdtempSync(join(tmpdir(), "nodex-core-artifact-"));
  roots.push(home);
  const executable = join(home, filename);
  const manifest = join(home, "rust-core-runtime.json");
  const bytes = Buffer.from("Core artifact bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const entry = { name: "nodex-core", sourceSha256: digest };
  writeFileSync(executable, bytes);
  writeFileSync(manifest, JSON.stringify({ binaries: [entry] }));
  return { executable, manifest, digest, entry };
}

test.each(["nodex-core", "nodex-core.exe"])(
  "binds %s to the logical Core identity and rejects changed executable bytes",
  (filename) => {
    const input = fixture(filename);
    expect(readCoreArtifactDigest(input.executable, input.manifest)).toBe(input.digest);
    writeFileSync(input.executable, "changed artifact");
    expect(() => readCoreArtifactDigest(input.executable, input.manifest)).toThrow(
      "does not match",
    );
  },
);

test.each(["filename", "missing", "duplicate", "invalid"] as const)(
  "rejects a %s manifest identity",
  (kind) => {
    const input = fixture();
    const binaries = {
      filename: [{ ...input.entry, name: "nodex-core.exe" }],
      missing: [],
      duplicate: [input.entry, input.entry],
      invalid: [{ ...input.entry, sourceSha256: "invalid" }],
    }[kind];
    writeFileSync(input.manifest, JSON.stringify({ binaries }));
    expect(() => readCoreArtifactDigest(input.executable, input.manifest)).toThrow(
      "exactly one Core artifact digest",
    );
  },
);
