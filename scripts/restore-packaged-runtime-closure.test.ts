import { writeWindowsBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-windows-test-fixture";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { BROWSER_RUNTIME_SCHEMA_VERSION } from "../src/shared/browser-runtime-metadata";
import restorePackagedRuntimeClosure, {
  restorePackagedBrowserRuntimeClosure,
} from "./restore-packaged-runtime-closure.mjs";
import { writePackagedStockNodeFixture } from "./testing/packaged-stock-node-fixture";

const temporaryRoots: string[] = [];

test("afterPack rejects a Codex artifact in the macOS app before signing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-mac-after-pack-"));
  temporaryRoots.push(root);
  const resourcesPath = path.join(root, "Nodex.app/Contents/Resources");
  writePackagedStockNodeFixture(resourcesPath);
  fs.mkdirSync(path.join(root, ".generated"));
  fs.copyFileSync(
    path.join(resourcesPath, "prepared-electron-build.json"),
    path.join(root, ".generated/prepared-electron-build.json"),
  );
  fs.writeFileSync(path.join(resourcesPath, "codex-package.json"), "{}");

  await expect(
    restorePackagedRuntimeClosure({
      appOutDir: root,
      arch: 3,
      electronPlatformName: "darwin",
      packager: { projectDir: root, appInfo: { productFilename: "Nodex" } },
    } as Parameters<typeof restorePackagedRuntimeClosure>[0]),
  ).rejects.toThrow("must install Codex as a Component");
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(schemaVersion: number = BROWSER_RUNTIME_SCHEMA_VERSION): {
  packagedBrowserRoot: string;
  placeholderPath: string;
  sourceBrowserRoot: string;
  windowsArch: "x64";
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
    targetPlatform: "win32",
    targetArch: "x64",
  };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(path.join(sourceBrowserRoot, "browser-runtime-manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(packagedBrowserRoot, "browser-runtime-manifest.json"), manifestBytes);
  return {
    windowsArch: "x64",
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
      "junction",
    );

    expect(() => restorePackagedBrowserRuntimeClosure(fixture)).toThrow("is not a real directory");
  });
});

test("seals the packaged Windows x64 closure against staged bytes", () => {
  const windowsArch = "x64";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-windows-after-pack-"));
  temporaryRoots.push(root);
  const sourceBrowserRoot = path.join(root, "source");
  const packagedBrowserRoot = path.join(root, "packaged");
  const { entrypoints } = writeWindowsBrowserRuntimeFixture(sourceBrowserRoot, windowsArch);
  fs.cpSync(sourceBrowserRoot, packagedBrowserRoot, { recursive: true });
  const options = { packagedBrowserRoot, sourceBrowserRoot, windowsArch } as const;
  expect(restorePackagedBrowserRuntimeClosure(options)).toBe(0);
  const extraPath = path.join(packagedBrowserRoot, "extra.dll");
  fs.writeFileSync(extraPath, "extra");
  expect(() => restorePackagedBrowserRuntimeClosure(options)).toThrow(
    "Unexpected packaged Windows Desktop Tool entry",
  );
  fs.rmSync(extraPath);
  const packagedNode = path.join(packagedBrowserRoot, entrypoints.node);
  fs.appendFileSync(packagedNode, "modified");
  expect(() => restorePackagedBrowserRuntimeClosure(options)).toThrow(
    "does not match its manifest",
  );
  fs.rmSync(packagedNode);
  expect(() => restorePackagedBrowserRuntimeClosure(options)).toThrow("ENOENT");
  expect(fs.existsSync(packagedNode)).toBe(false);
});
