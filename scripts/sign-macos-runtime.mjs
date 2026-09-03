import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { signAsync } from "@electron/osx-sign";
import { writePackagedBuildProvenance } from "./package-provenance.mjs";

const nativeManifestRelativePath = "Contents/Resources/bin/rust-core-runtime.json";
const browserManifestRelativePath =
  "Contents/Resources/browser-runtime/browser-runtime-manifest.json";
const sparkleManifestRelativePath = "Contents/Resources/native/sparkle-runtime.json";
const sparkleOwnedRelativePaths = [
  "Contents/Resources/native/nodex-sparkle.node",
  "Contents/Frameworks/Sparkle.framework",
];
const browserRuntimeVendorRelativePath = path.join("Contents", "Resources", "browser-runtime");
const codexRuntimeVendorRelativePaths = [
  "Contents/Resources/bin/codex-app-server",
  "Contents/Resources/bin/codex-code-mode-host",
  "Contents/Resources/codex-path/rg",
  "Contents/Resources/codex-resources/zsh/bin/zsh",
];
const sparkleCodeObjectRelativePaths = [
  "Contents/Resources/native/nodex-sparkle.node",
  "Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate",
  "Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app",
  "Contents/Frameworks/Sparkle.framework",
];
// Keep this release boundary exact. The signing tests construct their fixture from the canonical
// TypeScript manifest version, so any future schema bump fails closed until resealing is audited.
const browserRuntimeSchemaVersion = 6;
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

export const isPreservedBrowserRuntimeVendorCode = (appPath, filePath) =>
  isInside(path.join(appPath, browserRuntimeVendorRelativePath), filePath);

export const isPreservedCodexRuntimeVendorCode = (appPath, filePath) =>
  codexRuntimeVendorRelativePaths.some(
    (relativePath) => path.resolve(filePath) === path.resolve(appPath, relativePath),
  );

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

const requireSafeAgentArtifactPath = (artifactPath, manifestPath) => {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.length === 0 ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid Agent runtime artifact path in ${manifestPath}`);
  }
  return artifactPath;
};

const readMacosTeamIdentifier = (artifactPath) => {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", artifactPath], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not inspect Browser runtime signature: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Could not inspect Browser runtime signature: ${output.trim()}`);
  }
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error("Browser runtime peer authorization has no Developer ID team");
  }
  return teamIdentifier;
};

export const refreshSignedBrowserRuntimeManifest = (appPath, options = {}) => {
  const manifestPath = path.join(appPath, browserManifestRelativePath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  if (
    manifest.schemaVersion !== browserRuntimeSchemaVersion ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error(`Unsupported Browser runtime manifest: ${manifestPath}`);
  }

  const seenPaths = new Set();
  const artifacts = manifest.artifacts.map((entry) => {
    const artifactPath = requireSafeAgentArtifactPath(entry.path, manifestPath);
    if (
      seenPaths.has(artifactPath) ||
      typeof entry.executable !== "boolean" ||
      !["data", "executable", "native-addon"].includes(entry.kind)
    ) {
      throw new Error(`Invalid Browser runtime artifact entry in ${manifestPath}`);
    }
    seenPaths.add(artifactPath);

    const bundledPath = path.join(
      appPath,
      "Contents",
      "Resources",
      "browser-runtime",
      ...artifactPath.split("/"),
    );
    const metadata = lstatSync(bundledPath);
    const executable = (metadata.mode & 0o111) !== 0;
    if (metadata.isSymbolicLink() || !metadata.isFile() || executable !== entry.executable) {
      throw new Error(`Browser runtime entry is not a regular artifact: ${bundledPath}`);
    }
    return {
      ...entry,
      sha256: sha256File(bundledPath),
      size: metadata.size,
    };
  });

  const peerAuthorizationPath = requireSafeAgentArtifactPath(
    manifest.entrypoints?.peerAuthorization,
    manifestPath,
  );
  const peerAuthorization = artifacts.find((artifact) => artifact.path === peerAuthorizationPath);
  if (
    !peerAuthorization ||
    peerAuthorization.kind !== "native-addon" ||
    !manifest.peerAuthorization
  ) {
    throw new Error(`Browser runtime peer authorization is invalid: ${manifestPath}`);
  }
  const bundledPeerAuthorizationPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "browser-runtime",
    ...peerAuthorizationPath.split("/"),
  );
  const signingTeamId = (options.readSigningTeamIdentifier ?? readMacosTeamIdentifier)(
    bundledPeerAuthorizationPath,
  );

  let capabilities = manifest.capabilities;
  if (capabilities?.computerUse?.status === "available") {
    const serviceExecutablePath = requireSafeAgentArtifactPath(
      capabilities.computerUse.serviceExecutable,
      manifestPath,
    );
    const bundledServiceExecutablePath = path.join(
      appPath,
      "Contents",
      "Resources",
      "browser-runtime",
      ...serviceExecutablePath.split("/"),
    );
    capabilities = {
      ...capabilities,
      computerUse: {
        ...capabilities.computerUse,
        signingTeamId: (
          options.readComputerUseSigningTeamIdentifier ??
          options.readSigningTeamIdentifier ??
          readMacosTeamIdentifier
        )(bundledServiceExecutablePath),
      },
    };
  }

  writeManifestAtomically(manifestPath, {
    ...manifest,
    artifacts,
    capabilities,
    peerAuthorization: {
      ...manifest.peerAuthorization,
      signingTeamId,
    },
  });
  return true;
};

const signWithRetry = async (options) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await signAsync(options);
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
    optionsForFile: (filePath) => ({
      ...(baseOptionsForFile ? baseOptionsForFile(filePath) : {}),
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
    optionsForFile: (filePath) => {
      const baseOptions = baseOptionsForFile ? baseOptionsForFile(filePath) : {};
      if (isElectronRuntimeCodeObject(options.app, filePath)) return baseOptions;
      return { ...baseOptions, entitlements: [] };
    },
  };
};

export const sign = async (options) => {
  const signOptions = applyMacCodeObjectEntitlementPolicy(applyMacSigningMode(options));
  if (signOptions.platform !== "darwin") {
    await signWithRetry(signOptions);
    return;
  }

  signSparkleCodeObjects(signOptions);
  const baseIgnore = signOptions.ignore;
  await signWithRetry({
    ...signOptions,
    ignore: (filePath) =>
      isSparkleOwnedCode(signOptions.app, filePath) ||
      isPreservedBrowserRuntimeVendorCode(signOptions.app, filePath) ||
      isPreservedCodexRuntimeVendorCode(signOptions.app, filePath) ||
      matchesIgnore(baseIgnore, filePath),
  });

  refreshSignedNativeRuntimeManifest(signOptions.app);
  refreshSignedBrowserRuntimeManifest(signOptions.app);
  refreshSignedSparkleRuntimeManifest(signOptions.app);
  writePackagedBuildProvenance(signOptions.app);

  await signWithRetry({
    ...signOptions,
    binaries: [],
    ignore: (filePath) => filePath !== signOptions.app,
  });
};
