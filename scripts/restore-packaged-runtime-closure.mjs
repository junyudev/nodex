// Keep exported API changes paired with the adjacent .d.mts contract.
import { readFileSync } from "node:fs";
import path from "node:path";

import { stageWindowsCodexCrt } from "./windows-codex-crt.mjs";
import { stageWindowsVcRuntime } from "./windows-vc-runtime.mjs";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

import { assertMacNodeRuntime } from "./macos-node-runtime.mjs";
import {
  assertMacDocumentToolsDetached,
  assertMacInstalledPayloadBudget,
} from "./installed-payload.mjs";
import { assertDesktopRuntimePayload } from "./desktop-runtime-payload.mjs";
import { assertPackagedAppArchive } from "./packaged-app-archive.mjs";
export default async function restorePackagedRuntimeClosure(context) {
  if (!["darwin", "win32"].includes(context.electronPlatformName)) return;
  const projectRoot = context.packager.projectDir;
  const appPath =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir;
  const resourcesPath =
    context.electronPlatformName === "darwin"
      ? path.join(appPath, "Contents/Resources")
      : path.join(appPath, "resources");
  assertPackagedAppArchive(path.join(resourcesPath, "app.asar"));
  if (
    !readFileSync(path.join(resourcesPath, "prepared-electron-build.json")).equals(
      readFileSync(path.join(projectRoot, ".generated/prepared-electron-build.json")),
    )
  )
    throw new Error("Packaged prepared manifest differs from the verified build");
  // electron-builder Arch: x64=1, arm64=3. Reject every other desktop target.
  const arch =
    context.arch === 3
      ? "arm64"
      : context.electronPlatformName === "win32" && context.arch === 1
        ? "x64"
        : null;
  if (!arch) throw new Error(`Unsupported desktop package architecture: ${context.arch}`);
  if (context.electronPlatformName === "win32") stageWindowsCodexCrt(resourcesPath, arch);
  assertDesktopRuntimePayload({
    sourceRoot: projectRoot,
    resourcesPath,
    platform: context.electronPlatformName,
    arch,
  });
  if (context.electronPlatformName === "win32") {
    stageWindowsVcRuntime(appPath, arch);
    const files = verifyWindowsArchitectureClosure(appPath, arch, {
      nodeHost: path.join(appPath, "Nodex.exe"),
    });
    console.log(`Verified ${files.length} Windows ${arch} native images.`);
    return;
  }
  assertMacDocumentToolsDetached(resourcesPath);
  assertMacNodeRuntime(resourcesPath);
  const inventory = assertMacInstalledPayloadBudget(appPath);
  console.log(
    `Installed macOS payload: ${inventory.bytes} bytes across ${inventory.fileCount} files.`,
  );
}
