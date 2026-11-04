// Keep this Node-only boundary available to afterPack and installed-app probes.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { assertPackagedAgentRuntimeNative } from "./agent-runtime-native-inventory.mjs";
import { assertPackagedAppArchive, readAppArchiveFilePaths } from "./packaged-app-archive.mjs";

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

/** Reject duplicate SDKs, foreign platform packages and redundant native/debug payload. */
export function assertDesktopRuntimePayload({ resourcesPath, platform, arch, sourceRoot }) {
  assertDetachedRuntimeResources(resourcesPath);
  const dependencyRoot = "agent-runtime/node_modules";
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const executable = `${dependencyRoot}/${platformPackage}/${platform === "win32" ? "claude.exe" : "claude"}`;
  const expected = executable;
  const physical = readdirSync(resourcesPath, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      relative(resourcesPath, join(entry.parentPath, entry.name)).split("\\").join("/"),
    );
  const archived = readAppArchiveFilePaths(join(resourcesPath, "app.asar"));
  const claudeExecutables = [
    ...physical.filter((file) => /(?:^|\/)claude(?:\.exe)?$/iu.test(file)),
    ...archived
      .filter((file) => /(?:^|\/)claude(?:\.exe)?$/iu.test(file))
      .map((file) => `app.asar/${file}`),
  ];
  // The standalone dependency is copied with extraResources, outside the ASAR file table.
  if (claudeExecutables.length !== 1 || claudeExecutables[0] !== expected)
    throw new Error(
      `Desktop must ship exactly one Claude executable at ${expected}; found: ${claudeExecutables.join(", ")}`,
    );
  if (
    !lstatSync(join(resourcesPath, expected)).isFile() ||
    lstatSync(join(resourcesPath, expected)).isSymbolicLink()
  )
    throw new Error("Packaged Claude executable must be a regular file");

  const unpacked = physical
    .filter((file) => file.startsWith("app.asar.unpacked/"))
    .map((file) => file.slice("app.asar.unpacked/".length));
  for (const file of [
    ...unpacked,
    ...archived,
    ...physical.filter(
      (file) => file.startsWith("agent-runtime/") || file.startsWith("app-tools/"),
    ),
  ]) {
    const ptyBuildPath = /(?:^|\/)node_modules\/node-pty\/build\/(.*)/u.exec(file)?.[1];
    const platformMatch = /(?:^|\/)node_modules\/(@anthropic-ai\/claude-agent-sdk-[^/]+)\//u.exec(
      file,
    );
    if (
      platformMatch &&
      (!file.startsWith(`${dependencyRoot}/`) || platformMatch[1] !== platformPackage)
    )
      throw new Error(`Unexpected Claude platform package: ${file}`);
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
  if (sourceRoot)
    assertPackagedAgentRuntimeNative({
      sourceRoot: join(sourceRoot, "out", dependencyRoot),
      packagedRoot: join(resourcesPath, dependencyRoot),
    });
  return join(resourcesPath, expected);
}
