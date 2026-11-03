// Keep this Node-only boundary available to afterPack and installed-app probes.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { assertPackagedAgentRuntimeNative } from "./agent-runtime-native-inventory.mjs";
import { readAppArchiveFilePaths } from "./packaged-app-archive.mjs";

/** Reject duplicate SDKs, foreign platform packages and redundant native/debug payload. */
export function assertDesktopRuntimePayload({ resourcesPath, platform, arch, sourceRoot }) {
  const dependencyRoot = "out/agent-runtime/node_modules";
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const executable = `${dependencyRoot}/${platformPackage}/${platform === "win32" ? "claude.exe" : "claude"}`;
  const expected = `app.asar.unpacked/${executable}`;
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
  for (const file of [...unpacked, ...archived]) {
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
      sourceRoot: join(sourceRoot, dependencyRoot),
      packagedRoot: join(resourcesPath, "app.asar.unpacked", dependencyRoot),
    });
  return join(resourcesPath, expected);
}
