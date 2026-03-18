import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createReleaseDownloadAliases } from "./release-download-aliases";

test("createReleaseDownloadAliases copies both DMGs to stable alias filenames", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-release-download-aliases-"));

  try {
    const arm64Dir = join(tempDir, "arm64");
    const x64Dir = join(tempDir, "x64");
    Bun.spawnSync(["mkdir", "-p", arm64Dir, x64Dir]);

    const arm64SourcePath = join(arm64Dir, "Nodex-0.1.6-arm64.dmg");
    const x64SourcePath = join(x64Dir, "Nodex-0.1.6-x64.dmg");
    writeFileSync(arm64SourcePath, "arm64-dmg-bytes", "utf8");
    writeFileSync(x64SourcePath, "x64-dmg-bytes", "utf8");

    const aliases = createReleaseDownloadAliases({
      version: "0.1.6",
      arm64Dir,
      x64Dir,
    });

    expect(readFileSync(aliases.arm64AliasPath, "utf8")).toBe("arm64-dmg-bytes");
    expect(readFileSync(aliases.x64AliasPath, "utf8")).toBe("x64-dmg-bytes");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createReleaseDownloadAliases throws when the arm64 DMG is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-release-download-aliases-"));

  try {
    const arm64Dir = join(tempDir, "arm64");
    const x64Dir = join(tempDir, "x64");
    Bun.spawnSync(["mkdir", "-p", arm64Dir, x64Dir]);
    writeFileSync(join(x64Dir, "Nodex-0.1.6-x64.dmg"), "x64-dmg-bytes", "utf8");

    let threw = false;

    try {
      createReleaseDownloadAliases({
        version: "0.1.6",
        arm64Dir,
        x64Dir,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBeTrue();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createReleaseDownloadAliases throws when the x64 DMG is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-release-download-aliases-"));

  try {
    const arm64Dir = join(tempDir, "arm64");
    const x64Dir = join(tempDir, "x64");
    Bun.spawnSync(["mkdir", "-p", arm64Dir, x64Dir]);
    writeFileSync(join(arm64Dir, "Nodex-0.1.6-arm64.dmg"), "arm64-dmg-bytes", "utf8");

    let threw = false;

    try {
      createReleaseDownloadAliases({
        version: "0.1.6",
        arm64Dir,
        x64Dir,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBeTrue();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
