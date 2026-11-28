// Keep this Node-only boundary available to afterPack and installed-app probes.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { assertPackagedAgentRuntimeNative } from "./agent-runtime-native-inventory.mjs";
import { assertPackagedAppArchive, readAppArchiveFilePaths } from "./packaged-app-archive.mjs";

import { assertWindowsCodexCrt } from "./windows-codex-crt.mjs";
import { assertRipgrepRuntimePayload } from "./ripgrep-runtime-payload.mjs";

/** Detached stock-Node entrypoints must match the exact prepared output. */
export function assertDetachedRuntimeResources(resourcesPath) {
  assertPackagedAppArchive(join(resourcesPath, "app.asar"));
  for (const obsolete of [
    "app.asar.unpacked/out/agent-runtime",
    "app.asar.unpacked/out/main/app-tools",
    "app.asar.unpacked/agent-runtime",
    "app.asar.unpacked/app-tools",
  ]) {
    if (existsSync(join(resourcesPath, obsolete)))
      throw new Error(`Stock Node programs must be detached from ASAR: ${obsolete}`);
  }
  const prepared = JSON.parse(
    readFileSync(join(resourcesPath, "prepared-electron-build.json"), "utf8"),
  );
  for (const [source, destination] of [
    ["out/agent-runtime/entry.mjs", "agent-runtime/entry.mjs"],
    ["out/main/app-tools/server.mjs", "app-tools/server.mjs"],
  ]) {
    const recorded = prepared.outputs?.find((file) => file.path === source);
    const filePath = join(resourcesPath, destination);
    const metadata = lstatSync(filePath);
    if (
      !recorded ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size !== recorded.size ||
      createHash("sha256").update(readFileSync(filePath)).digest("hex") !== recorded.sha256
    )
      throw new Error(
        `Detached runtime entrypoint differs from the prepared build: ${destination}`,
      );
  }
}

export function assertMacDesktopToolsDetached(resourcesPath) {
  const browserRoot = join(resourcesPath, "browser-runtime");
  if (lstatSync(browserRoot, { throwIfNoEntry: false }))
    throw new Error("macOS app must install Desktop Tools as a Component");
}

const codexPackagePath =
  /(?:^|\/)(?:bin\/codex(?:-[^/]+)?(?:\.exe)?|codex-path|codex-resources|codex-package\.json|agent-runtime\.json)(?:\/|$)/iu;
const claudePackagePath =
  /(?:^|\/)(?:@anthropic-ai\/claude-agent-sdk-[^/]+|claude(?:\.exe)?)(?:\/|$)/iu;
const windowsDesktopToolsPath = /(?:^|\/)browser-runtime(?:\/|$)/iu;

const resourcePathFor = (resourcesPath, entry) =>
  relative(resourcesPath, join(entry.parentPath, entry.name)).split("\\").join("/");
const resourcesInventory = (resourcesPath) =>
  readdirSync(resourcesPath, { recursive: true, withFileTypes: true });

function assertComponentDetached(physical, archived, pattern, name, platform) {
  const archivePath = archived.find((file) => pattern.test(file));
  const bundled =
    physical.find((file) => pattern.test(file)) ??
    (archivePath ? `app.asar/${archivePath}` : undefined);
  if (bundled)
    throw new Error(`${platform} app must install ${name} as a Component; found: ${bundled}`);
}

export function assertMacCodexDetached(resourcesPath) {
  assertComponentDetached(
    resourcesInventory(resourcesPath).map((entry) => resourcePathFor(resourcesPath, entry)),
    readAppArchiveFilePaths(join(resourcesPath, "app.asar")),
    codexPackagePath,
    "Codex",
    "macOS",
  );
}

/** Check the packaged boundary, including ASAR and its unpacked companion. */
export function assertDesktopRuntimePayload({ resourcesPath, platform, arch, sourceRoot }) {
  assertDetachedRuntimeResources(resourcesPath);
  const dependencyRoot = "agent-runtime/node_modules";
  const inventory = resourcesInventory(resourcesPath);
  const physical = inventory.map((entry) => resourcePathFor(resourcesPath, entry));
  const archived = readAppArchiveFilePaths(join(resourcesPath, "app.asar"));
  const platformName = platform === "win32" ? "Windows" : "macOS";
  assertComponentDetached(physical, archived, codexPackagePath, "Codex", platformName);
  assertComponentDetached(physical, archived, claudePackagePath, "Claude Code", platformName);
  if (platform === "win32") {
    assertComponentDetached(
      physical,
      archived,
      windowsDesktopToolsPath,
      "Desktop Tools",
      platformName,
    );
    assertWindowsCodexCrt(resourcesPath);
    for (const notice of ["LICENSE", "NOTICE"]) {
      const stat = lstatSync(join(resourcesPath, "third-party/codex", notice));
      if (!stat.isFile() || stat.size === 0) throw new Error(`Packaged Codex ${notice} is missing`);
    }
  } else {
    assertMacDesktopToolsDetached(resourcesPath);
  }

  const files = inventory
    .filter((entry) => !entry.isDirectory())
    .map((entry) => resourcePathFor(resourcesPath, entry));
  const unpacked = files
    .filter((file) => file.startsWith("app.asar.unpacked/"))
    .map((file) => file.slice("app.asar.unpacked/".length));
  for (const file of [
    ...unpacked,
    ...archived,
    ...files.filter((file) => file.startsWith("agent-runtime/") || file.startsWith("app-tools/")),
  ]) {
    const ptyBuildPath = /(?:^|\/)node_modules\/node-pty\/build\/(.*)/u.exec(file)?.[1];
    if (
      /(?:^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk\//u.test(file) &&
      !file.startsWith(`${dependencyRoot}/`)
    )
      throw new Error(`Main must share the Agent Runtime SDK: ${file}`);
    if (
      /\.map$/u.test(file) ||
      /node_modules\/node-pty\/(?:prebuilds|bin|third_party)\//u.test(file) ||
      (ptyBuildPath &&
        (!ptyBuildPath.startsWith("Release/") || ptyBuildPath.startsWith("Release/obj"))) ||
      /node_modules\/node-pty\/.*\.(?:pdb|ipdb|iobj|obj|lib|exp)$/iu.test(file)
    )
      throw new Error(`Unused desktop runtime payload: ${file}`);
  }
  const ptyRoot = join(resourcesPath, "app.asar.unpacked/node_modules/node-pty/build/Release");
  for (const file of platform === "win32"
    ? ["pty.node", "conpty.node", "conpty_console_list.node"]
    : ["pty.node", "spawn-helper"]) {
    if (!existsSync(join(ptyRoot, file)))
      throw new Error(`Electron PTY runtime is missing: ${file}`);
  }
  assertRipgrepRuntimePayload(join(resourcesPath, "ripgrep-runtime"), `${platform}-${arch}`, {
    allowSigned: platform === "darwin",
  });
  if (sourceRoot)
    assertPackagedAgentRuntimeNative({
      sourceRoot: join(sourceRoot, "out", dependencyRoot),
      packagedRoot: join(resourcesPath, dependencyRoot),
    });
}
