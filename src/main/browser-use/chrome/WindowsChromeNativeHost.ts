import fs from "node:fs/promises";
import path from "node:path";
import type { PathSecurity } from "../../platform/node/WindowsDesktopTools";
import type { ChromeBrowserAuthority } from "./ChromeBrowserFamilyRegistry";
import {
  createChromeNativeHostManifest,
  createChromeNativeHostRegistryEntry,
  readAttestedFile,
  removeWindowsChromeNativeHostResources,
  writeAtomically,
  writeJsonAtomically,
  writeNativeHostRegistry,
  type ChromeNativeHostRuntimePaths,
} from "./ChromeNativeHostInstaller";

export interface WindowsChromeFileSecurity {
  readonly verify: (candidate: string) => Promise<void>;
  readonly ensureDirectory: (candidate: string) => Promise<void>;
}

export function windowsChromeFileSecurity(
  inspect: (candidate: string) => Promise<PathSecurity>,
): WindowsChromeFileSecurity {
  const verify = async (candidate: string) => {
    const security = await inspect(candidate);
    if (
      security.reparsePoint ||
      security.grantsForeignWrite ||
      security.ownerSid !== security.currentUserSid
    ) {
      throw new Error("Browser control files must belong to the current Windows user");
    }
  };
  return {
    verify,
    ensureDirectory: async (candidate) => {
      // Inspect the existing ancestor before creating any descendants.
      const missing: string[] = [];
      let current = candidate;
      for (;;) {
        try {
          if (!(await fs.lstat(current)).isDirectory())
            throw new Error("Expected a browser control directory");
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
          missing.push(current);
          current = path.dirname(current);
        }
      }
      await verify(current);
      for (const directory of missing.reverse()) {
        await fs.mkdir(directory, { recursive: true });
        await verify(directory);
      }
    },
  };
}

export interface WindowsChromeNativeHostOptions {
  readonly authority: ChromeBrowserAuthority;
  readonly channel: string;
  readonly expectedNativeHost: { readonly sha256: string; readonly size: number };
  readonly localAppData: string;
  readonly runtimeStateHome: string;
  readonly statePath: string;
  readonly runtimePaths: ChromeNativeHostRuntimePaths;
  readonly runtimeVersion: string;
  readonly security: WindowsChromeFileSecurity;
  /** PE machine, embedded signature and publisher policy from the verified closure. */
  readonly verifyPlatformArtifact: (candidate: string) => Promise<void>;
}

export function createWindowsChromeNativeHost(options: WindowsChromeNativeHostOptions) {
  const { expectedNativeHost, security } = options;
  const nativeHostPath = path.join(
    options.statePath,
    expectedNativeHost.sha256,
    "extension-host.exe",
  );
  const verify = async () => {
    await security.verify(nativeHostPath);
    await readAttestedFile(nativeHostPath, expectedNativeHost, false);
    await options.verifyPlatformArtifact(nativeHostPath);
  };

  const manifestContents = createChromeNativeHostManifest(options.authority, nativeHostPath);
  const registries = [
    path.join(options.localAppData, "OpenAI", "Codex", "chrome-native-hosts-v2.json"),
    path.join(options.runtimeStateHome, "chrome-native-hosts-v2.json"),
  ];
  const verifyRegistryIfPresent = async (registry: string): Promise<boolean> => {
    try {
      await fs.lstat(registry);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    await security.verify(registry);
    return true;
  };

  const checkInstallation = async (manifest: string) => {
    await security.verify(manifest);
    const stats = await fs.stat(manifest);
    if (
      !stats.isFile() ||
      stats.size > 16_384 ||
      JSON.stringify(JSON.parse(await fs.readFile(manifest, "utf8"))) !==
        JSON.stringify(manifestContents)
    ) {
      throw new Error("Browser control manifest needs repair");
    }
    await verify();
  };

  const install = async (manifest: string) => {
    const source = options.runtimePaths.nativeHostPath;
    const bytes = await readAttestedFile(source, expectedNativeHost, false);
    await options.verifyPlatformArtifact(source);
    await security.ensureDirectory(path.dirname(nativeHostPath));
    try {
      await verify();
    } catch {
      await writeAtomically(nativeHostPath, bytes, 0o700, true);
      await verify();
    }

    await security.ensureDirectory(path.dirname(manifest));
    await writeJsonAtomically(manifest, manifestContents, 0o600, true);
    await security.verify(manifest);
  };

  const publish = async () => {
    const entry = createChromeNativeHostRegistryEntry({ ...options, nativeHostPath });
    for (const registry of registries) {
      await security.ensureDirectory(path.dirname(registry));
      await verifyRegistryIfPresent(registry);
      await writeNativeHostRegistry(registry, entry, true);
      await security.verify(registry);
    }
  };

  const releaseResources = async () => {
    for (const registry of registries) {
      if (!(await verifyRegistryIfPresent(registry))) continue;
      await removeWindowsChromeNativeHostResources(
        registry,
        options.runtimeStateHome,
        options.authority.hostName,
      );
    }
  };

  return { nativeHostPath, install, publish, verify, checkInstallation, releaseResources };
}
