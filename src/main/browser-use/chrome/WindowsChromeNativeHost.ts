import fs from "node:fs/promises";
import path from "node:path";
import { hasTrustedWindowsOwner, type PathSecurity } from "../../platform/node/WindowsDesktopTools";
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
    if (security.reparsePoint || security.grantsForeignWrite || !hasTrustedWindowsOwner(security)) {
      throw new Error("Browser control files must belong to this Windows user or the system");
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

export const windowsChromeRegistryPaths = (localAppData: string, runtimeStateHome: string) => [
  path.join(localAppData, "OpenAI", "Codex", "chrome-native-hosts-v2.json"),
  path.join(runtimeStateHome, "chrome-native-hosts-v2.json"),
];

async function verifyRegistryIfPresent(registry: string, security: WindowsChromeFileSecurity) {
  const stats = await fs.lstat(registry).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return false;
  await security.verify(registry);
  return true;
}

/** Retire a Profile's advertisement using its registration journal, even without a bundle. */
export async function releaseWindowsChromeNativeHost(options: {
  readonly localAppData: string;
  readonly runtimeStateHome: string;
  readonly host: string;
  readonly security: WindowsChromeFileSecurity;
}) {
  for (const registry of windowsChromeRegistryPaths(
    options.localAppData,
    options.runtimeStateHome,
  )) {
    if (!(await verifyRegistryIfPresent(registry, options.security))) continue;
    await removeWindowsChromeNativeHostResources(registry, options.runtimeStateHome, options.host);
  }
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
  const registries = windowsChromeRegistryPaths(options.localAppData, options.runtimeStateHome);

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
      await verifyRegistryIfPresent(registry, security);
      await writeNativeHostRegistry(registry, entry, true);
      await security.verify(registry);
    }
  };

  return { nativeHostPath, install, publish, verify, checkInstallation };
}
