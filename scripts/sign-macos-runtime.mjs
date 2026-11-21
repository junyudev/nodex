// Keep exported API changes paired with the adjacent .d.mts contract.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agentRuntimeNativeDigest } from "./agent-runtime-native-inventory.mjs";
import { sign as signApp } from "@electron/osx-sign";
import {
  assertMacCodexDetached,
  assertMacDesktopToolsDetached,
} from "./desktop-runtime-payload.mjs";
import {
  assertMacNodeRuntime,
  assertMacNodeDeveloperId,
  macNodeRuntimeExecutable,
} from "./macos-node-runtime.mjs";
import { assertRipgrepRuntimePayload } from "./ripgrep-runtime-payload.mjs";
import { writePackagedBuildProvenance } from "./package-provenance.mjs";

const nativeManifestRelativePath = "Contents/Resources/bin/rust-core-runtime.json";
const sparkleManifestRelativePath = "Contents/Resources/native/sparkle-runtime.json";
const sparkleOwnedRelativePaths = [
  "Contents/Resources/native/nodex-sparkle.node",
  "Contents/Frameworks/Sparkle.framework",
];
const sparkleCodeObjectRelativePaths = [
  "Contents/Resources/native/nodex-sparkle.node",
  "Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate",
  "Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app",
  "Contents/Frameworks/Sparkle.framework",
];
const expectedBinaryPaths = new Map([
  ["nodex", "Resources/bin/nodex"],
  ["nodex-appshot-helper", "Resources/bin/nodex-appshot-helper"],
  ["nodex-dictation-helper", "Resources/bin/nodex-dictation-helper"],
  ["nodex-browser-profile-helper", "Resources/bin/nodex-browser-profile-helper"],
  ["nodex-core", "Resources/bin/nodex-core"],
  ["nodex-service", "Helpers/Nodex Service.app/Contents/MacOS/nodex-service"],
]);

const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

const writeManifestAtomically = (manifestPath, manifest) => {
  const temporaryPath = `${manifestPath}.signed-runtime.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  renameSync(temporaryPath, manifestPath);
};

const isInside = (parentPath, candidatePath) => {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const matchesIgnore = (ignore, filePath) => {
  if (!ignore) return false;
  if (typeof ignore === "function") return ignore(filePath);
  const patterns = Array.isArray(ignore) ? ignore : [ignore];
  return patterns.some((pattern) => new RegExp(pattern).test(filePath));
};

const isSparkleOwnedCode = (appPath, filePath) =>
  sparkleOwnedRelativePaths.some((relativePath) =>
    isInside(path.join(appPath, relativePath), filePath),
  );

export const isPreservedNodeRuntimeVendorCode = (appPath, filePath) =>
  path.resolve(filePath) === path.resolve(appPath, "Contents/Resources", macNodeRuntimeExecutable);

export const sparkleCodeSignArguments = ({ identity, keychain, local, targetPath }) => [
  "--force",
  "--sign",
  identity,
  "--options",
  "runtime",
  local ? "--timestamp=none" : "--timestamp",
  ...(keychain ? ["--keychain", keychain] : []),
  targetPath,
];

const signSparkleCodeObjects = (options) => {
  if (!options.identity) {
    throw new Error("Sparkle code signing requires a resolved signing identity");
  }
  for (const relativePath of sparkleCodeObjectRelativePaths) {
    const targetPath = path.join(options.app, relativePath);
    const result = spawnSync(
      "/usr/bin/codesign",
      sparkleCodeSignArguments({
        identity: options.identity,
        keychain: options.keychain,
        local: process.env.NODEX_MAC_SIGN_MODE === "local",
        targetPath,
      }),
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not sign Sparkle code object ${relativePath}: ` +
          `${result.error?.message ?? result.stderr ?? result.stdout}`,
      );
    }
  }
};

const requireSparkleArtifactPath = (entry, expectedPath, manifestPath) => {
  if (
    !entry ||
    entry.path !== expectedPath ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0
  ) {
    throw new Error(`Invalid Sparkle runtime artifact in ${manifestPath}: ${expectedPath}`);
  }
};

