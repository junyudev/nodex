import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_PLUGIN_NODE_MODULE_DIR,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  BROWSER_RUNTIME_LEGACY_SKY_NATIVE_EXPORTS,
  BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
  BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  type BrowserRuntimeArtifact,
  type BrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import type {
  AppServerRuntimeIdentity,
  TestedBrowserAppServerPair,
} from "../../shared/browser-app-server-compatibility";

type BrowserRuntimeFixtureOptions = {
  codexCliVersion?: string;
  codexCompatibilityVersion?: string;
  targetArch?: "arm64" | "x64";
  targetPlatform?: "darwin" | "linux" | "win32";
};

const FIXTURE_FILES = [
  { architecture: "arm64", executable: true, kind: "executable", path: "bin/codex" },
  { architecture: "arm64", executable: true, kind: "executable", path: "bin/node" },
  { architecture: "arm64", executable: true, kind: "executable", path: "bin/node_repl" },
  {
    architecture: "arm64",
    executable: false,
    kind: "native-addon",
    path: "peer/authorize.node",
  },
  {
    architecture: "arm64",
    executable: false,
    kind: "native-addon",
    path: "native/sky.node",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "native/remote-hosted-pip/pop-in-window-egg@3x.png",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "native/remote-hosted-pip/pop-out-window-egg@3x.png",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/browser/manifest.json",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/browser/client.js",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/browser/service.js",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/browser/docs/SKILL.md",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/browser/.codex-plugin/plugin.json",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/chrome/scripts/installManifest.mjs",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/chrome/scripts/extension-ids.json",
  },
  {
    architecture: "arm64",
    executable: true,
    kind: "executable",
    path: "marketplace/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/.agents/plugins/marketplace.json",
  },
] as const;

const COMPUTER_USE_FIXTURE_FILES = [
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/manifest.json",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/client.mjs",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/docs/SKILL.md",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/skills/computer-use/SKILL.md",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/.codex-plugin/plugin.json",
  },
  {
    architecture: "any",
    executable: false,
    kind: "data",
    path: "marketplace/plugins/computer-use/.codex-plugin/computer-use-node-repl.md",
  },
  {
    architecture: "arm64",
    executable: true,
    kind: "executable",
    path: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
  },
] as const;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function makeTestedBrowserAppServerPair(input: {
  readonly bundleRoot: string;
  readonly manifest: BrowserRuntimeManifest;
}): TestedBrowserAppServerPair {
  const appServer: AppServerRuntimeIdentity = {
    entrypointSha256: "a".repeat(64),
    protocolSchemaFingerprint: "b".repeat(64),
    runtimeVersion: "0.152.0-test",
    sourceCommit: "c".repeat(40),
    targetArch: input.manifest.targetArch,
    targetPlatform: input.manifest.targetPlatform,
  };
  const manifestBytes = fs.readFileSync(
    path.join(input.bundleRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
  );
  return {
    appServer,
    browser: {
      browserPluginVersion: input.manifest.browserPlugin.version,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      peerCliVersion: input.manifest.runtimeVersions.codexCli,
      targetArch: input.manifest.targetArch,
      targetPlatform: input.manifest.targetPlatform,
    },
  };
}

function fixtureContent(relativePath: string): string {
  if (relativePath === "marketplace/.agents/plugins/marketplace.json") {
    return `${JSON.stringify(
      {
        name: "openai-bundled",
        plugins: [
          {
            name: "browser",
            source: { path: "./plugins/browser", source: "local" },
          },
          {
            name: "computer-use",
            source: { path: "./plugins/computer-use", source: "local" },
          },
          {
            name: "chrome",
            source: { path: "./plugins/chrome", source: "local" },
          },
        ],
      },
      null,
      2,
    )}\n`;
  }
  if (relativePath.endsWith("/.codex-plugin/plugin.json")) {
    const name = relativePath.includes("/computer-use/")
      ? "computer-use"
      : relativePath.includes("/chrome/")
        ? "chrome"
        : "browser";
    return `${JSON.stringify({ name, version: "1.0.0-test" }, null, 2)}\n`;
  }
  if (relativePath.endsWith("/computer-use-node-repl.md")) {
    return "---\nname: computer-use\n---\n\nNode REPL variant\n";
  }
  if (relativePath.endsWith("/computer-use/docs/SKILL.md")) {
    return "---\nname: computer-use\n---\n\nNative MCP variant\n";
  }
  return `fixture:${relativePath}\n`;
}

export function writeBrowserRuntimeFixture(
  bundleRoot: string,
  options: BrowserRuntimeFixtureOptions = {},
): BrowserRuntimeManifest {
  const targetArch = options.targetArch ?? "arm64";
  const definitions =
    targetArch === "arm64" ? [...FIXTURE_FILES, ...COMPUTER_USE_FIXTURE_FILES] : FIXTURE_FILES;
  const artifacts: BrowserRuntimeArtifact[] = definitions.map((definition) => {
    const relativePath = definition.path.replace(
      "extension-host/macos/arm64/",
      `extension-host/macos/${targetArch}/`,
    );
    const content = fixtureContent(relativePath);
    const artifactPath = path.join(bundleRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);
    if (definition.executable) fs.chmodSync(artifactPath, 0o755);
    return {
      ...definition,
      architecture: definition.architecture === "arm64" ? targetArch : definition.architecture,
      path: relativePath,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
    };
  });
  fs.mkdirSync(path.join(bundleRoot, ...BROWSER_PLUGIN_NODE_MODULE_DIR.split("/")), {
    recursive: true,
  });
  if (targetArch === "arm64") {
    fs.mkdirSync(path.join(bundleRoot, "marketplace", "plugins", "computer-use", "node_modules"), {
      recursive: true,
    });
  }

  const manifest = {
    artifacts,
    browserPlugin: {
      client: "marketplace/plugins/browser/client.js",
      docs: "marketplace/plugins/browser/docs/SKILL.md",
      id: "browser@openai-bundled",
      manifest: "marketplace/plugins/browser/manifest.json",
      marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
      marketplaceRoot: "marketplace",
      nodeModuleDirs: [BROWSER_PLUGIN_NODE_MODULE_DIR],
      root: "marketplace/plugins/browser",
      service: "marketplace/plugins/browser/service.js",
      version: "1.0.0-test",
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
              path: `marketplace/plugins/chrome/extension-host/macos/${targetArch}/ChatGPT for Chrome`,
              productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
              signingTeamId: "TESTTEAM",
            },
            plugin: {
              id: "chrome@openai-bundled",
              manifest: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
              root: "marketplace/plugins/chrome",
              version: "1.0.0-test",
            },
            status: "available",
          },
          iab: { status: "available" },
        },
      },
      computerUse:
        targetArch === "arm64"
          ? {
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
                version: "1.0.0-test",
              },
              productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
              rpcService:
                "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
              serviceExecutable:
                "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
              signingTeamId: "TESTTEAM",
              status: "available",
            }
          : { reason: "architecture-unsupported", status: "unavailable" },
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
    codexCompatibilityVersion: options.codexCompatibilityVersion ?? "0.144.6",
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
      codexCli: options.codexCliVersion ?? "0.144.6",
      cuaRuntime: "0.0.6/test",
      node: "24.0.0",
      peerAuthorization: "test",
    },
    schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
    supportedBackends: ["iab", "chrome"],
    targetArch,
    targetPlatform: options.targetPlatform ?? "darwin",
  } satisfies BrowserRuntimeManifest;
  fs.writeFileSync(
    path.join(bundleRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
