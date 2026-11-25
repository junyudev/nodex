import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  assertPackagedAppArchive,
  readAppArchiveTopLevelEntries,
} from "./packaged-app-archive.mjs";
import {
  assertMacInstalledPayloadBudget,
  installedPayloadInventory,
} from "./installed-payload.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Write the asar preamble and JSON header for the given top-level names. */
function writeArchive(names: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-app-archive-"));
  temporaryRoots.push(root);
  const files = Object.fromEntries(
    names.map((name) => [name, name.includes(".") ? { size: 2, offset: "0" } : { files: {} }]),
  );
  const header = Buffer.from(JSON.stringify({ files }), "utf8");
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(header.length + 8, 4);
  preamble.writeUInt32LE(header.length + 4, 8);
  preamble.writeUInt32LE(header.length, 12);
  const archive = path.join(root, "app.asar");
  fs.writeFileSync(archive, Buffer.concat([preamble, header, Buffer.from("{}")]));
  return archive;
}

describe("packaged app archive", () => {
  test("accepts the application output and production dependencies", () => {
    const archive = writeArchive(["package.json", "out", "node_modules"]);

    expect(assertPackagedAppArchive(archive)).toEqual(["node_modules", "out", "package.json"]);
  });

  test("refuses an archive that captured the workspace", () => {
    const archive = writeArchive([
      "package.json",
      "out",
      "node_modules",
      "target",
      "cache.local",
      ".generated",
      "src",
    ]);

    expect(() => assertPackagedAppArchive(archive)).toThrow(
      /outside the application closure: \.generated, cache\.local, src, target/,
    );
  });

  test("refuses an archive without the application output", () => {
    expect(() => assertPackagedAppArchive(writeArchive(["node_modules", "package.json"]))).toThrow(
      /missing the application output/,
    );
  });

  test("reads names from the real asar layout", () => {
    expect(readAppArchiveTopLevelEntries(writeArchive(["out", "package.json"]))).toEqual([
      "out",
      "package.json",
    ]);
  });
});

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
      truncateSync(executable, 694_000_000);
      expect(assertMacInstalledPayloadBudget(root).bytes).toBe(694_000_000);
      truncateSync(executable, 694_000_001);
      expect(() => assertMacInstalledPayloadBudget(root)).toThrow("exceeds its");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
