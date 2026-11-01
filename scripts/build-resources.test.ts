import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  BUILD_RESOURCES_MANIFEST_FILENAME,
  resolveBuildResources,
  verifyBuildResourceTree,
} from "./build-resources";

const temporaryRoots: string[] = [];

const digest = (contents: Buffer): string => createHash("sha256").update(contents).digest("hex");

const createFixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-build-resources-"));
  temporaryRoots.push(root);
  const notices = Buffer.from("notices\n", "utf8");
  writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.txt"), notices);
  writeFileSync(
    path.join(root, BUILD_RESOURCES_MANIFEST_FILENAME),
    `${JSON.stringify(
      {
        outputs: {
          "THIRD_PARTY_NOTICES.txt": {
            sha256: digest(notices),
            size: notices.byteLength,
          },
        },
        schemaVersion: 2,
      },
      null,
      2,
    )}\n`,
  );
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("build resources", () => {
  test("resolves the generated resource directory from a repository root", () => {
    expect(resolveBuildResources("/repo/nodex").root).toBe(
      path.resolve("/repo/nodex", ".generated/build-resources"),
    );
  });

  test("verifies the exact notices-only resource tree", () => {
    const root = createFixture();
    expect(verifyBuildResourceTree(root).schemaVersion).toBe(2);

    writeFileSync(path.join(root, "unexpected.bin"), "unexpected\n");
    expect(() => verifyBuildResourceTree(root)).toThrow("unexpected entry");
  });

  test("reports missing and tampered notices", () => {
    const missing = createFixture();
    rmSync(path.join(missing, "THIRD_PARTY_NOTICES.txt"));
    expect(() => verifyBuildResourceTree(missing)).toThrow("unexpected entry");

    const tampered = createFixture();
    writeFileSync(path.join(tampered, "THIRD_PARTY_NOTICES.txt"), "tampered\n");
    expect(() => verifyBuildResourceTree(tampered)).toThrow(
      "THIRD_PARTY_NOTICES.txt does not match its manifest",
    );
  });
});
