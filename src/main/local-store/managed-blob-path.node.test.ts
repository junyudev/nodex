import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { resolveManagedBlobPath } from "./managed-blob-path";

const temporaryHomes: string[] = [];

const createProfileHome = (): string => {
  const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-managed-blob-path-"));
  temporaryHomes.push(profileHome);
  fs.mkdirSync(path.join(profileHome, "assets"));
  return profileHome;
};

afterEach(() => {
  for (const profileHome of temporaryHomes.splice(0)) {
    fs.rmSync(profileHome, { recursive: true, force: true });
  }
});

describe("resolveManagedBlobPath", () => {
  const contentHash = "a".repeat(64);

  test("resolves the current content-addressed blob filename", () => {
    const profileHome = createProfileHome();
    const blobPath = path.join(profileHome, "assets", `${contentHash}.blob`);
    fs.writeFileSync(blobPath, "bytes");

    expect(resolveManagedBlobPath(profileHome, contentHash)).toBe(blobPath);
  });

  test("does not interpret legacy prefixed names as current Blob identity", () => {
    const profileHome = createProfileHome();
    fs.writeFileSync(path.join(profileHome, "assets", `page-file-${contentHash}.blob`), "bytes");

    expect(resolveManagedBlobPath(profileHome, contentHash)).toBeNull();
  });

  test("rejects invalid hashes, missing files, and symbolic links", () => {
    const profileHome = createProfileHome();
    const target = path.join(profileHome, "target");
    fs.writeFileSync(target, "bytes");
    fs.symlinkSync(target, path.join(profileHome, "assets", `${contentHash}.blob`));

    expect(resolveManagedBlobPath(profileHome, "../nodex.db")).toBeNull();
    expect(resolveManagedBlobPath(profileHome, "b".repeat(64))).toBeNull();
    expect(resolveManagedBlobPath(profileHome, contentHash)).toBeNull();
  });
});
