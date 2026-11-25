import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  packageSupportsTargetOs,
  renderThirdPartyNotices,
  type ThirdPartyLegalEntry,
} from "./generate-third-party-notices";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILD_RESOURCES_MANIFEST_FILENAME,
  resolveBuildResources,
  verifyBuildResourceTree,
} from "./build-resources";

function entry(overrides: Partial<ThirdPartyLegalEntry>): ThirdPartyLegalEntry {
  return {
    homepage: null,
    identity: "example@1.0.0",
    legalText: "Example license text",
    license: "MIT",
    ...overrides,
  };
}

describe("third-party notice generation", () => {
  test("keeps platform-neutral and macOS packages while excluding other binaries", () => {
    expect(packageSupportsTargetOs(undefined, "darwin")).toBe(true);
    expect(packageSupportsTargetOs(["darwin"], "darwin")).toBe(true);
    expect(packageSupportsTargetOs(["linux"], "darwin")).toBe(false);
    expect(packageSupportsTargetOs(["!win32"], "darwin")).toBe(true);
    expect(packageSupportsTargetOs(["!darwin"], "darwin")).toBe(false);
  });

  test("sorts packages and emits a shared legal text only once", () => {
    const output = renderThirdPartyNotices([
      entry({ identity: "zeta@1.0.0" }),
      entry({ identity: "alpha@2.0.0", homepage: "https://example.com/alpha" }),
    ]);

    expect(output.indexOf("alpha@2.0.0")).toBeLessThan(output.indexOf("zeta@1.0.0"));
    expect(output.match(/Example license text/g)).toHaveLength(1);
    expect(output).toContain("alpha@2.0.0 — MIT — https://example.com/alpha");
  });

  test("keeps declared-license evidence when a package omits its license file", () => {
    const output = renderThirdPartyNotices([
      entry({ identity: "metadata-only@1.0.0", legalText: null, license: "ISC" }),
    ]);

    expect(output).toContain("metadata-only@1.0.0 — ISC");
    expect(output).toContain("No separate license or notice file was published");
  });
});

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
