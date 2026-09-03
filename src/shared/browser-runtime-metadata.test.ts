import { describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS,
  BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
  BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  parseBrowserRuntimeManifest,
  type BrowserRuntimeManifest,
} from "./browser-runtime-metadata";

const HASH = "a".repeat(64);

function makeManifest(): BrowserRuntimeManifest {
  return {
    artifacts: [
      {
        architecture: "arm64",
        executable: true,
        kind: "executable",
        path: "bin/codex",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: true,
        kind: "executable",
        path: "bin/node",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: true,
        kind: "executable",
        path: "bin/node_repl",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: false,
        kind: "native-addon",
        path: "peer/authorize.node",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: false,
        kind: "native-addon",
        path: "native/sky.node",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "native/remote-hosted-pip/pop-in-window-egg@3x.png",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "native/remote-hosted-pip/pop-out-window-egg@3x.png",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/browser/manifest.json",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/browser/client.js",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/browser/service.js",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/browser/docs/SKILL.md",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/.agents/plugins/marketplace.json",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/chrome/scripts/installManifest.mjs",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/chrome/scripts/extension-ids.json",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: true,
        kind: "executable",
        path: "marketplace/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/computer-use/manifest.json",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/computer-use/client.mjs",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "any",
        executable: false,
        kind: "data",
        path: "marketplace/plugins/computer-use/docs/SKILL.md",
        sha256: HASH,
        size: 1,
      },
      {
        architecture: "arm64",
        executable: true,
        kind: "executable",
        path: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        sha256: HASH,
        size: 1,
      },
    ],
    browserPlugin: {
      client: "marketplace/plugins/browser/client.js",
      docs: "marketplace/plugins/browser/docs/SKILL.md",
      id: "browser@openai-bundled",
      manifest: "marketplace/plugins/browser/manifest.json",
      marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
      marketplaceRoot: "marketplace",
      nodeModuleDirs: ["runtime/lib/node_modules"],
      root: "marketplace/plugins/browser",
      service: "marketplace/plugins/browser/service.js",
      version: "1.0.0",
    },
    buildFlavor: "test",
    capabilities: {
      browserUse: {
        backends: {
          chrome: {
            extensionIds: ["hehggadaopoacecdllhhajmbjkdcmajg", "odlomjlbamekndcpllcnffbgeohgkmjh"],
            familyDescriptor: "marketplace/plugins/chrome/scripts/extension-ids.json",
            installManifest: "marketplace/plugins/chrome/scripts/installManifest.mjs",
            nativeHost: {
              artifactMinimumMacOSVersion: "13.0",
              hostName: "com.openai.codexextension",
              path: "marketplace/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
              productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
              signingTeamId: "TESTTEAM",
            },
            plugin: {
              id: "chrome@openai-bundled",
              manifest: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
              root: "marketplace/plugins/chrome",
              version: "1.0.0",
            },
            status: "available",
          },
          iab: { status: "available" },
        },
      },
      computerUse: {
        appBundle: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app",
        appBundleIdentifier: "com.openai.CodexComputerUse",
        artifactMinimumMacOSVersion: "14.4",
        client: "marketplace/plugins/computer-use/client.mjs",
        ipcProtocol: "CodexComputerUseIPC-5",
        plugin: {
          docs: "marketplace/plugins/computer-use/docs/SKILL.md",
          id: "computer-use@openai-bundled",
          manifest: "marketplace/plugins/computer-use/manifest.json",
          marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
          marketplaceRoot: "marketplace",
          nodeModuleDirs: ["runtime/lib/node_modules"],
          root: "marketplace/plugins/computer-use",
          version: "1.0.1000550",
        },
        productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
        rpcService: "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
        serviceExecutable:
          "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        signingTeamId: "TESTTEAM",
        status: "available",
      },
      nativePip: {
        addon: "native/sky.node",
        artifactMinimumMacOSVersion: "13.0",
        controlAssets: [
          "native/remote-hosted-pip/pop-in-window-egg@3x.png",
          "native/remote-hosted-pip/pop-out-window-egg@3x.png",
        ],
        exports: {
          expectedExportCount: BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS.length,
          expectedExports: [...BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS],
          groups: BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
        },
        productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
        status: "available",
      },
    },
    codexCompatibilityVersion: "0.144.6",
    desktopBuild: "test-build",
    desktopBuildNumber: "123",
    entrypoints: {
      codexCli: "bin/codex",
      node: "bin/node",
      nodeRepl: "bin/node_repl",
      peerAuthorization: "peer/authorize.node",
    },
    peerAuthorization: {
      nodeApiVersion: "127",
      signingTeamId: "TESTTEAM",
    },
    runtimeVersions: {
      codexCli: "0.144.6",
      cuaRuntime: "0.0.6/test",
      node: "24.0.0",
      peerAuthorization: "test",
    },
    schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
    supportedBackends: ["iab", "chrome"],
    targetArch: "arm64",
    targetPlatform: "darwin",
  };
}

