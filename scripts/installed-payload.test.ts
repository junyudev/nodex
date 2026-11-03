import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { installedPayloadInventory } from "./installed-payload.mjs";

test("measures installed bytes and physical files across nested runtime closures", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-installed-payload-"));
  try {
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "Nodex.exe"), "host");
    writeFileSync(join(root, "resources/app.asar"), "archive");
    expect(installedPayloadInventory(root)).toEqual({
      bytes: 11,
      fileCount: 2,
      files: [
        { path: "Nodex.exe", size: 4 },
        { path: "resources/app.asar", size: 7 },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