export const refreshSignedSparkleRuntimeManifest = (appPath) => {
  const manifestPath = path.join(appPath, sparkleManifestRelativePath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedArtifacts = {
    autoupdate: "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
    bridge: "Resources/native/nodex-sparkle.node",
    frameworkExecutable: "Frameworks/Sparkle.framework/Versions/B/Sparkle",
    frameworkInfoPlist: "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
    updater: "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
  };
  if (manifest.schemaVersion !== 3 || !manifest.artifacts) {
    throw new Error(`Unsupported Sparkle runtime manifest: ${manifestPath}`);
  }
  const artifacts = Object.fromEntries(
    Object.entries(expectedArtifacts).map(([name, relativePath]) => {
      requireSparkleArtifactPath(manifest.artifacts[name], relativePath, manifestPath);
      const filePath = path.join(appPath, "Contents", relativePath);
      const metadata = lstatSync(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Sparkle runtime artifact is not a regular file: ${filePath}`);
      }
      return [
        name,
        {
          path: relativePath,
          sha256: sha256File(filePath),
          size: metadata.size,
        },
      ];
    }),
  );
  writeManifestAtomically(manifestPath, { ...manifest, artifacts });
};

const refreshSignedNativeRuntimeManifest = (appPath) => {
  const manifestPath = path.join(appPath, nativeManifestRelativePath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.schemaVersion !== 4 || !Array.isArray(manifest.binaries)) {
    throw new Error(`Unsupported native runtime manifest: ${manifestPath}`);
  }
  if (manifest.binaries.length !== expectedBinaryPaths.size) {
    throw new Error(`Native runtime manifest is not closed: ${manifestPath}`);
  }

  const seenNames = new Set();
  const binaries = manifest.binaries.map((entry) => {
    const expectedPath = expectedBinaryPaths.get(entry.name);
    if (!expectedPath || entry.bundlePath !== expectedPath || seenNames.has(entry.name)) {
      throw new Error(`Unexpected native runtime entry: ${JSON.stringify(entry)}`);
    }
    seenNames.add(entry.name);

    const binaryPath = path.join(appPath, "Contents", expectedPath);
    const metadata = lstatSync(binaryPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error(`Native runtime entry is not a regular executable: ${binaryPath}`);
    }

    return {
      ...entry,
      sourceSha256: sha256File(binaryPath),
      sourceSize: statSync(binaryPath).size,
    };
  });

  if (seenNames.size !== expectedBinaryPaths.size) {
    throw new Error(`Native runtime manifest is missing an expected binary: ${manifestPath}`);
  }

  writeManifestAtomically(manifestPath, { ...manifest, binaries });
};

const signWithRetry = async (options) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await signApp(options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
    }
  }
  throw lastError;
};

/**
 * `NODEX_MAC_SIGN_MODE=local` keeps the resolved Developer ID identity — so
 * Keychain ACLs, TCC grants, and launchd registrations stay stable across
 * reinstalls — but disables the Apple timestamp service. One TSA network round
 * trip per Mach-O is what turns a full deep sign into minutes, and local test
 * installs are never notarized, so secure timestamps buy nothing there.
 */
export const applyMacSigningMode = (options, mode = process.env.NODEX_MAC_SIGN_MODE) => {
  if (!mode) return options;
  if (mode !== "local") {
    throw new Error(`Unknown NODEX_MAC_SIGN_MODE: ${mode}`);
  }
  const baseOptionsForFile = options.optionsForFile;
  return {
    ...options,
    optionsForFile: (filePath, context) => ({
      ...(baseOptionsForFile ? baseOptionsForFile(filePath, context) : {}),
      timestamp: "none",
    }),
  };
};

const isElectronRuntimeCodeObject = (appPath, filePath) => {
  const productName = path.basename(appPath, ".app");
  if (filePath === appPath) return true;
  if (filePath === path.join(appPath, "Contents", "MacOS", productName)) return true;
  if (
    isInside(path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework"), filePath)
  ) {
    return true;
  }
  return [
    `${productName} Helper.app`,
    `${productName} Helper (GPU).app`,
    `${productName} Helper (Plugin).app`,
    `${productName} Helper (Renderer).app`,
  ].some((helperName) =>
    isInside(path.join(appPath, "Contents", "Frameworks", helperName), filePath),
  );
};

/** Prevents native tools and helpers from inheriting Electron's JIT/dyld capabilities. */
export const applyMacCodeObjectEntitlementPolicy = (options) => {
  const baseOptionsForFile = options.optionsForFile;
  return {
    ...options,
    optionsForFile: (filePath, context) => {
      const baseOptions = baseOptionsForFile ? baseOptionsForFile(filePath, context) : {};
      if (isElectronRuntimeCodeObject(options.app, filePath)) return baseOptions;
      return { ...baseOptions, entitlements: [] };
    },
  };
};

/** Reseal Nodex-built PTY objects after codesigning without changing vendor manifests. */
export const refreshSignedAgentRuntimeNativeManifest = (appPath) => {
  const executionRoot = path.join(appPath, "Contents/Resources/agent-runtime");
  const executionManifestPath = path.join(executionRoot, "native-dependencies.json");
  const executionManifest = JSON.parse(readFileSync(executionManifestPath, "utf8"));
  executionManifest.unsignedArtifactDigest ??= executionManifest.artifactDigest;
  executionManifest.artifactDigest = agentRuntimeNativeDigest(
    path.join(executionRoot, "node_modules/node-pty"),
  );
  writeManifestAtomically(executionManifestPath, executionManifest);
};

export const sign = async (options) => {
  const signOptions = applyMacCodeObjectEntitlementPolicy(applyMacSigningMode(options));
  if (signOptions.platform !== "darwin") {
    await signWithRetry(signOptions);
    return;
  }

  const resources = path.join(signOptions.app, "Contents/Resources");
  assertMacDesktopToolsDetached(resources);
  assertMacCodexDetached(resources);
  const node = assertMacNodeRuntime(resources);
  assertMacNodeDeveloperId(node);
  const ripgrepRoot = path.join(resources, "ripgrep-runtime");
  assertRipgrepRuntimePayload(ripgrepRoot, "darwin-arm64", { allowSigned: true });

  signSparkleCodeObjects(signOptions);
  const baseIgnore = signOptions.ignore;
  await signWithRetry({
    ...signOptions,
    ignore: (filePath) =>
      isSparkleOwnedCode(signOptions.app, filePath) ||
      isPreservedNodeRuntimeVendorCode(signOptions.app, filePath) ||
      matchesIgnore(baseIgnore, filePath),
  });

  // The macOS binaries list includes ripgrep, so osx-sign applies the app identity.
  assertRipgrepRuntimePayload(ripgrepRoot, "darwin-arm64", { allowSigned: true });
  refreshSignedAgentRuntimeNativeManifest(signOptions.app);
  refreshSignedNativeRuntimeManifest(signOptions.app);
  refreshSignedSparkleRuntimeManifest(signOptions.app);
  writePackagedBuildProvenance(signOptions.app);

  await signWithRetry({
    ...signOptions,
    binaries: [],
    ignore: (filePath) => filePath !== signOptions.app,
  });
  assertMacNodeRuntime(resources);
};
