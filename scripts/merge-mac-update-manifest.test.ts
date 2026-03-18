import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeMacUpdateManifestFiles, mergeMacUpdateManifests } from "./merge-mac-update-manifest";

test("mergeMacUpdateManifests combines files and suppresses duplicates", () => {
  const merged = mergeMacUpdateManifests([
    {
      version: "0.1.6",
      releaseDate: "2026-03-18T12:00:00.000Z",
      files: [
        { url: "Nodex-0.1.6-arm64.zip", sha512: "arm64-sha" },
      ],
      path: "Nodex-0.1.6-arm64.zip",
      sha512: "arm64-sha",
    },
    {
      version: "0.1.6",
      files: [
        { url: "Nodex-0.1.6-x64.zip", sha512: "x64-sha" },
        { url: "Nodex-0.1.6-arm64.zip", sha512: "arm64-sha" },
      ],
      path: "Nodex-0.1.6-x64.zip",
      sha512: "x64-sha",
    },
  ]);

  expect(merged.version).toBe("0.1.6");
  expect(merged.path).toBe("Nodex-0.1.6-arm64.zip");
  expect(merged.sha512).toBe("arm64-sha");
  expect(JSON.stringify(merged.files?.map((file) => file.url))).toBe(JSON.stringify([
    "Nodex-0.1.6-arm64.zip",
    "Nodex-0.1.6-x64.zip",
  ]));
});

test("mergeMacUpdateManifestFiles writes a canonical latest-mac.yml", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-merge-mac-update-manifest-"));

  try {
    const arm64Path = join(tempDir, "arm64-latest-mac.yml");
    const x64Path = join(tempDir, "x64-latest-mac.yml");
    const outputPath = join(tempDir, "latest-mac.yml");

    writeFileSync(arm64Path, [
      "version: 0.1.6",
      "files:",
      "  - url: Nodex-0.1.6-arm64.zip",
      "    sha512: arm64-sha",
      "path: Nodex-0.1.6-arm64.zip",
      "sha512: arm64-sha",
      "",
    ].join("\n"), "utf8");
    writeFileSync(x64Path, [
      "version: 0.1.6",
      "files:",
      "  - url: Nodex-0.1.6-x64.zip",
      "    sha512: x64-sha",
      "path: Nodex-0.1.6-x64.zip",
      "sha512: x64-sha",
      "",
    ].join("\n"), "utf8");

    const merged = mergeMacUpdateManifestFiles([arm64Path, x64Path], outputPath);
    const written = readFileSync(outputPath, "utf8");

    expect(merged.version).toBe("0.1.6");
    expect(written.includes("Nodex-0.1.6-arm64.zip")).toBeTrue();
    expect(written.includes("Nodex-0.1.6-x64.zip")).toBeTrue();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mergeMacUpdateManifests rejects mismatched versions", () => {
  let threw = false;

  try {
    mergeMacUpdateManifests([
      {
        version: "0.1.6",
        files: [{ url: "Nodex-0.1.6-arm64.zip", sha512: "arm64-sha" }],
      },
      {
        version: "0.1.7",
        files: [{ url: "Nodex-0.1.7-x64.zip", sha512: "x64-sha" }],
      },
    ]);
  } catch {
    threw = true;
  }

  expect(threw).toBeTrue();
});
