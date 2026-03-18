import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexRuntimeTarget, stageCodexRuntime } from "./stage-codex-runtime";

function makeFakeCodexPackage(targetTriple: string, version: string): { cleanup: () => void; packageRoot: string } {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-stage-codex-runtime-"));
  const vendorRoot = path.join(packageRoot, "vendor", targetTriple);

  fs.mkdirSync(path.join(vendorRoot, "codex"), { recursive: true });
  fs.mkdirSync(path.join(vendorRoot, "path"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version }), "utf8");
  fs.writeFileSync(path.join(vendorRoot, "codex", "codex"), "#!/bin/sh\necho codex\n", "utf8");
  fs.writeFileSync(path.join(vendorRoot, "path", "rg"), "#!/bin/sh\necho rg\n", "utf8");

  return {
    packageRoot,
    cleanup: () => fs.rmSync(packageRoot, { recursive: true, force: true }),
  };
}

describe("stage-codex-runtime", () => {
  test("resolves the pinned darwin target metadata", () => {
    const target = resolveCodexRuntimeTarget("darwin", "arm64");

    expect(target.packageName).toBe("@openai/codex-darwin-arm64");
    expect(target.targetTriple).toBe("aarch64-apple-darwin");
  });

  test("stages codex, rg, and runtime metadata while replacing stale output", () => {
    const fakePackage = makeFakeCodexPackage("aarch64-apple-darwin", "0.115.0-darwin-arm64");
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-stage-codex-runtime-out-"));
    const outputPath = path.join(outputRoot, "codex-runtime");

    try {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.writeFileSync(path.join(outputPath, "stale.txt"), "stale", "utf8");

      const metadata = stageCodexRuntime({
        targetPlatform: "darwin",
        targetArch: "arm64",
        outputPath,
        packageRoot: fakePackage.packageRoot,
      });

      expect(metadata.codexVersion).toBe("0.115.0");
      expect(metadata.targetTriple).toBe("aarch64-apple-darwin");
      expect(fs.existsSync(path.join(outputPath, "bin", "codex"))).toBeTrue();
      expect(fs.existsSync(path.join(outputPath, "bin", "rg"))).toBeTrue();
      expect(fs.existsSync(path.join(outputPath, "bin", "runtime.json"))).toBeTrue();
      expect(fs.existsSync(path.join(outputPath, "stale.txt"))).toBeFalse();

      const writtenMetadata = JSON.parse(
        fs.readFileSync(path.join(outputPath, "bin", "runtime.json"), "utf8"),
      ) as { sourcePackage?: string; binarySha256?: string; rgSha256?: string };

      expect(writtenMetadata.sourcePackage).toBe("@openai/codex-darwin-arm64@0.115.0-darwin-arm64");
      expect(typeof writtenMetadata.binarySha256 === "string" && writtenMetadata.binarySha256.length > 0).toBeTrue();
      expect(typeof writtenMetadata.rgSha256 === "string" && writtenMetadata.rgSha256.length > 0).toBeTrue();
    } finally {
      fakePackage.cleanup();
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
