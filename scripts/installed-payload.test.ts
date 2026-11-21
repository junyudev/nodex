import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  assertMacInstalledPayloadBudget,
  installedPayloadInventory,
} from "./installed-payload.mjs";

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

test.skipIf(process.platform === "win32")(
  "bounds macOS installed bytes without following framework symlinks",
  () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-mac-installed-payload-"));
    try {
      const executable = join(root, "framework-binary");
      writeFileSync(executable, "host");
      symlinkSync("framework-binary", join(root, "framework-link"));
      expect(assertMacInstalledPayloadBudget(root)).toMatchObject({ bytes: 4, fileCount: 1 });
      truncateSync(executable, 690_000_000);
      expect(assertMacInstalledPayloadBudget(root).bytes).toBe(690_000_000);
      truncateSync(executable, 690_000_001);
      expect(() => assertMacInstalledPayloadBudget(root)).toThrow("exceeds its");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
