import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BROWSER_RUNTIME_BUNDLE_DIRECTORY } from "../../shared/browser-runtime-metadata";
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import {
  makeTestedBrowserAppServerPair,
  writeBrowserRuntimeFixture,
} from "./browser-runtime-test-fixture";
import { materializeBundledDesktopToolMarketplace } from "./bundled-desktop-tool-marketplace";

const temporaryRoots: string[] = [];

function makeRuntime(targetArch: "arm64" | "x64" = "arm64") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-desktop-tools-"));
  temporaryRoots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeBrowserRuntimeFixture(bundleRoot, {
    targetArch,
  });
  const testedPair = makeTestedBrowserAppServerPair({ bundleRoot, manifest });
  const runtime = resolveBrowserRuntimeBundle({
    appServerIdentity: testedPair.appServer,
    runtimeRoot,
    targetArch,
    targetPlatform: "darwin",
    testedPairs: [testedPair],
  });
  if (runtime.status !== "available") throw new Error(runtime.message);
  return { bundle: runtime.bundle, runtimeStateHome: path.join(root, "state") };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("materializeBundledDesktopToolMarketplace", () => {
  test("atomically materializes Browser and the Computer Use Node REPL variant", async () => {
    const fixture = makeRuntime();
    const sourceSkill = path.join(
      fixture.bundle.paths.computerUsePluginRoot!,
      "skills",
      "computer-use",
      "SKILL.md",
    );
    const sourceManifest = path.join(
      fixture.bundle.paths.computerUsePluginRoot!,
      ".codex-plugin",
      "plugin.json",
    );
    const originalSkill = fs.readFileSync(sourceSkill, "utf8");
    const originalManifest = fs.readFileSync(sourceManifest, "utf8");

    const result = await materializeBundledDesktopToolMarketplace({
      bundle: fixture.bundle,
      includeComputerUse: true,
      runtimeStateHome: fixture.runtimeStateHome,
    });

    expect(result.rootPath).toBe(
      path.join(fixture.runtimeStateHome, ".tmp", "bundled-marketplaces", "openai-bundled"),
    );
    expect(
      fs.readFileSync(
        path.join(result.computerUsePluginRoot!, "skills", "computer-use", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Node REPL variant");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.computerUsePluginRoot!, ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ bundledContentVariant: "node-repl" });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.rootPath, ".agents", "plugins", "marketplace.json"),
          "utf8",
        ),
      ).plugins.map((plugin: { name: string }) => plugin.name),
    ).toEqual(["browser", "computer-use"]);
    expect(fs.readFileSync(sourceSkill, "utf8")).toBe(originalSkill);
    expect(fs.readFileSync(sourceManifest, "utf8")).toBe(originalManifest);
  });

  test("reuses a valid materialization without replacing local plugin files", async () => {
    const fixture = makeRuntime();
    const first = await materializeBundledDesktopToolMarketplace({
      bundle: fixture.bundle,
      includeComputerUse: true,
      runtimeStateHome: fixture.runtimeStateHome,
    });
    const marker = path.join(first.browserPluginRoot, "reuse-marker");
    fs.writeFileSync(marker, "preserved");

    const second = await materializeBundledDesktopToolMarketplace({
      bundle: fixture.bundle,
      includeComputerUse: true,
      runtimeStateHome: fixture.runtimeStateHome,
    });

    expect(second).toEqual(first);
    expect(fs.readFileSync(marker, "utf8")).toBe("preserved");
  });

  test("omits Computer Use when the architecture capability is unavailable", async () => {
    const fixture = makeRuntime("x64");
    const result = await materializeBundledDesktopToolMarketplace({
      bundle: fixture.bundle,
      includeComputerUse: true,
      runtimeStateHome: fixture.runtimeStateHome,
    });

    expect(result.computerUsePluginRoot).toBeNull();
    expect(fs.existsSync(path.join(result.rootPath, "plugins", "computer-use"))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.rootPath, ".agents", "plugins", "marketplace.json"),
          "utf8",
        ),
      ).plugins.map((plugin: { name: string }) => plugin.name),
    ).toEqual(["browser"]);
  });
});
