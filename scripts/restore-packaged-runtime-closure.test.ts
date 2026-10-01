import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { BROWSER_RUNTIME_SCHEMA_VERSION } from "../src/shared/browser-runtime-metadata";
import { restorePackagedBrowserRuntimeClosure } from "./restore-packaged-runtime-closure.mjs";

const temporaryRoots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(schemaVersion: number = BROWSER_RUNTIME_SCHEMA_VERSION): {
  packagedBrowserRoot: string;
  placeholderPath: string;
  sourceBrowserRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-after-pack-"));
  temporaryRoots.push(root);
  const sourceBrowserRoot = path.join(root, "source");
  const packagedBrowserRoot = path.join(root, "packaged");
  const relativePlaceholder = "runtime/lib/example/.gitkeep";
  const sourcePlaceholderPath = path.join(sourceBrowserRoot, relativePlaceholder);
  const packagedParent = path.join(packagedBrowserRoot, path.dirname(relativePlaceholder));
  fs.mkdirSync(path.dirname(sourcePlaceholderPath), { recursive: true });
  fs.mkdirSync(packagedParent, { recursive: true });
  fs.writeFileSync(sourcePlaceholderPath, "");
  const manifest = {
    artifacts: [
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: relativePlaceholder,
        sha256: sha256(""),
        size: 0,
      },
    ],
    schemaVersion,
  };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(path.join(sourceBrowserRoot, "browser-runtime-manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(packagedBrowserRoot, "browser-runtime-manifest.json"), manifestBytes);
  return {
    packagedBrowserRoot,
    placeholderPath: path.join(packagedParent, ".gitkeep"),
    sourceBrowserRoot,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("restorePackagedBrowserRuntimeClosure", () => {
  test("restores placeholders from the current Browser runtime manifest schema", () => {
    const fixture = createFixture();

    expect(restorePackagedBrowserRuntimeClosure(fixture)).toBe(1);
    expect(fs.readFileSync(fixture.placeholderPath, "utf8")).toBe("");
    expect(restorePackagedBrowserRuntimeClosure(fixture)).toBe(0);
  });

  test.each([BROWSER_RUNTIME_SCHEMA_VERSION - 1, BROWSER_RUNTIME_SCHEMA_VERSION + 1])(
    "rejects schema-v%i before restoring a placeholder",
    (schemaVersion) => {
      const fixture = createFixture(schemaVersion);

      expect(() => restorePackagedBrowserRuntimeClosure(fixture)).toThrow(
        "Unsupported Browser runtime manifest",
      );
      expect(fs.existsSync(fixture.placeholderPath)).toBe(false);
    },
  );

  test("rejects a staged placeholder that does not match the verified manifest", () => {
    const fixture = createFixture();
    const stagedPlaceholder = fixture.placeholderPath.replace(
      fixture.packagedBrowserRoot,
      fixture.sourceBrowserRoot,
    );
    fs.writeFileSync(stagedPlaceholder, "tampered");

    expect(() => restorePackagedBrowserRuntimeClosure(fixture)).toThrow(
      "Staged Browser runtime artifact does not match its manifest",
    );
    expect(fs.existsSync(fixture.placeholderPath)).toBe(false);
  });

  test("rejects a packaged parent symlink instead of writing through it", () => {
    const fixture = createFixture();
    const packagedParent = path.dirname(fixture.placeholderPath);
    fs.rmSync(packagedParent, { recursive: true });
    fs.symlinkSync(
      path.join(fixture.sourceBrowserRoot, "runtime", "lib", "example"),
      packagedParent,
    );

    expect(() => restorePackagedBrowserRuntimeClosure(fixture)).toThrow("is not a real directory");
  });
});
