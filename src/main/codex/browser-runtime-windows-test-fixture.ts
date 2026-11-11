import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  type WindowsBrowserRuntimeArch,
  type WindowsBrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import { WINDOWS_PE_MACHINE } from "../../shared/windows-pe-header.mjs";
import type { WindowsBrowserRuntimeVerifierPort } from "./browser-runtime-windows-verifier-port";

export const FIXTURE_PUBLISHER = {
  subject: "CN=OpenAI OpCo\\, LLC,O=OpenAI OpCo\\, LLC,L=San Francisco,ST=California,C=US",
  issuer: "CN=Microsoft ID Verified CS AOC CA 04,O=Microsoft Corporation,C=US",
};

export function fixtureWindowsPe(
  arch: WindowsBrowserRuntimeArch,
  certificate: Buffer | null = Buffer.from("fixture"),
): Buffer {
  const bytes = Buffer.alloc(0x200 + (certificate ? 8 + certificate.length : 0));
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x40);
  bytes.writeUInt16LE(WINDOWS_PE_MACHINE[arch], 0x44);
  bytes.writeUInt16LE(0xf0, 0x54);
  bytes.writeUInt16LE(0x20b, 0x58);
  bytes.writeUInt32LE(16, 0x58 + 108);
  if (certificate) {
    bytes.writeUInt32LE(0x200, 0x58 + 112 + 32);
    bytes.writeUInt32LE(certificate.length + 8, 0x58 + 112 + 36);
    bytes.writeUInt32LE(certificate.length + 8, 0x200);
    bytes.writeUInt16LE(0x200, 0x204);
    bytes.writeUInt16LE(2, 0x206);
    certificate.copy(bytes, 0x208);
  }
  return bytes;
}

export function writeWindowsBrowserRuntimeFixture(root: string, arch: WindowsBrowserRuntimeArch) {
  const browser = "marketplace/plugins/browser";
  const chrome = "marketplace/plugins/chrome";
  const computerUse = "marketplace/plugins/computer-use";
  const marketplaceManifest = "marketplace/.agents/plugins/marketplace.json";
  const nodeModules = "runtime/bin/node_modules";
  const manifest: WindowsBrowserRuntimeManifest = {
    artifacts: [],
    browserPlugin: {
      client: `${browser}/client.js`,
      docs: `${browser}/SKILL.md`,
      id: "browser@openai-bundled",
      manifest: `${browser}/plugin.json`,
      marketplaceManifest,
      marketplaceRoot: "marketplace",
      nodeModuleDirs: [nodeModules],
      root: browser,
      service: `${browser}/service.js`,
      version: "1.0.0",
    },
    capabilities: {
      browserUse: {
        backends: {
          iab: { status: "available" },
          chrome: {
            status: "available",
            extensionIds: ["a".repeat(32)],
            familyDescriptor: `${chrome}/ids.json`,
            installManifest: `${chrome}/install.mjs`,
            nativeHost: { hostName: "com.openai.codexextension", path: `${chrome}/host.exe` },
            plugin: {
              id: "chrome@openai-bundled",
              root: chrome,
              version: "1.0.0",
              manifest: `${chrome}/plugin.json`,
            },
          },
        },
      },
      computerUse: {
        status: "available",
        serviceExecutable: "bin/service.exe",
        captureExecutable: "bin/capture.exe",
        plugin: {
          docs: `${computerUse}/SKILL.md`,
          id: "computer-use@openai-bundled",
          manifest: `${computerUse}/plugin.json`,
          marketplaceManifest,
          marketplaceRoot: "marketplace",
          nodeModuleDirs: [nodeModules],
          root: computerUse,
          version: "1.0.0",
        },
      },
    },
    buildFlavor: "production",
    codexCompatibilityVersion: "1.0.0",
    desktopBuild: "1.0.0",
    desktopBuildNumber: "1.0.0.0",
    entrypoints: {
      codexCli: "bin/codex.exe",
      node: "bin/node.exe",
      nodeRepl: "bin/node_repl.exe",
      processEnumeration: "native/windows-account.node",
    },
    runtimeVersions: { codexCli: "1.0.0", cuaRuntime: "1.0.0/test", node: "24.0.0" },
    schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
    sourcePackage: { name: "OpenAI.Codex", publisher: "CN=Example", version: "1.0.0.0" },
    supportedBackends: ["iab", "chrome"],
    targetArch: arch,
    targetPlatform: "win32",
    trust: { pe: {} },
  };
  const files = [
    ...Object.values(manifest.entrypoints),
    "bin/service.exe",
    "bin/capture.exe",
    "bin/dependency.dll",
    `${chrome}/host.exe`,
    `${chrome}/ids.json`,
    `${chrome}/install.mjs`,
    `${chrome}/plugin.json`,
    `${computerUse}/plugin.json`,
    `${computerUse}/SKILL.md`,
    ...[`client.js`, `SKILL.md`, `plugin.json`, `service.js`].map((name) => `${browser}/${name}`),
    marketplaceManifest,
    `${nodeModules}/module.js`,
  ];
  for (const relative of files) {
    const ext = path.extname(relative);
    const kind =
      ext === ".exe"
        ? "executable"
        : ext === ".node"
          ? "native-addon"
          : ext === ".dll"
            ? "library"
            : "data";
    const bytes = kind === "data" ? Buffer.from(relative) : fixtureWindowsPe(arch);
    if (kind !== "data")
      manifest.trust.pe[relative] = { machine: arch, publisher: FIXTURE_PUBLISHER };
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    manifest.artifacts.push({
      architecture: kind === "data" ? "any" : arch,
      executable: kind === "executable",
      kind,
      path: relative,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  fs.writeFileSync(path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME), JSON.stringify(manifest));
  return manifest;
}

export function fixtureWindowsVerifier(
  overrides: Partial<WindowsBrowserRuntimeVerifierPort> = {},
): WindowsBrowserRuntimeVerifierPort {
  return {
    async verifyClosurePaths() {
      return { ok: true, value: undefined };
    },
    async verifyAuthenticode() {
      return { ok: true, value: FIXTURE_PUBLISHER };
    },
    ...overrides,
  };
}
