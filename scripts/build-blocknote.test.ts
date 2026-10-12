import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("rejects another checkout before clearing authored types", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "nodex-blocknote-build-owner-"));
  const packageDirectory = join(temporaryDirectory, "third_party/blocknote/packages/core");
  const authoredFile = join(packageDirectory, "types/authored.ts");
  const contents = "export type AuthoredContract = { readonly value: string };\n";
  try {
    mkdirSync(join(packageDirectory, "types"), { recursive: true });
    writeFileSync(authoredFile, contents);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./build-blocknote.mts", import.meta.url))],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readFileSync(authoredFile, "utf8")).toBe(contents);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
