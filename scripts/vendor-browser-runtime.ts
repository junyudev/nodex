import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_PLUGIN_NODE_MODULE_DIR,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
  BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
  BROWSER_RUNTIME_SCHEMA_VERSION,
  parseBrowserRuntimeManifest,
  type BrowserRuntimeArtifact,
  type BrowserRuntimeManifest,
} from "../src/shared/browser-runtime-metadata";
import { parseMachOMinimumMacosVersion } from "../src/shared/mach-o-minimum-macos";
import { replaceOwnedDirectory } from "./replace-owned-directory";

const EXECUTABLE_MODE = 0o755;
const DIRECTORY_MODE = 0o755;
const REGULAR_MODE = 0o644;
const PLUGIN_NAME = "browser";

export function browserPluginNodeModuleDirs(): string[] {
  return ["runtime/lib/node_modules", BROWSER_PLUGIN_NODE_MODULE_DIR];
}

type VendorBrowserRuntimeOptions = {
  appPath: string;
  codexCompatibilityVersion: string;
  outputPath: string;
  reuseExisting?: boolean;
  targetArch: "arm64" | "x64";
};

function readSha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readPlistValue(plistPath: string, key: string): string {
  return readCommand("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
}

function readJsonFile(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object in ${filePath}`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value.trim();
}

export function readCuaRuntimeVersion(manifest: Record<string, unknown>): string {
  return readNonEmptyString(manifest.runtime_archive_version, "CUA runtime version");
}

function readExecutableVersion(filePath: string): string {
  const output = readCommand(filePath, ["--version"]);
  return output.replace(/^codex-cli\s+/u, "").replace(/^v/u, "");
}

function readNodeApiVersion(nodePath: string): string {
  return readNonEmptyString(
    readCommand(nodePath, ["-p", "process.versions.napi"]),
    "embedded Node-API version",
  );
}

function readArchitectures(filePath: string): string[] {
  const output = readCommand("/usr/bin/lipo", ["-archs", filePath]);
  return output.split(/\s+/u).filter(Boolean);
}

type CommandReader = (command: string, args: string[]) => string;

/** Records the selected architecture's actual deployment target instead of release folklore. */
export function readMachOMinimumMacosVersion(
  filePath: string,
  targetArch: "arm64" | "x64",
  run: CommandReader = readCommand,
): string {
  const architecture = targetArch === "x64" ? "x86_64" : "arm64";
  const minimum = parseMachOMinimumMacosVersion(
    run("/usr/bin/otool", ["-arch", architecture, "-l", filePath]),
  );
  if (!minimum) {
    throw new Error(`Could not inspect Browser runtime minimum macOS version: ${filePath}`);
  }
  return minimum;
}

function assertArchitecture(filePath: string, targetArch: "arm64" | "x64"): void {
  const expected = targetArch === "x64" ? "x86_64" : "arm64";
  const architectures = readArchitectures(filePath);
  if (!architectures.includes(expected)) {
    throw new Error(
      `Browser runtime artifact ${filePath} does not include ${expected} (${architectures.join(", ")})`,
    );
  }
}

function readSigningTeamId(filePath: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-dvv", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/^TeamIdentifier=(.+)$/mu);
  if (!match?.[1]?.trim()) {
    throw new Error(`Browser runtime artifact has no signing Team ID: ${filePath}`);
  }
  return match[1].trim();
}

function copyResolvedEntry(
  sourcePath: string,
  destinationPath: string,
  activeRealPaths: Set<string>,
): void {
  const realSourcePath = fs.realpathSync(sourcePath);
  if (activeRealPaths.has(realSourcePath)) {
    throw new Error(`Browser runtime source contains a symlink cycle: ${sourcePath}`);
  }
  const stats = fs.statSync(realSourcePath);
  if (stats.isDirectory()) {
    activeRealPaths.add(realSourcePath);
    fs.mkdirSync(destinationPath, { recursive: true, mode: DIRECTORY_MODE });
    for (const entry of fs.readdirSync(realSourcePath, { withFileTypes: true })) {
      copyResolvedEntry(
        path.join(realSourcePath, entry.name),
        path.join(destinationPath, entry.name),
        activeRealPaths,
      );
    }
    activeRealPaths.delete(realSourcePath);
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`Unsupported Browser runtime source entry: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(realSourcePath, destinationPath);
  fs.chmodSync(destinationPath, (stats.mode & 0o111) !== 0 ? EXECUTABLE_MODE : REGULAR_MODE);
}

function copyTree(sourcePath: string, destinationPath: string): void {
  copyResolvedEntry(sourcePath, destinationPath, new Set());
}

function classifyArtifact(
  filePath: string,
  relativePath: string,
  stats: fs.Stats,
  targetArch: "arm64" | "x64",
): Pick<BrowserRuntimeArtifact, "architecture" | "executable" | "kind"> {
  if (relativePath.endsWith(".node") || relativePath.endsWith(".dylib")) {
    if (!isMachO(filePath)) {
      throw new Error(`Browser runtime native artifact is not Mach-O: ${relativePath}`);
    }
    const architectures = readArchitectures(filePath);
    const expected = targetArch === "x64" ? "x86_64" : "arm64";
    const architecture =
      architectures.includes("arm64") && architectures.includes("x86_64")
        ? "universal"
        : targetArch;
    if (!architectures.includes(expected)) {
      throw new Error(
        `Browser runtime native artifact ${relativePath} does not include ${expected}`,
      );
    }
    return {
      architecture,
      executable: false,
      kind: "native-addon",
    };
  }
  if ((stats.mode & 0o111) !== 0) {
    let architecture: BrowserRuntimeArtifact["architecture"] = "any";
    if (isMachO(filePath)) {
      const architectures = readArchitectures(filePath);
      const expected = targetArch === "x64" ? "x86_64" : "arm64";
      if (!architectures.includes(expected)) {
        throw new Error(`Browser runtime executable ${relativePath} does not include ${expected}`);
      }
      architecture =
        architectures.includes("arm64") && architectures.includes("x86_64")
          ? "universal"
          : targetArch;
    }
    return { architecture, executable: true, kind: "executable" };
  }
  return { architecture: "any", executable: false, kind: "data" };
}

function listArtifacts(
  rootPath: string,
  targetArch: "arm64" | "x64",
  currentPath = rootPath,
): BrowserRuntimeArtifact[] {
  const artifacts: BrowserRuntimeArtifact[] = [];
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.name === BROWSER_RUNTIME_MANIFEST_FILENAME && currentPath === rootPath) continue;
    if (entry.isDirectory()) {
      artifacts.push(...listArtifacts(rootPath, targetArch, entryPath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Prepared Browser runtime contains an unsupported entry: ${entryPath}`);
    }
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join("/");
    let stats = fs.statSync(entryPath);
    const classification = classifyArtifact(entryPath, relativePath, stats, targetArch);
    if (classification.kind === "native-addon" && (stats.mode & 0o111) !== 0) {
      fs.chmodSync(entryPath, REGULAR_MODE);
      stats = fs.statSync(entryPath);
    }
    artifacts.push({
      ...classification,
      path: relativePath,
      sha256: readSha256(entryPath),
      size: stats.size,
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function writeBrowserMarketplaceManifest(
  destinationPath: string,
  includeComputerUse: boolean,
): void {
  const manifest = {
    name: "openai-bundled",
    interface: {
      displayName: "OpenAI Bundled",
    },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: {
          source: "local",
          path: "./plugins/browser",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Engineering",
      },
      {
        name: "chrome",
        source: {
          source: "local",
          path: "./plugins/chrome",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
      ...(includeComputerUse
        ? [
            {
              name: "computer-use",
              source: {
                source: "local",
                path: "./plugins/computer-use",
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ]
        : []),
    ],
  };
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: REGULAR_MODE,
  });
}

function assertPeerAddonLoads(nodePath: string, addonPath: string): void {
  readCommand(nodePath, [
    "-e",
    "const addon=require(process.argv[1]);" +
      "if(typeof addon.authorizeSocketPeer!=='function')process.exit(2)",
    addonPath,
  ]);
}

/**
 * Loads sky.node with the bundled Node that will consume it in production and records the
 * complete enumerable function ABI. Capability groups remain the semantic minimum, while this
 * exact set prevents a different native build from being accepted under the same manifest.
 */
export function readSkyNativeExports(nodePath: string, addonPath: string): string[] {
  const output = readCommand(nodePath, [
    "-e",
    "const addon=require(process.argv[1]);" +
      "if(typeof addon!=='object'||addon===null)process.exit(2);" +
      "const names=Object.keys(addon).sort();" +
      "if(names.length===0||names.some((name)=>typeof addon[name]!=='function'))process.exit(3);" +
      "process.stdout.write(JSON.stringify(names));",
    addonPath,
  ]);
  const value = JSON.parse(output) as unknown;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry, index) =>
        typeof entry !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(entry) ||
        (index > 0 && entry <= value[index - 1]!),
    )
  ) {
    throw new Error("sky.node returned an invalid export contract");
  }
  const exports = value as string[];
  const missingRequiredExports = Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS)
    .flat()
    .filter((exportName) => !exports.includes(exportName));
  if (missingRequiredExports.length > 0) {
    throw new Error(`sky.node is missing required exports: ${missingRequiredExports.join(", ")}`);
  }
  return exports;
}

function isMachO(filePath: string): boolean {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    const magic = header.readUInt32BE(0);
    return (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      magic === 0xcafebabf ||
      magic === 0xbfbafeca
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function pruneForeignNativeArtifacts(
  rootPath: string,
  targetArch: "arm64" | "x64",
  currentPath = rootPath,
): void {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      pruneForeignNativeArtifacts(rootPath, targetArch, entryPath);
      continue;
    }
    if (!entry.isFile() || (!entry.name.endsWith(".node") && !entry.name.endsWith(".dylib"))) {
      continue;
    }
    const expected = targetArch === "x64" ? "x86_64" : "arm64";
    if (!isMachO(entryPath) || !readArchitectures(entryPath).includes(expected)) {
      fs.rmSync(entryPath);
    }
  }
}

export function vendorBrowserRuntime(options: VendorBrowserRuntimeOptions): BrowserRuntimeManifest {
  if (process.platform !== "darwin") {
    throw new Error("Preparing the macOS Browser runtime requires macOS");
  }
  const appPath = path.resolve(options.appPath);
  const appStats = fs.lstatSync(appPath);
  if (!appStats.isDirectory() || appStats.isSymbolicLink()) {
    throw new Error(`Browser runtime app source is invalid: ${appPath}`);
  }

  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const codexPath = path.join(resourcesPath, "codex");
  const cuaRoot = path.join(resourcesPath, "cua_node");
  const nodePath = path.join(cuaRoot, "bin", "node");
  const nodeReplPath = path.join(cuaRoot, "bin", "node_repl");
  const peerAddonPath = path.join(resourcesPath, "native", "browser-use-peer-authorization.node");
  const skyAddonPath = path.join(resourcesPath, "native", "sky.node");
  const remoteHostedPipAssetsPath = path.join(resourcesPath, "native", "remote-hosted-pip");
  const pluginRoot = path.join(resourcesPath, "plugins", "openai-bundled", "plugins", PLUGIN_NAME);
  const chromePluginRoot = path.join(
    resourcesPath,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
  );
  const chromeNativeHostRelativePath = path.join(
    "extension-host",
    "macos",
    options.targetArch,
    "ChatGPT for Chrome",
  );
  const chromeNativeHostPath = path.join(chromePluginRoot, chromeNativeHostRelativePath);
  const computerUsePluginRoot = path.join(
    resourcesPath,
    "plugins",
    "openai-bundled",
    "plugins",
    "computer-use",
  );
  const computerUseAvailable =
    options.targetArch === "arm64" && fs.existsSync(computerUsePluginRoot);
  const computerUseClientRelativePath = "bin/computer-use-client-launcher";
  const computerUseAppPath = path.join(
    cuaRoot,
    "lib",
    "node_modules",
    "@oai",
    "sky",
    "Codex Computer Use.app",
  );
  const computerUseServicePath = path.join(
    computerUseAppPath,
    "Contents",
    "MacOS",
    "SkyComputerUseService",
  );
  const cuaManifest = readJsonFile(path.join(cuaRoot, "manifest.json"));
  const pluginManifest = readJsonFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const chromePluginManifest = readJsonFile(
    path.join(chromePluginRoot, ".codex-plugin", "plugin.json"),
  );
  const chromeFamilyDescriptor = readJsonFile(
    path.join(chromePluginRoot, "scripts", "extension-ids.json"),
  );
  const extensionIds = [
    ...new Set(
      (Array.isArray(chromeFamilyDescriptor.browserExtensions)
        ? chromeFamilyDescriptor.browserExtensions
        : []
      ).flatMap((entry) =>
        typeof entry === "object" && entry !== null && Array.isArray(entry.extensionIds)
          ? entry.extensionIds.filter((extensionId: unknown): extensionId is string =>
              /^[a-p]{32}$/u.test(String(extensionId)),
            )
          : [],
      ),
    ),
  ];
  if (extensionIds.length === 0) throw new Error("Chrome plugin has no attested extension IDs");

  for (const binaryPath of [codexPath, nodePath, nodeReplPath, peerAddonPath, skyAddonPath]) {
    assertArchitecture(binaryPath, options.targetArch);
  }
  assertArchitecture(chromeNativeHostPath, options.targetArch);
  if (computerUseAvailable) assertArchitecture(computerUseServicePath, options.targetArch);
  if (
    computerUseAvailable &&
    !fs.existsSync(path.join(computerUsePluginRoot, ...computerUseClientRelativePath.split("/")))
  ) {
    throw new Error(
      `Computer Use plugin is missing its launcher: ${computerUseClientRelativePath}`,
    );
  }
  assertPeerAddonLoads(nodePath, peerAddonPath);
  const skyNativeExports = readSkyNativeExports(nodePath, skyAddonPath);
  const chromeNativeHostMinimumMacos = readMachOMinimumMacosVersion(
    chromeNativeHostPath,
    options.targetArch,
  );

  const outputPath = path.resolve(options.outputPath);
  const desktopBuild = readPlistValue(plistPath, "CFBundleShortVersionString");
  const desktopBuildNumber = readPlistValue(plistPath, "CFBundleVersion");
  const pluginVersion = readNonEmptyString(pluginManifest.version, "Browser plugin version");
  const peerSigningTeamId = readSigningTeamId(peerAddonPath);
  const runtimeVersions: BrowserRuntimeManifest["runtimeVersions"] = {
    codexCli: readExecutableVersion(codexPath),
    cuaRuntime: readCuaRuntimeVersion(cuaManifest),
    node: readExecutableVersion(nodePath),
    peerAuthorization: `sha256:${readSha256(peerAddonPath)}`,
  };
  if (options.reuseExisting) {
    let existing: BrowserRuntimeManifest | null = null;
    try {
      const stats = fs.lstatSync(outputPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        existing = parseBrowserRuntimeManifest(
          JSON.parse(
            fs.readFileSync(path.join(outputPath, BROWSER_RUNTIME_MANIFEST_FILENAME), "utf8"),
          ),
        );
      }
    } catch {
      existing = null;
    }
    if (
      existing &&
      existing.codexCompatibilityVersion === options.codexCompatibilityVersion &&
      existing.desktopBuild === desktopBuild &&
      existing.desktopBuildNumber === desktopBuildNumber &&
      existing.browserPlugin.version === pluginVersion &&
      existing.capabilities.browserUse.backends.chrome.status === "available" &&
      existing.capabilities.browserUse.backends.chrome.nativeHost.artifactMinimumMacOSVersion ===
        chromeNativeHostMinimumMacos &&
      JSON.stringify(existing.capabilities.nativePip.exports.expectedExports) ===
        JSON.stringify(skyNativeExports) &&
      existing.peerAuthorization.signingTeamId === peerSigningTeamId &&
      existing.targetArch === options.targetArch &&
      JSON.stringify(existing.runtimeVersions) === JSON.stringify(runtimeVersions)
    ) {
      return existing;
    }
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryParent = fs.mkdtempSync(
    path.join(path.dirname(outputPath), ".browser-runtime-prepare-"),
  );
  const preparedRoot = path.join(temporaryParent, path.basename(outputPath));
  fs.mkdirSync(preparedRoot);
  try {
    copyTree(codexPath, path.join(preparedRoot, "bin", "codex"));
    copyTree(nodePath, path.join(preparedRoot, "bin", "node"));
    copyTree(nodeReplPath, path.join(preparedRoot, "bin", "node_repl"));
    copyTree(
      peerAddonPath,
      path.join(preparedRoot, "native", "browser-use-peer-authorization.node"),
    );
    copyTree(skyAddonPath, path.join(preparedRoot, "native", "sky.node"));
    copyTree(remoteHostedPipAssetsPath, path.join(preparedRoot, "native", "remote-hosted-pip"));
    copyTree(pluginRoot, path.join(preparedRoot, "marketplace", "plugins", PLUGIN_NAME));
    copyTree(chromePluginRoot, path.join(preparedRoot, "marketplace", "plugins", "chrome"));
    for (const sharedEntrypoint of ["browser-client.mjs", "browser-service.mjs"]) {
      fs.rmSync(
        path.join(preparedRoot, "marketplace", "plugins", "chrome", "scripts", sharedEntrypoint),
        { force: true },
      );
    }
    if (computerUseAvailable) {
      copyTree(
        computerUsePluginRoot,
        path.join(preparedRoot, "marketplace", "plugins", "computer-use"),
      );
    }
    copyTree(
      path.join(cuaRoot, "lib", "node_modules"),
      path.join(preparedRoot, "runtime", "lib", "node_modules"),
    );
    pruneForeignNativeArtifacts(preparedRoot, options.targetArch);
    writeBrowserMarketplaceManifest(
      path.join(preparedRoot, "marketplace", ".agents", "plugins", "marketplace.json"),
      computerUseAvailable,
    );

    const artifacts = listArtifacts(preparedRoot, options.targetArch);
    const manifest: BrowserRuntimeManifest = {
      artifacts,
      browserPlugin: {
        client: "marketplace/plugins/browser/scripts/browser-client.mjs",
        docs: "marketplace/plugins/browser/skills/control-in-app-browser/SKILL.md",
        id: "browser@openai-bundled",
        manifest: "marketplace/plugins/browser/.codex-plugin/plugin.json",
        marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
        marketplaceRoot: "marketplace",
        nodeModuleDirs: browserPluginNodeModuleDirs(),
        root: "marketplace/plugins/browser",
        service: "marketplace/plugins/browser/scripts/browser-service.mjs",
        version: pluginVersion,
      },
      buildFlavor: "production",
      capabilities: {
        browserUse: {
          backends: {
            chrome: {
              extensionIds,
              familyDescriptor: "marketplace/plugins/chrome/scripts/extension-ids.json",
              installManifest: "marketplace/plugins/chrome/scripts/installManifest.mjs",
              nativeHost: {
                artifactMinimumMacOSVersion: chromeNativeHostMinimumMacos,
                hostName: "com.openai.codexextension",
                path: `marketplace/plugins/chrome/extension-host/macos/${options.targetArch}/ChatGPT for Chrome`,
                productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
                signingTeamId: readSigningTeamId(chromeNativeHostPath),
              },
              plugin: {
                id: "chrome@openai-bundled",
                manifest: "marketplace/plugins/chrome/.codex-plugin/plugin.json",
                root: "marketplace/plugins/chrome",
                version: readNonEmptyString(chromePluginManifest.version, "Chrome plugin version"),
              },
              status: "available",
            },
            iab: { status: "available" },
          },
        },
        computerUse: computerUseAvailable
          ? {
              appBundle: "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app",
              appBundleIdentifier: readPlistValue(
                path.join(computerUseAppPath, "Contents", "Info.plist"),
                "CFBundleIdentifier",
              ),
              artifactMinimumMacOSVersion: "14.4",
              client: `marketplace/plugins/computer-use/${computerUseClientRelativePath}`,
              ipcProtocol: "CodexComputerUseIPC-5",
              plugin: {
                docs: "marketplace/plugins/computer-use/skills/computer-use/SKILL.md",
                id: "computer-use@openai-bundled",
                manifest: "marketplace/plugins/computer-use/.codex-plugin/plugin.json",
                marketplaceManifest: "marketplace/.agents/plugins/marketplace.json",
                marketplaceRoot: "marketplace",
                nodeModuleDirs: ["runtime/lib/node_modules"],
                root: "marketplace/plugins/computer-use",
                version: readNonEmptyString(
                  readJsonFile(path.join(computerUsePluginRoot, ".codex-plugin", "plugin.json"))
                    .version,
                  "Computer Use plugin version",
                ),
              },
              productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
              rpcService:
                "runtime/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js",
              serviceExecutable:
                "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
              signingTeamId: readSigningTeamId(computerUseServicePath),
              status: "available",
            }
          : {
              reason: "architecture-unsupported",
              status: "unavailable",
            },
        nativePip: {
          addon: "native/sky.node",
          artifactMinimumMacOSVersion: "13.0",
          controlAssets: [
            "native/remote-hosted-pip/pop-in-window-egg@3x.png",
            "native/remote-hosted-pip/pop-out-window-egg@3x.png",
          ],
          exports: {
            expectedExportCount: skyNativeExports.length,
            expectedExports: skyNativeExports,
            groups: BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS,
          },
          productMinimumMacOSVersion: BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION,
          status: "available",
        },
      },
      codexCompatibilityVersion: options.codexCompatibilityVersion,
      desktopBuild,
      desktopBuildNumber,
      entrypoints: {
        codexCli: "bin/codex",
        node: "bin/node",
        nodeRepl: "bin/node_repl",
        peerAuthorization: "native/browser-use-peer-authorization.node",
      },
      peerAuthorization: {
        nodeApiVersion: readNodeApiVersion(nodePath),
        signingTeamId: peerSigningTeamId,
      },
      runtimeVersions,
      schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
      supportedBackends: ["iab", "chrome"],
      targetArch: options.targetArch,
      targetPlatform: "darwin",
    };
    fs.writeFileSync(
      path.join(preparedRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: REGULAR_MODE },
    );
    replaceOwnedDirectory(preparedRoot, outputPath);
    return manifest;
  } finally {
    fs.rmSync(temporaryParent, { force: true, recursive: true });
  }
}

function parseCliOptions(argv: string[]): VendorBrowserRuntimeOptions {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  let reuseExisting = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--reuse-existing") {
      reuseExisting = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Browser runtime preparation arguments must be --key value pairs");
    }
    values.set(key, value);
    index += 1;
  }
  const codexCompatibilityVersion = values.get("--codex-compatibility-version");
  const appPath = values.get("--app");
  const outputPath = values.get("--out");
  const targetArch = values.get("--target-arch");
  if (
    !appPath ||
    !codexCompatibilityVersion ||
    !outputPath ||
    (targetArch !== "arm64" && targetArch !== "x64")
  ) {
    throw new Error(
      "Usage: vendor-browser-runtime.ts " +
        "--codex-compatibility-version <version> --target-arch <arm64|x64> " +
        "--app <ChatGPT.app> --out <directory> [--reuse-existing]",
    );
  }
  return {
    appPath,
    codexCompatibilityVersion,
    outputPath,
    reuseExisting,
    targetArch,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = vendorBrowserRuntime(parseCliOptions(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({
        artifacts: manifest.artifacts.length,
        desktopBuild: manifest.desktopBuild,
        pluginVersion: manifest.browserPlugin.version,
        runtimeVersions: manifest.runtimeVersions,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
