import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexRuntime } from "./codex-runtime";

function makeBundledRuntimeFixture(): { cleanup: () => void; resourcesPath: string } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-runtime-"));
  const codexRoot = path.join(resourcesPath, "codex");

  fs.mkdirSync(path.join(codexRoot, "path"), { recursive: true });
  fs.writeFileSync(path.join(codexRoot, "codex"), "#!/bin/sh\necho codex\n", "utf8");
  fs.writeFileSync(path.join(codexRoot, "path", "rg"), "#!/bin/sh\necho rg\n", "utf8");
  fs.writeFileSync(
    path.join(codexRoot, "runtime.json"),
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

  return {
    resourcesPath,
    cleanup: () => fs.rmSync(resourcesPath, { recursive: true, force: true }),
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
      expect(runtime.binaryPath).toBe(path.join(fixture.resourcesPath, "codex", "codex"));
      expect(runtime.additionalSearchPaths[0]).toBe(path.join(fixture.resourcesPath, "codex", "path"));
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
      fs.rmSync(path.join(fixture.resourcesPath, "codex", "runtime.json"));
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

  test("falls back to the system codex binary for unpackaged runs", () => {
    const runtime = resolveCodexRuntime({
      isPackaged: false,
    });

    expect(runtime.source).toBe("system");
    expect(runtime.binaryPath).toBe("codex");
    expect(runtime.additionalSearchPaths.length).toBe(0);
    expect(runtime.metadataPath).toBe(null);
  });
});
