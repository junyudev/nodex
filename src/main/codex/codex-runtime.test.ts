import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexRuntime } from "./codex-runtime";

function writeRuntime(rootPath: string): void {
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "codex"), "#!/bin/sh\necho codex\n", "utf8");
  fs.writeFileSync(path.join(rootPath, "rg"), "#!/bin/sh\necho rg\n", "utf8");
  fs.writeFileSync(
    path.join(rootPath, "runtime.json"),
    JSON.stringify({
      binarySha256: "binary",
      codexVersion: "0.115.0",
      rgSha256: "rg",
      sourcePackage: "@openai/codex-darwin-arm64@0.115.0-darwin-arm64",
      targetArch: "arm64",
      targetPlatform: "darwin",
      targetTriple: "aarch64-apple-darwin",
    }),
    "utf8",
  );
}

function makeBundledRuntimeFixture(): { cleanup: () => void; resourcesPath: string } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-runtime-"));
  writeRuntime(path.join(resourcesPath, "bin"));

  return {
    resourcesPath,
    cleanup: () => fs.rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

function makeStagedRuntimeFixture(): { cleanup: () => void; projectRootPath: string } {
  const projectRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-project-"));
  writeRuntime(path.join(projectRootPath, ".generated", "codex-runtime", "bin"));

  return {
    projectRootPath,
    cleanup: () => fs.rmSync(projectRootPath, { recursive: true, force: true }),
  };
}

describe("codex-runtime", () => {
  test("resolves the bundled runtime from Electron Resources", () => {
    const fixture = makeBundledRuntimeFixture();

    try {
      const runtime = resolveCodexRuntime({
        isPackaged: true,
        resourcesPath: fixture.resourcesPath,
      });

      expect(runtime.source).toBe("bundled");
      expect(runtime.binaryPath).toBe(path.join(fixture.resourcesPath, "bin", "codex"));
      expect(runtime.additionalSearchPaths[0]).toBe(path.join(fixture.resourcesPath, "bin"));
      expect(runtime.version).toBe("0.115.0");
      expect(runtime.missingBinaryMessage).toBe("Bundled Codex runtime is missing or corrupted. Reinstall Nodex.");
    } finally {
      fixture.cleanup();
    }
  });

  test("throws when the bundled runtime is incomplete", () => {
    const fixture = makeBundledRuntimeFixture();
    let threw = false;

    try {
      fs.rmSync(path.join(fixture.resourcesPath, "bin", "runtime.json"));
      try {
        resolveCodexRuntime({
          isPackaged: true,
          resourcesPath: fixture.resourcesPath,
        });
      } catch {
        threw = true;
      }

      expect(threw).toBeTrue();
    } finally {
      fixture.cleanup();
    }
  });

  test("resolves the staged runtime for unpackaged runs", () => {
    const fixture = makeStagedRuntimeFixture();

    try {
      const runtime = resolveCodexRuntime({
        isPackaged: false,
        projectRootPath: fixture.projectRootPath,
      });

      expect(runtime.source).toBe("staged");
      expect(runtime.binaryPath).toBe(path.join(fixture.projectRootPath, ".generated", "codex-runtime", "bin", "codex"));
      expect(runtime.additionalSearchPaths[0]).toBe(path.join(fixture.projectRootPath, ".generated", "codex-runtime", "bin"));
      expect(runtime.version).toBe("0.115.0");
      expect(runtime.metadataPath).toBe(path.join(fixture.projectRootPath, ".generated", "codex-runtime", "bin", "runtime.json"));
      expect(runtime.missingBinaryMessage).toBe("Pinned Codex runtime is missing or incomplete. Run `bun run stage:codex-runtime:mac`.");
    } finally {
      fixture.cleanup();
    }
  });

  test("throws when the staged runtime is missing", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-project-missing-"));
    let threw = false;

    try {
      try {
        resolveCodexRuntime({
          isPackaged: false,
          projectRootPath: fixture,
        });
      } catch {
        threw = true;
      }

      expect(threw).toBeTrue();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