describe("parseBrowserRuntimeManifest", () => {
  test("accepts a complete architecture-bound runtime contract", () => {
    expect(parseBrowserRuntimeManifest(makeManifest())).toEqual(makeManifest());
  });

  test("accepts an executable Computer Use launcher entrypoint", () => {
    const manifest = makeManifest();
    if (manifest.capabilities.computerUse.status !== "available") {
      throw new Error("Computer Use fixture is unavailable");
    }
    const computerUse = manifest.capabilities.computerUse;
    const client = manifest.artifacts.find((artifact) => artifact.path === computerUse.client);
    if (!client) throw new Error("Computer Use fixture client is missing");
    client.kind = "executable";
    client.executable = true;

    expect(parseBrowserRuntimeManifest(manifest)).toEqual(manifest);
  });

  test("upgrades archived schema-v5 metadata to the verified schema-v6 contract", () => {
    const current = makeManifest();
    const computerUse = current.capabilities.computerUse;
    if (computerUse.status !== "available") throw new Error("Computer Use fixture is unavailable");
    const legacy = {
      ...current,
      capabilities: {
        computerUse: {
          ...computerUse,
          artifactMinimumMacOSVersion: undefined,
          ipcProtocol: "CodexComputerUseIPC-2",
          minimumMacOSVersion: "14.4",
          productMinimumMacOSVersion: undefined,
        },
        nativePip: {
          addon: current.capabilities.nativePip.addon,
          controlAssets: current.capabilities.nativePip.controlAssets,
          minimumMacOSVersion: "13.0",
        },
      },
      schemaVersion: 5,
      supportedBackends: ["iab"],
    };

    const parsed = parseBrowserRuntimeManifest(legacy);
    expect(parsed?.schemaVersion).toBe(6);
    expect(parsed?.capabilities.computerUse).toMatchObject({
      artifactMinimumMacOSVersion: "14.4",
      ipcProtocol: "CodexComputerUseIPC-5",
      productMinimumMacOSVersion: "15.0",
    });
    expect(parsed?.capabilities.nativePip.exports.expectedExportCount).toBe(38);
    expect(parsed?.capabilities.nativePip.exports.expectedExports).toEqual(
      BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS,
    );
  });

  test("rejects a native add-on contract without its exact export set", () => {
    const manifest = structuredClone(makeManifest()) as unknown as {
      capabilities: { nativePip: { exports: { expectedExports?: string[] } } };
    };
    delete manifest.capabilities.nativePip.exports.expectedExports;

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects a native add-on contract whose count or order differs from the exact set", () => {
    const wrongCount = structuredClone(makeManifest());
    wrongCount.capabilities.nativePip.exports.expectedExportCount += 1;
    expect(parseBrowserRuntimeManifest(wrongCount)).toBeNull();

    const wrongOrder = structuredClone(makeManifest());
    wrongOrder.capabilities.nativePip.exports.expectedExports.reverse();
    expect(parseBrowserRuntimeManifest(wrongOrder)).toBeNull();
  });

  test("rejects a native add-on contract with an incomplete capability group", () => {
    const manifest = structuredClone(makeManifest());
    (
      manifest.capabilities.nativePip.exports.groups as unknown as { presentation: string[] }
    ).presentation = [];

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects paths that escape the bundle root", () => {
    const manifest = makeManifest();
    manifest.browserPlugin.client = "../client.js";

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects plugin entrypoints missing from the artifact closure", () => {
    const manifest = makeManifest();
    manifest.artifacts = manifest.artifacts.filter(
      (artifact) => artifact.path !== manifest.browserPlugin.client,
    );

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects binary entrypoints built for another architecture", () => {
    const manifest = makeManifest();
    manifest.artifacts[0] = { ...manifest.artifacts[0]!, architecture: "x64" };

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects trust-all backend declarations and duplicate backends", () => {
    const manifest = makeManifest() as unknown as Record<string, unknown>;
    manifest.supportedBackends = ["iab", "iab"];

    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });
});
